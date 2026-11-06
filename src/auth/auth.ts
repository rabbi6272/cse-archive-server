import { createHash, randomBytes } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import getAdmin, { getAdminAuth } from "../firebase-admin";

// Sign-in for the main site against the same Firebase Auth accounts as the profile site
// (project ruet-cse-24, see ruet-cse-24/AUTH_FLOW.md). Passwords go to Google's Identity Toolkit and
// are never read, stored or compared here. The session cookie value is minted here; the Next.js site
// sets it as an HttpOnly cookie on its own domain (a cookie from this domain would be third-party).

// Public web API key of ruet-cse-24 (the same one the client's utils/UsersDB.js ships to browsers).
const API_KEY = process.env.USERS_FIREBASE_API_KEY ?? "AIzaSyCxod-eup82Oy_Od04YLHs7iOQdFGBmEHU";
const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";
export const SESSION_MAX_AGE_S = 5 * 24 * 60 * 60; // 5 days (Firebase allows up to 14)

export type Viewer = { uid: string; email: string; roll: string; name: string; profilePictureUrl: string };
export type AuthFailure = { ok: false; code: "invalid" | "claim" | "no-profile" | "no-account" | "throttled" | "error" };
export type AuthSuccess = { ok: true; viewer: Viewer; session: { value: string; maxAge: number } };

async function identityToolkit(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${IDENTITY_TOOLKIT}/${method}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  return (await res.json()) as { idToken?: string; error?: { message?: string } };
}

// The main site needs a profile (roll, name): accounts without one are sent to the profile site.
export async function loadViewer(uid: string): Promise<Viewer | null> {
  const snap = await getFirestore(getAdmin()).collection("profiles").doc(uid).get();
  if (!snap.exists) return null;
  const p = snap.data() as { email?: string; roll?: string; fullName?: string; profilePicture?: { url?: string } };
  if (!p.roll) return null;
  return { uid, email: p.email ?? "", roll: p.roll, name: p.fullName ?? "", profilePictureUrl: p.profilePicture?.url ?? "" };
}

// Shared tail of both sign-in paths: refuse unclaimed seeded accounts, require a profile, mint the session.
async function finishSignIn(idToken: string): Promise<AuthSuccess | AuthFailure> {
  const token = await getAdminAuth().verifyIdToken(idToken);
  // Seeded accounts still on the old public pincode must be claimed first (AUTH_FLOW.md §4.2).
  if (token.mustRotate === true) return { ok: false, code: "claim" };
  const viewer = await loadViewer(token.uid);
  if (!viewer) return { ok: false, code: "no-profile" };
  const value = await getAdminAuth().createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_S * 1000 });
  return { ok: true, viewer, session: { value, maxAge: SESSION_MAX_AGE_S } };
}

const BAD_CREDENTIALS = ["INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND", "INVALID_PASSWORD", "INVALID_EMAIL", "USER_DISABLED"];

export async function passwordSignIn(email: string, password: string): Promise<AuthSuccess | AuthFailure> {
  const data = await identityToolkit("accounts:signInWithPassword", { email, password });
  if (!data.idToken) {
    const code = data.error?.message?.split(" ")[0] ?? "";
    if (BAD_CREDENTIALS.includes(code)) return { ok: false, code: "invalid" };
    if (code.startsWith("TOO_MANY_ATTEMPTS")) return { ok: false, code: "throttled" };
    console.error("[auth] signin -> identity toolkit", code);
    return { ok: false, code: "error" };
  }
  return finishSignIn(data.idToken);
}

// checkRevoked: a password change or claim on the profile site ends sessions here too.
export async function verifySession(value: string): Promise<Viewer | null> {
  try {
    const decoded = await getAdminAuth().verifySessionCookie(value, true);
    return await loadViewer(decoded.uid);
  } catch {
    return null;
  }
}

// ─── Google (state + PKCE, same shape as the profile site's google.server.ts) ──────────────

export const googleConfigured = () =>
  Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);

const b64url = (buf: Buffer) => buf.toString("base64url");

// redirectUri is the Next.js site's callback; Google rejects any URI not registered on the client.
export function googleStart(redirectUri: string) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state, verifier };
}

// The main site only signs in existing accounts; creating one happens on the profile site.
export async function googleSignIn(code: string, verifier: string, redirectUri: string): Promise<AuthSuccess | AuthFailure> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { id_token?: string; error?: string };
  if (!data.id_token) {
    console.error("[auth] google -> token-exchange", data.error ?? res.status);
    return { ok: false, code: "error" };
  }

  // Straight from Google's token endpoint over TLS, so (per OpenID Connect) TLS stands in for
  // checking the signature; the claims are still checked.
  const claims = JSON.parse(Buffer.from(data.id_token.split(".")[1]!, "base64url").toString()) as {
    aud?: string; iss?: string; exp?: number; email?: string; email_verified?: boolean;
  };
  const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (claims.aud !== process.env.GOOGLE_OAUTH_CLIENT_ID || !issuerOk || !claims.exp || claims.exp * 1000 < Date.now()) {
    console.error("[auth] google -> bad id_token claims");
    return { ok: false, code: "error" };
  }
  if (!claims.email || claims.email_verified !== true) return { ok: false, code: "error" };

  const user = await getAdminAuth().getUserByEmail(claims.email.toLowerCase()).catch(() => null);
  if (!user) return { ok: false, code: "no-account" };
  if (user.customClaims?.mustRotate === true) return { ok: false, code: "claim" };

  // Google proved the mailbox; sign the existing account in with a custom token -> idToken.
  const minted = await identityToolkit("accounts:signInWithCustomToken", {
    token: await getAdminAuth().createCustomToken(user.uid),
  });
  if (!minted.idToken) {
    console.error("[auth] google -> custom token sign-in", minted.error?.message);
    return { ok: false, code: "error" };
  }
  return finishSignIn(minted.idToken);
}
