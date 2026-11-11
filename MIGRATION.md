# Database & Authentication Migration Guide

This document details the architectural migration of **Database** and **Authentication** systems in `cse-archive-server` (and its interactions with `ruet-cse-24` and `cse-archive-client`).

---

## 1. Executive Summary

| Component | Legacy Architecture | New Architecture (V1) | Status |
|---|---|---|---|
| **Primary Database** | Google Cloud Firestore (`ruet-cse-24`) | MongoDB Atlas (`CseArchive` / `ruetcse`) | Scripts ready; repo implemented; schema indexed |
| **Auth Identity** | Firebase Auth (Identity Toolkit) | Firebase Auth (Identity Toolkit) | Preserved (credentials are **not** stored in Mongo) |
| **Auth Sessions** | Client-side Firebase token & Next.js session cookies | Server-minted `__session` cookies (Firebase Admin SDK) + in-memory cache | Implemented in `src/v1/session.ts` |
| **Auth & Profile API**| Next.js Server Actions & Firestore directly in frontend | Centralized REST endpoints on Bun + Hono (`src/v1/routes/*`) | Implemented under `/api/v1` |
| **Rate Limiting** | Firestore document reads/writes & transaction timestamps | MongoDB TTL collection (`rateLimits`) | Implemented |
| **Drive Metadata** | Firebase Realtime Database (`drive/meta/*`) | Firebase Realtime Database (RTDB) | Retained as-is |

---

## 2. Architecture & Data Flow

```
                      +---------------------------------------+
                      |       Clients / Frontends             |
                      |  - ruet-cse-24 (rewrites /api/*)      |
                      |  - cse-archive-client (/api/auth)     |
                      +-------------------+-------------------+
                                          |
                                          | HTTP (Cookies / Bearer)
                                          v
                      +---------------------------------------+
                      |       cse-archive-server (Hono)       |
                      |                                       |
                      |  [/api/v1] User & Directory API       |
                      |    - /auth/* (signin, signup, claim)  |
                      |    - /me/*   (viewer, profile, contact|
                      |    - /profiles/* (public directory)   |
                      |                                       |
                      |  [/api/auth] Legacy Server-to-Server  |
                      |  [/api/drive] Google Drive Service    |
                      +-----------+---------------+-----------+
                                  |               |
                   Identity &     |               | Profile &
                   Session Mint   |               | Directory Data
                                  v               v
            +------------------------+      +------------------------+
            |  Firebase Identity     |      |     MongoDB Atlas      |
            |  Toolkit & Admin SDK   |      |                        |
            |  - Password verify     |      |  - profiles            |
            |  - OOB magic links     |      |  - privateContacts     |
            |  - Session cookies     |      |  - legacyProfiles      |
            |  - Google OAuth token  |      |  - rollIndex           |
            +------------------------+      |  - rateLimits (TTL)    |
                                            +------------------------+
```

---

## 3. Database Migration Details

### 3.1 Collections & Schema Mapping

| Firestore Source | MongoDB Target | Key / Indexes | Description |
|---|---|---|---|
| `profiles/{uid}` | `profiles` | `_id`: Firebase UID<br>`roll`: unique, sparse<br>`series`, `sec`<br>`published`, `series`<br>`nameLower` | Student profiles. Firestore `Timestamp` values are converted to native `Date`. `nameLower` is added for prefix search. |
| `profiles/{uid}/private/contact` *(subcollection)* | `privateContacts` | `_id`: Firebase UID | Private contact information (phone, address, blood group, guardian contacts, etc.) flattened into a standalone collection. |
| `legacyProfiles/{legacyId}` | `legacyProfiles` | `_id`: legacyId<br>`email`: unique, sparse | Pre-seeded accounts eligible for claiming. All emails normalized to lower-case. |
| `rollIndex/{roll}` | `rollIndex` | `_id`: roll number | Prevents duplicate roll registration and facilitates atomic roll assignment / reservation. |
| *(None / In-memory)* | `rateLimits` | `_id`: sha256(key)<br>`expireAt`: TTL index | Ephemeral collection with auto-expiring documents (`expireAfterSeconds: 0`) for rate-limiting (e.g. forgot password, claim links). |
| RTDB `drive/meta/*` | *(Unchanged)* | — | Drive change tokens and push notification watch channels stay on Firebase RTDB. |

### 3.2 Migration Scripts

The repository includes two utility scripts under `scripts/`:

1. **`scripts/migrate-firestore-to-mongo.ts`**:
   * Paginates Firestore collections in chunks of 500 (`orderBy("__name__")`).
   * Normalizes Firestore `Timestamp` instances to JavaScript `Date`.
   * Maps subcollections (`profiles/{uid}/private/contact`) to `privateContacts`.
   * Normalizes fields (e.g. `nameLower`, trimmed lowercase emails).
   * Executes MongoDB `bulkWrite` with `replaceOne` and `upsert: true`.
   * Supports dry-run execution:
     ```bash
     bun scripts/migrate-firestore-to-mongo.ts --dry-run
     bun scripts/migrate-firestore-to-mongo.ts
     ```

2. **`scripts/verify-migration.ts`**:
   * Validates document count equivalence between Firestore and MongoDB for `profiles`, `legacyProfiles`, and `rollIndex`.
   * Asserts uniqueness of roll numbers in MongoDB.
   * Checks that all `legacyProfiles` emails are lowercase.
   * Samples 50 profiles at random to perform deep field comparison against Firestore source.
   * Checks sampled UIDs against Firebase Auth using `auth.getUsers()`.
   * Run with:
     ```bash
     bun scripts/verify-migration.ts
     ```

---

## 4. Authentication Migration Details

### 4.1 Retaining Firebase Auth as Identity Provider

Passwords and user credentials are **never** stored or hashed in MongoDB. The server acts as a secure intermediary using Google's APIs:
* **Password Validation**: Delegated via HTTP `POST` to Google Identity Toolkit `accounts:signInWithPassword`.
* **Account Creation**: Handled via `accounts:signUp` with mandatory verification email triggered via `accounts:sendOobCode`.
* **Password Resets**: OOB codes sent via Identity Toolkit.
* **Claims Flow**: Seeded accounts marked with `mustRotate: true` (or legacy records in MongoDB) are claimed via email magic links (`accounts:signInWithEmailLink`).
* **Google OAuth**: Handled using PKCE flow (`accounts.google.com/o/oauth2/v2/auth` and token exchange).

### 4.2 Session Handling

* Minted using `adminAuth.createSessionCookie(idToken, { expiresIn: 5 * 24 * 60 * 60 * 1000 })`.
* Set as an `HttpOnly`, `SameSite: Lax`, secure cookie (`__session`).
* Verified in Hono middleware using `adminAuth.verifySessionCookie(cookie, true)` (checking revocation).
* Cached in-memory in `src/v1/session.ts` with a 60-second TTL to avoid hitting Firebase Admin on every inbound request, with periodic 60-second cleanup.

### 4.3 Dual Auth Endpoint Architecture

Currently, the server hosts two distinct auth routing implementations:

1. **New V1 Auth (`src/v1/routes/auth.ts`, `claim.ts`, `google.ts`)**:
   * Endpoints:
     * `POST /api/v1/auth/signin`
     * `POST /api/v1/auth/signup`
     * `POST /api/v1/auth/signout`
     * `POST /api/v1/auth/forgot`
     * `POST /api/v1/auth/claim/start`
     * `POST /api/v1/auth/claim/open`
     * `POST /api/v1/auth/claim/complete`
     * `POST /api/v1/auth/google/start` & `/exchange`
   * Directly sets and clears cookies on the response.
   * Interacts with MongoDB repository (`src/v1/repo/students.repo.ts`).

2. **Legacy Auth (`src/auth/routes.ts`)**:
   * Mounted at `/api/auth/*`.
   * Used server-to-server by `cse-archive-client` (`features/auth/server.ts`) with `Authorization: Bearer <AUTH_SERVICE_SECRET>`.
   * Returns `{ ok, viewer, session }` payloads so Next.js can set cookies on its own domain.
   * **Note:** `loadViewer()` in `src/auth/auth.ts` still queries Firestore! (See Section 5).

---

## 5. Critical Issues & Required Fixes

### Issue 1: Database Name Configuration Discrepancy
* **Problem**:
  * In `scripts/migrate-firestore-to-mongo.ts`, line 7 hardcodes:
    ```ts
    const dbName = "CseArchive";
    ```
  * In `src/v1/env.ts`, `MONGODB_DB` defaults to `"ruetcse"`:
    ```ts
    MONGODB_DB: z.string().default("ruetcse")
    ```
  * In `scripts/verify-migration.ts`, line 6 uses:
    ```ts
    const dbName = process.env.MONGODB_DB || "ruetcse";
    ```
  * In `.env`, `MONGODB_URI` specifies `.../CseArchive?...`, but `MONGODB_DB` is not explicitly set.
* **Impact**: If `MONGODB_DB` is not explicitly specified as `"CseArchive"`, the server and verification script will read from the default `"ruetcse"` database while the migration script populated `"CseArchive"`.
* **Fix**:
  1. Add `MONGODB_DB=CseArchive` to `.env` (and Render environment variables).
  2. Standardize `scripts/migrate-firestore-to-mongo.ts` and `scripts/verify-migration.ts` to use `process.env.MONGODB_DB || "CseArchive"`.

### Issue 2: Legacy `/api/auth` Still Reads From Firestore
* **Problem**: `cse-archive-client` calls `/api/auth/session` and `/api/auth/login`. In `src/auth/auth.ts:30`:
  ```ts
  export async function loadViewer(uid: string): Promise<Viewer | null> {
    const snap = await getFirestore(getAdmin()).collection("profiles").doc(uid).get();
    ...
  }
  ```
* **Impact**: When Firestore is decommissioned, `cse-archive-client` login and session verification will break.
* **Fix**: Update `loadViewer()` in `src/auth/auth.ts` to fetch from MongoDB via `findProfileById(uid)` from `src/v1/repo/students.repo.ts`.

### Issue 3: Frontend Client Routing
* **Problem**:
  * `ruet-cse-24/next.config.js` sets up a rewrite from `/api/:path*` to `${API_ORIGIN}/api/v1/:path*`.
  * `API_ORIGIN` is not defined in `ruet-cse-24/.env.local`.
* **Fix**: Set `API_ORIGIN=https://<your-render-app>.onrender.com` (or `http://localhost:3005` in development).

---

## 6. Migration Execution Checklist

- [ ] **Step 1: Environment Alignment**
  - In `.env`, ensure:
    ```env
    MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/CseArchive?retryWrites=true&w=majority
    MONGODB_DB=CseArchive
    ```
- [ ] **Step 2: Run Data Migration**
  ```bash
  # Test with dry-run
  bun scripts/migrate-firestore-to-mongo.ts --dry-run

  # Perform live migration
  bun scripts/migrate-firestore-to-mongo.ts
  ```
- [ ] **Step 3: Verify Data Parity**
  ```bash
  bun scripts/verify-migration.ts
  ```
  Ensure all document count checks, roll uniqueness, and sample tests pass.
- [ ] **Step 4: Update `src/auth/auth.ts` for MongoDB**
  Replace Firestore `loadViewer` with MongoDB profile lookup.
- [ ] **Step 5: Configure Frontends**
  - `ruet-cse-24`: Add `API_ORIGIN` pointing to `cse-archive-server`.
  - `cse-archive-client`: Verify `/api/auth` and `/api/drive` continue functioning.
- [ ] **Step 6: Deploy to Render**
  - Update environment variables on Render (`MONGODB_URI`, `MONGODB_DB=CseArchive`).
  - Deploy and monitor Render logs.
