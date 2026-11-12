import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  adminAuth,
  maskEmail,
  sendOobCode,
  signInWithIdp,
  signUpWithPassword,
} from "../../config/firebase";
import { env } from "../../config/env";
import { getUsersCol } from "../../config/mongo";
import { sha256 } from "../../shared/utils";
import { isAllowedOrigin } from "../../middleware/originCheck";
import {
  findProfileById,
  findProfileByRoll,
  findLegacyByEmail,
  reserveRoll,
  releaseRoll,
} from "../profile/profile.services";
import { getSeries, seriesFromRoll } from "../profile/profile.types";
import {
  isRole,
  type Viewer,
  type AuthSuccess,
  type AuthFailure,
  type Session,
  type SessionPayload,
  type Role,
} from "./auth.types";
export type { Viewer, AuthSuccess, AuthFailure, Session, SessionPayload, Role };

export const SESSION_COOKIE = "__session";
export const SESSION_MAX_AGE_S = 5 * 24 * 60 * 60; // 5 days
const TTL_MS = 60_000;

const sessionCache = new Map<string, { session: Session; expires: number }>();

// Prune expired cache entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionCache) {
    if (v.expires < now) sessionCache.delete(k);
  }
}, 60_000).unref?.();

// ─── Session cookies ─────────────────────────────────────────

/** Mints a Firebase session cookie value from a fresh ID token. */
export async function mintSession(idToken: string): Promise<SessionPayload> {
  const value = await adminAuth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_S * 1000,
  });
  return { value, maxAge: SESSION_MAX_AGE_S };
}

/**
 * Mints a session and also sets it on this server's domain. Next.js clients
 * must set `__session` on their own domain from the returned payload.
 */
export async function createSession(c: Context, idToken: string): Promise<SessionPayload> {
  const session = await mintSession(idToken);
  setSessionCookie(c, session);
  return session;
}

/** Sets `__session` on this server's own domain (same-origin callers). */
export function setSessionCookie(c: Context, session: SessionPayload): void {
  setCookie(c, SESSION_COOKIE, session.value, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: session.maxAge,
  });
  c.header("Cache-Control", "private, no-store");
}

/** Drops a session value from the in-memory verification cache. */
export function forgetSession(value: string): void {
  sessionCache.delete(sha256(value));
}

export function clearSession(c: Context): void {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) sessionCache.delete(sha256(cookie));
  const bearer = bearerToken(c);
  if (bearer) sessionCache.delete(sha256(bearer));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function bearerToken(c: Context): string | null {
  const authHeader = c.req.header("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
}

export async function readSession(c: Context): Promise<Session | null> {
  const rawToken = getCookie(c, SESSION_COOKIE) || bearerToken(c);
  if (!rawToken) return null;

  const key = sha256(rawToken);
  const hit = sessionCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.session;

  // Try verifying as session cookie first
  try {
    const d = await adminAuth.verifySessionCookie(rawToken, true);
    const session: Session = {
      uid: d.uid,
      email: d.email ?? "",
      emailVerified: d.email_verified === true,
      mustRotate: d.mustRotate === true,
      needsSection: d.needsSection === true,
    };
    sessionCache.set(key, { session, expires: Date.now() + TTL_MS });
    return session;
  } catch {
    // Legacy dual mode: raw Firebase ID token from browser-side Firebase Auth.
    // TODO(phase-4): remove once both clients are fully server-side.
    try {
      const d = await adminAuth.verifyIdToken(rawToken, true);
      const session: Session = {
        uid: d.uid,
        email: d.email ?? "",
        emailVerified: d.email_verified === true,
        mustRotate: d.mustRotate === true,
        needsSection: d.needsSection === true,
      };
      sessionCache.set(key, { session, expires: Date.now() + TTL_MS });
      return session;
    } catch {
      sessionCache.delete(key);
      return null;
    }
  }
}

// ─── Users & roles ───────────────────────────────────────────

/**
 * Ensures a `users` record exists for this account. New records are always
 * `student`; an existing role (set manually in the DB) is never overwritten.
 */
export async function ensureUser(uid: string, email: string): Promise<Role> {
  const col = await getUsersCol();
  const doc = await col.findOneAndUpdate({ _id: uid }, ensureUserUpdate(uid, email, new Date()), {
    upsert: true,
    returnDocument: "after",
  });
  return isRole(doc?.role) ? doc.role : "student";
}

/** The `role` lives only under `$setOnInsert`, so an existing role is never changed. */
export function ensureUserUpdate(uid: string, email: string, now: Date) {
  return {
    $setOnInsert: { _id: uid, role: "student" as Role, createdAt: now },
    $set: { email: email.trim().toLowerCase(), updatedAt: now },
  };
}

/** Reads the current role from the DB. Missing / malformed records count as `student`. */
export async function getUserRole(uid: string): Promise<Role> {
  const col = await getUsersCol();
  const doc = await col.findOne({ _id: uid }, { projection: { role: 1 } });
  return isRole(doc?.role) ? doc.role : "student";
}

// ─── Viewer ──────────────────────────────────────────────────

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/** Builds the viewer payload. Always returns a viewer, even before a profile exists. */
export async function loadViewer(identity: {
  uid: string;
  email: string;
  emailVerified: boolean;
}): Promise<Viewer> {
  const [profile, role] = await Promise.all([findProfileById(identity.uid), getUserRole(identity.uid)]);
  return {
    uid: identity.uid,
    email: profile?.email || identity.email,
    emailVerified: identity.emailVerified,
    role,
    roll: profile?.roll ?? "",
    series: profile?.series ?? "",
    name: profile?.fullName ?? "",
    profilePictureUrl: profile?.profilePicture?.url ?? "",
    hasProfile: Boolean(profile),
  };
}

/**
 * Shared tail of every sign-in path: blocks unclaimed legacy accounts, records
 * the user (role), mints the session and loads the viewer.
 */
export async function finishSignIn(idToken: string): Promise<AuthSuccess | AuthFailure> {
  const decoded = await adminAuth.verifyIdToken(idToken);
  if (decoded.mustRotate === true) {
    return {
      ok: false,
      code: "claim",
      message: "This profile has not been claimed yet. Please claim it with your email link.",
    };
  }

  const email = (decoded.email ?? "").toLowerCase();
  const emailVerified = decoded.email_verified === true;
  await ensureUser(decoded.uid, email);
  const [session, viewer] = await Promise.all([
    mintSession(idToken),
    loadViewer({ uid: decoded.uid, email, emailVerified }),
  ]);
  return { ok: true, email, emailVerified, viewer, session };
}

/** Verifies a session cookie value and returns the viewer (server-to-server checks). */
export async function verifySession(value: string): Promise<Viewer | null> {
  try {
    const d = await adminAuth.verifySessionCookie(value, true);
    return await loadViewer({ uid: d.uid, email: d.email ?? "", emailVerified: d.email_verified === true });
  } catch {
    return null;
  }
}

// ─── Sign-up ─────────────────────────────────────────────────

const LEGACY_MESSAGE = "This email has a profile from the old directory. Reclaim it with an email link instead.";

export async function signUp(input: {
  series: string;
  email: string;
  password: string;
  roll?: string;
}): Promise<AuthSuccess | AuthFailure> {
  const { series: seriesId, email, password, roll } = input;

  const seriesConfig = getSeries(seriesId);
  if (!seriesConfig || seriesConfig.status !== "open") {
    console.log(`[auth] signup ${maskEmail(email)} -> series-${seriesId}-closed`);
    return { ok: false, code: "series-closed", message: "This series is not accepting new accounts." };
  }

  if (roll) {
    if (seriesFromRoll(roll)?.id !== seriesConfig.id) {
      return { ok: false, code: "bad-series", message: "This roll number does not belong to this series." };
    }
    if (await findProfileByRoll(roll)) {
      return { ok: false, code: "roll-held", message: "This roll number is already registered." };
    }
  }

  // Legacy / existing-account checks
  const existing = await adminAuth.getUserByEmail(email).catch((err: any) => {
    if (err?.code === "auth/user-not-found") return null;
    throw err;
  });
  if (existing?.customClaims?.mustRotate === true) return { ok: false, code: "claim", message: LEGACY_MESSAGE };
  if (existing) return { ok: false, code: "exists", message: "An account already exists with this email." };
  if (await findLegacyByEmail(email)) return { ok: false, code: "claim", message: LEGACY_MESSAGE };

  const created = await signUpWithPassword(email, password);
  if (!created.ok) {
    if (created.reason === "exists") {
      return { ok: false, code: "exists", message: "An account already exists with this email." };
    }
    if (created.reason === "weak-password") {
      return { ok: false, code: "invalid", message: "Choose a stronger password." };
    }
    return { ok: false, code: "unavailable", message: "Failed to create account." };
  }

  const { uid, idToken } = created;
  let rollReserved = false;

  try {
    if (roll) {
      rollReserved = await reserveRoll(roll, uid);
      if (!rollReserved) {
        await adminAuth.deleteUser(uid).catch((e) => console.error("[auth] signup rollback deleteUser:", e));
        return { ok: false, code: "roll-held", message: "This roll number is already registered." };
      }
    }

    await ensureUser(uid, email);

    await sendOobCode({
      requestType: "VERIFY_EMAIL",
      email,
      idToken,
      continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
    }).catch((e) => console.error("[auth] signup verify-email send failed:", e));

    const [session, viewer] = await Promise.all([
      mintSession(idToken),
      loadViewer({ uid, email, emailVerified: false }),
    ]);
    console.log(`[auth] signup ${maskEmail(email)} -> ok (uid: ${uid})`);
    return { ok: true, email, emailVerified: false, viewer, session };
  } catch (err) {
    console.error(`[auth] signup ${maskEmail(email)} failed, rolling back:`, err);
    if (rollReserved && roll) await releaseRoll(roll, uid).catch(() => {});
    await adminAuth.deleteUser(uid).catch(() => {});
    const users = await getUsersCol().catch(() => null);
    await users?.deleteOne({ _id: uid }).catch(() => {});
    return { ok: false, code: "error", message: "Failed to create account." };
  }
}

// ─── Google OAuth (PKCE) ─────────────────────────────────────
// Each Next.js client owns its callback route and sets `__session` on its own
// domain; the server only builds the auth URL and performs the exchange.

export function isAllowedRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return isAllowedOrigin(url.origin);
  } catch {
    return false;
  }
}

export function googleStart(redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state, verifier };
}

export async function googleSignIn(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<AuthSuccess | AuthFailure> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!data.id_token) {
    console.error("[auth] google -> token-exchange", data.error ?? res.status);
    return { ok: false, code: "error", message: "Google sign-in failed." };
  }

  // Identity Toolkit verifies the Google id_token signature / audience and
  // creates the Firebase user on first sign-in.
  const idp = await signInWithIdp(data.id_token, new URL(redirectUri).origin);
  if (!idp.ok) return { ok: false, code: "unavailable", message: "Google sign-in failed." };

  if (idp.isNewUser) {
    // A first-time Google sign-in for an email that still has an unclaimed
    // legacy profile must go through the claim flow instead.
    if (idp.email && (await findLegacyByEmail(idp.email))) {
      await adminAuth.deleteUser(idp.uid).catch((e) => console.error("[auth] google legacy rollback:", e));
      return { ok: false, code: "claim", message: LEGACY_MESSAGE };
    }
    console.log(`[auth] google ${maskEmail(idp.email)} -> new account (uid: ${idp.uid})`);
  }
  return finishSignIn(idp.idToken);
}
