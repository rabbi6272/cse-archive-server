# cse-archive-server

Drive service for the RUET CSE Archive site. It lists Google Drive folders, caches them in memory, and clears the cache when Google sends a change notification. It runs on Bun + Hono on Render.

## How it works

```
Browser (drive page)   ──POST /api/drive──────────▶ this server → cache hit? → else Google Drive API
Admin page             ──/api/drive/admin (Bearer)─▶ this server
Google Drive           ──webhook──────────────────▶ /api/drive/webhook → clear the whole cache
cron-job.org (daily)   ──renew-watch (Bearer)─────▶ renew the Google watch if it expires within 24h
cron-job.org (10 min)  ──/health──────────────────▶ keeps the free Render instance awake
```

| Data | Where | Survives restart? |
|---|---|---|
| Folder listings | In-memory `Map`, 12 h TTL (`src/cache.ts`) | No, it's re-fetched on the next request |
| Page token | Firebase RTDB `drive/meta/pageToken` | Yes |
| Watch channel | Firebase RTDB `drive/meta/watch` (`channelId`, `resourceId`, `expiration`) | Yes |
| Last webhook | Firebase RTDB `drive/meta/lastNotification` | Yes |

Any change in Drive clears **all** cached folders. Changes are rare, so it doesn't track which folder changed.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Returns `ok`, for uptime pings |
| `POST /api/drive` | none, CORS-limited to `ALLOWED_ORIGIN` | Body `{ "folderId": "..." }` returns `{ files, parentFolderId, currentFolder }`. A malformed `folderId` gets a 400. |
| `GET /api/drive` | none | Status: RTDB reachable, watch expiry, page token, last webhook |
| `POST /api/drive/webhook` | `x-goog-channel-token` + channel id + resource id | Google push notifications |
| `GET\|POST /api/drive/renew-watch` | `Bearer CRON_SECRET` or `Bearer ADMIN_SECRET` | Daily watch renewal |
| `GET /api/drive/admin` | `Bearer ADMIN_SECRET` | Status snapshot |
| `POST /api/drive/admin` | `Bearer ADMIN_SECRET` | Body `{ "action": ... }`, see below |

Admin actions:

| action | does | extra body |
|---|---|---|
| `setup` | Creates the page token and watch channel if missing or expired | — |
| `revalidate` | Clears the cache, and can pre-fetch the root folder | `"warm": true` |
| `delete` | Clears the cache, and can also wipe `drive/meta/*` | `"clearMeta": true` |
| `renew` | Renews the watch now | — |
| `status` | Status only | — |

## Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` | Drive service account (read-only scope) |
| `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`, `FIREBASE_ADMIN_PROJECT_ID` | Firebase Admin, for `drive/meta/*` |
| `FIREBASE_ADMIN_DATABASE_URL` | **Regional** RTDB URL, e.g. `https://<project>-default-rtdb.<region>.firebasedatabase.app` |
| `GOOGLE_DRIVE_WEBHOOK_URL` | `https://<app>.onrender.com/api/drive/webhook` |
| `GOOGLE_DRIVE_WEBHOOK_TOKEN` | Random secret that Google echoes back on every webhook |
| `ADMIN_SECRET` | Admin page and admin API |
| `CRON_SECRET` | cron-job.org renew job |
| `ALLOWED_ORIGIN` | The site's origin, e.g. `https://ruet-cse-archive.vercel.app` |
| `PORT` | Set by Render (default 3000) |
| `AUTH_SERVICE_SECRET` | Shared with the Next.js site (same value in Vercel). Guards every `/api/auth/*` call |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional. The Web OAuth client of the `ruet-cse-24` Firebase project; enables "Continue with Google" |
| `USERS_FIREBASE_API_KEY` | Optional. `ruet-cse-24` web API key; defaults to the public key the client already ships |

The Firebase Admin credentials (`FIREBASE_ADMIN_*`) must be for **`ruet-cse-24`**: sign-in uses that project's Auth accounts and `profiles` collection.

## Main-site sign-in (`/api/auth`)

Server-to-server only (no CORS). The Next.js site calls these with `Authorization: Bearer <AUTH_SERVICE_SECRET>` and sets the returned session as an HttpOnly `__session` cookie on its own domain (a cookie from this domain would be a blocked third-party cookie). Same accounts and rules as the profile site (`ruet-cse-24/AUTH_FLOW.md`): passwords are checked by Firebase's Identity Toolkit, unclaimed seeded accounts (`mustRotate`) are refused, and an account needs a `profiles/{uid}` document.

| Endpoint | Does |
|---|---|
| `POST /api/auth/login` `{email, password}` | Password sign-in → `{ok, viewer, session: {value, maxAge}}` or `{ok:false, code}` (`invalid`, `claim`, `no-profile`, `throttled`, `error`) |
| `POST /api/auth/session` `{session}` | Verifies a session cookie (revocation-checked) → `{ok, viewer}` |
| `GET /api/auth/config` | `{google: boolean}` |
| `POST /api/auth/google/start` `{redirectUri}` | Google authorize URL + `state` + PKCE `verifier` |
| `POST /api/auth/google/exchange` `{code, verifier, redirectUri}` | Signs an existing account in → same shape as login (`no-account` if none) |

For Google, add `<site>/api/auth/google/callback` (the Next.js site, e.g. `https://ruetcsearchive.vercel.app/api/auth/google/callback` and `http://localhost:3000/...`) to the OAuth client's Authorized redirect URIs.

Generate secrets with `openssl rand -hex 32`.


## Local development

```bash
bun install
bun test          # cache tests
bun run dev       # http://localhost:3000, restarts on change
```

Put the env vars in `.env` (Bun loads it automatically, and it's gitignored). Google can't reach `localhost`, so for webhooks use a tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and set `GOOGLE_DRIVE_WEBHOOK_URL` to the tunnel URL.

## Troubleshooting

- **"No page token, cannot process changes":** run the admin `setup` action.
- **"Invalid token, ignoring":** `GOOGLE_DRIVE_WEBHOOK_TOKEN` doesn't match the token the watch was created with. Re-run `setup` after `delete` + `clearMeta`.
- **"Unknown channel, ignoring":** a notification from an old channel. Harmless, and it stops when that channel expires.
- **Webhook returns 500:** Firebase RTDB is unreachable (check the regional `FIREBASE_ADMIN_DATABASE_URL`) or the Drive API failed (credentials, quota). Check the Render logs.
- **New files don't show up:** check that `lastNotification` in `GET /api/drive` is recent and the watch isn't expired. Force a refresh with `{"action":"revalidate","warm":true}`. The 12 h TTL refreshes the data anyway if webhooks stop.
- **Slow first load:** the instance slept, because the keep-awake cron isn't running. Check cron-job.org.
