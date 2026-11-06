import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHash, randomBytes } from "crypto";
import { env } from "../env";
import { adminAuth, maskEmail, idTokenForUid } from "../firebase";
import { createSession } from "../session";
import { findLegacyByEmail, findProfileById } from "../repo/students.repo";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp";
const STATE_COOKIE = "__g_oauth";
const STATE_MAX_AGE_S = 10 * 60; // 10 minutes

const allowedOrigins = new Set(
  env.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return null;
  }
  return next.slice(0, 512);
}

export const googleRoutes = new Hono();

googleRoutes.get("/start", async (c) => {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ ok: false, code: "not-configured", message: "Google OAuth not configured." }, 500);
  }

  const site = c.req.query("site") || env.PUBLIC_SITE_URL;
  if (!allowedOrigins.has(site)) {
    return c.json({ ok: false, code: "bad-site", message: "Invalid site parameter." }, 400);
  }

  const next = safeNext(c.req.query("next"));
  const redirectUri = `${site.replace(/\/+$/, "")}/api/v1/auth/google/callback`;

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  setCookie(
    c,
    STATE_COOKIE,
    JSON.stringify({ state, verifier, next, redirectUri, site }),
    {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_MAX_AGE_S,
    },
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  return c.redirect(`${AUTH_URL}?${params}`);
});

googleRoutes.get("/callback", async (c) => {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const rawCookie = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });

  let saved: {
    state?: string;
    verifier?: string;
    next?: string | null;
    redirectUri?: string;
    site?: string;
  } = {};

  try {
    saved = rawCookie ? JSON.parse(rawCookie) : {};
  } catch {
    saved = {};
  }

  const site = saved.site || env.PUBLIC_SITE_URL;
  const errorRedirect = (reason: string) => {
    console.error(`[auth] google -> ${reason}`);
    return c.redirect(`${site}/profiles/signin?authError=google`);
  };

  if (!clientId || !clientSecret) return errorRedirect("not-configured");

  const queryError = c.req.query("error");
  if (queryError) return errorRedirect(`consent-${queryError}`);

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state || !saved.state || !saved.verifier || !saved.redirectUri || state !== saved.state) {
    return errorRedirect("state-mismatch");
  }

  // 1. Exchange code for Google id_token
  let googleIdToken: string | undefined;
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: saved.redirectUri,
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
    });
    const tokenData = (await tokenRes.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.id_token) {
      return errorRedirect(`token-exchange ${tokenData.error ?? tokenRes.status}`);
    }
    googleIdToken = tokenData.id_token;
  } catch (err) {
    console.error("[auth] Google token exchange request failed:", err);
    return errorRedirect("network-error");
  }

  // 2. Decode payload
  let payload: { email?: string; email_verified?: boolean; sub?: string } = {};
  try {
    const part = googleIdToken.split(".")[1] ?? "";
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return errorRedirect("invalid-google-token");
  }

  const email = payload.email?.trim().toLowerCase();
  if (!email || payload.email_verified !== true || !payload.sub) {
    return errorRedirect("unverified-google-email");
  }

  // 3. Old directory check
  try {
    const user = await adminAuth.getUserByEmail(email);
    if (user.customClaims?.mustRotate === true) {
      console.log(`[auth] google ${maskEmail(email)} -> old-directory (sent to claim)`);
      return c.redirect(`${site}/profiles/claim?from=google`);
    }
  } catch (err: any) {
    if (err.code !== "auth/user-not-found") throw err;
    const legacy = await findLegacyByEmail(email);
    if (legacy) {
      console.log(`[auth] google ${maskEmail(email)} -> old-directory legacy (sent to claim)`);
      return c.redirect(`${site}/profiles/claim?from=google`);
    }
  }

  // 4. Exchange Google id_token for Firebase idToken
  let firebaseIdToken: string | undefined;
  let uid = "";
  try {
    const idpRes = await fetch(`${IDP_URL}?key=${env.FIREBASE_WEB_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${googleIdToken}&providerId=google.com`,
        requestUri: saved.redirectUri,
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    });
    const idpData = (await idpRes.json().catch(() => ({}))) as {
      idToken?: string;
      localId?: string;
      needConfirmation?: boolean;
      isNewUser?: boolean;
      error?: { message?: string };
    };

    if (!idpRes.ok) {
      return errorRedirect(`idp ${idpData.error?.message ?? "UNKNOWN"}`);
    }

    uid = idpData.localId ?? "";
    firebaseIdToken = idpData.idToken;

    // Linking existing account if needed
    if (idpData.needConfirmation || !firebaseIdToken) {
      const existing = await adminAuth.getUserByEmail(email);
      await adminAuth.updateUser(existing.uid, {
        providerToLink: { providerId: "google.com", uid: payload.sub, email },
      });
      uid = existing.uid;
      firebaseIdToken = (await idTokenForUid(uid)) ?? undefined;
      console.log(`[auth] google ${maskEmail(email)} -> linked to existing uid=${uid}`);
    }
  } catch (err) {
    console.error("[auth] Google signInWithIdp error:", err);
    return errorRedirect("idp-error");
  }

  if (!firebaseIdToken || !uid) return errorRedirect("no-token");

  // 5. Establish session & ensure email is verified
  await createSession(c, firebaseIdToken);
  await adminAuth.updateUser(uid, { emailVerified: true }).catch(() => {});

  const profile = await findProfileById(uid);
  console.log(`[auth] google ${maskEmail(email)} -> ok uid=${uid} hasProfile=${profile !== null}`);

  if (!profile) {
    return c.redirect(`${site}/profiles/create`);
  }

  const targetPath = saved.next || `/profiles/${uid}`;
  return c.redirect(`${site}${targetPath}`);
});
