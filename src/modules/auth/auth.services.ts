import { createHash, randomBytes } from "node:crypto";
import { adminAuth, verifyPassword, postIdentityToolkit, sendOobCode } from "../../config/firebase";
import { env } from "../../config/env";
import { findProfileById, findLegacyByEmail } from "../profile/profile.services";
import { getSeries } from "../profile/profile.types";
import { SESSION_MAX_AGE_S } from "./auth.session";
import type { Viewer, AuthSuccess, AuthFailure } from "./auth.types";
export type { Viewer, AuthSuccess, AuthFailure };

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export async function loadViewer(uid: string): Promise<Viewer | null> {
  const p = await findProfileById(uid);
  if (!p || !p.roll) return null;
  return {
    uid,
    email: p.email ?? "",
    roll: p.roll,
    name: p.fullName ?? "",
    profilePictureUrl: p.profilePicture?.url ?? "",
  };
}

export async function finishSignIn(idToken: string): Promise<AuthSuccess | AuthFailure> {
  const token = await adminAuth.verifyIdToken(idToken);
  if (token.mustRotate === true) return { ok: false, code: "claim" };
  const viewer = await loadViewer(token.uid);
  if (!viewer) return { ok: false, code: "no-profile" };
  const value = await adminAuth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_S * 1000 });
  return { ok: true, viewer, session: { value, maxAge: SESSION_MAX_AGE_S } };
}

export async function verifySession(value: string): Promise<Viewer | null> {
  try {
    const decoded = await adminAuth.verifySessionCookie(value, true);
    return await loadViewer(decoded.uid);
  } catch {
    return null;
  }
}

export function googleStart(redirectUri: string) {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  const state = Buffer.from(randomBytes(16)).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");

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

  const data = (await res.json()) as { id_token?: string; error?: string };
  if (!data.id_token) {
    console.error("[auth] google -> token-exchange", data.error ?? res.status);
    return { ok: false, code: "error" };
  }

  const claims = JSON.parse(Buffer.from(data.id_token.split(".")[1]!, "base64url").toString()) as {
    aud?: string;
    iss?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
  };

  const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (claims.aud !== env.GOOGLE_OAUTH_CLIENT_ID || !issuerOk || !claims.exp || claims.exp * 1000 < Date.now()) {
    console.error("[auth] google -> bad id_token claims");
    return { ok: false, code: "error" };
  }
  if (!claims.email || claims.email_verified !== true) return { ok: false, code: "error" };

  const user = await adminAuth.getUserByEmail(claims.email.toLowerCase()).catch(() => null);
  if (!user) return { ok: false, code: "no-account" };
  if (user.customClaims?.mustRotate === true) return { ok: false, code: "claim" };

  const customToken = await adminAuth.createCustomToken(user.uid);
  const minted = await postIdentityToolkit<{ idToken: string }>("accounts:signInWithCustomToken", {
    token: customToken,
    returnSecureToken: true,
  });

  if (!minted.ok || !minted.data.idToken) {
    console.error("[auth] google -> custom token sign-in", !minted.ok ? minted.code : "no-token");
    return { ok: false, code: "error" };
  }

  return finishSignIn(minted.data.idToken);
}
