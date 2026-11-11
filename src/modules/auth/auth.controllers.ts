import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { adminAuth, maskEmail, verifyPassword, sendOobCode, postIdentityToolkit } from "../../config/firebase";
import { env } from "../../config/env";
import { createSession, clearSession } from "./auth.session";
import { checkRateLimit } from "../../middleware/rateLimit";
import { findLegacyByEmail } from "../profile/profile.services";
import { getSeries } from "../profile/profile.types";
import { safeNext, safeCompare, base64url } from "../../shared/utils";
import {
  isGoogleConfigured,
  loadViewer,
  finishSignIn,
  verifySession,
  googleStart,
  googleSignIn,
} from "./auth.services";
import { loginSchema, signUpSchema, forgotPasswordSchema } from "./auth.types";
import { randomBytes, createHash } from "node:crypto";

const STATE_COOKIE = "__g_oauth";
const STATE_MAX_AGE_S = 10 * 60; // 10 minutes

export async function signInController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { email, password } = parsed.data;
  const verifyResult = await verifyPassword(email, password);

  if (!verifyResult.ok) {
    console.log(`[auth] signin ${maskEmail(email)} -> ${verifyResult.reason}`);
    return c.json(
      {
        ok: false,
        code: verifyResult.reason === "invalid" ? "invalid" : "unavailable",
        message: verifyResult.reason === "invalid"
          ? "Check your email and password."
          : "Authentication service temporarily unavailable.",
      },
      verifyResult.reason === "invalid" ? 401 : 503,
    );
  }

  const { idToken } = verifyResult;
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);

    if (decoded.mustRotate === true) {
      console.log(`[auth] signin ${maskEmail(email)} -> needs-claim`);
      return c.json({
        ok: false,
        code: "claim",
        message: "This profile has not been claimed yet. Please claim it with your email link.",
      });
    }

    const emailVerified = decoded.email_verified === true;
    if (!emailVerified) {
      console.log(`[auth] signin ${maskEmail(email)} -> unverified (resending link)`);
      await sendOobCode({
        requestType: "VERIFY_EMAIL",
        email,
        idToken,
        continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
      }).catch((e) => console.error("[auth] auto-resend verification failed:", e));
    }

    const sessionCookieValue = await createSession(c, idToken);
    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] signin ${maskEmail(email)} -> ok (uid: ${decoded.uid})`);

    const viewer = await loadViewer(decoded.uid);

    return c.json({
      ok: true,
      email: decoded.email ?? email,
      emailVerified,
      viewer: viewer ?? undefined,
      session: {
        value: sessionCookieValue,
        maxAge: 5 * 24 * 60 * 60,
      },
    });
  } catch (err) {
    console.error(`[auth] signin ${maskEmail(email)} -> error verifying token:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to establish session." }, 500);
  }
}

export async function signOutController(c: Context) {
  clearSession(c);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
}

export async function signUpController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = signUpSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { series: seriesId, email, password } = parsed.data;
  const seriesConfig = getSeries(seriesId);
  if (!seriesConfig || seriesConfig.status !== "open") {
    console.log(`[auth] signup ${maskEmail(email)} -> series-${seriesId}-closed`);
    return c.json(
      { ok: false, code: "series-closed", message: "This series is not accepting new accounts." },
      400,
    );
  }

  try {
    const user = await adminAuth.getUserByEmail(email);
    if (user.customClaims?.mustRotate === true) {
      return c.json({
        ok: false,
        code: "claim",
        message: "This email has a profile from the old directory. Reclaim it with an email link instead.",
      });
    }
  } catch (err: any) {
    if (err.code !== "auth/user-not-found") throw err;
    const legacy = await findLegacyByEmail(email);
    if (legacy) {
      return c.json({
        ok: false,
        code: "claim",
        message: "This email has a profile from the old directory. Reclaim it with an email link instead.",
      });
    }
  }

  const signUpRes = await postIdentityToolkit<{ idToken?: string; localId?: string }>(
    "accounts:signUp",
    { email, password, returnSecureToken: true },
  );

  if (!signUpRes.ok) {
    if (signUpRes.code.includes("EMAIL_EXISTS")) {
      return c.json({ ok: false, code: "exists", message: "An account already exists with this email." }, 409);
    }
    return c.json({ ok: false, code: "error", message: "Failed to create account." }, 500);
  }

  const { idToken } = signUpRes.data;
  if (!idToken) {
    return c.json({ ok: false, code: "error", message: "Failed to obtain auth token." }, 500);
  }

  await sendOobCode({
    requestType: "VERIFY_EMAIL",
    email,
    idToken,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
  }).catch((e) => console.error("[auth] signup verify-email send failed:", e));

  await createSession(c, idToken);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
}

export async function forgotPasswordController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = forgotPasswordSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: true }); // Anti-enumeration
  }

  const { email } = parsed.data;
  const isLimited = await checkRateLimit(`forgot:${email}`, 60);
  if (isLimited) {
    return c.json({ ok: true });
  }

  await sendOobCode({
    requestType: "PASSWORD_RESET",
    email,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/signin`,
  }).catch((e) => console.error("[auth] forgot send failed:", e));

  return c.json({ ok: true });
}

export async function sessionCheckController(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionValue = String(body.session ?? "");
  const viewer = sessionValue ? await verifySession(sessionValue) : null;
  return c.json(viewer ? { ok: true, viewer } : { ok: false });
}

export async function configController(c: Context) {
  return c.json({ google: isGoogleConfigured() });
}

export async function googleStartController(c: Context) {
  if (!isGoogleConfigured()) return c.json({ ok: false, code: "not-configured" }, 500);

  const redirectUri = c.req.query("redirectUri") || (await c.req.json().catch(() => ({}))).redirectUri;
  if (redirectUri) {
    return c.json({ ok: true, ...googleStart(redirectUri) });
  }

  const site = c.req.query("site") || env.PUBLIC_SITE_URL;
  const next = safeNext(c.req.query("next"));
  const callbackUrl = `${site.replace(/\/+$/, "")}/api/v1/auth/google/callback`;

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  setCookie(
    c,
    STATE_COOKIE,
    JSON.stringify({ state, verifier, next, redirectUri: callbackUrl, site }),
    {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_MAX_AGE_S,
    },
  );

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

export async function googleExchangeController(c: Context) {
  if (!isGoogleConfigured()) return c.json({ ok: false, code: "error" }, 500);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(b.code ?? "");
  const verifier = String(b.verifier ?? "");
  const redirectUri = String(b.redirectUri ?? "");

  if (!code || !verifier || !redirectUri) return c.json({ ok: false, code: "error" }, 400);

  try {
    return c.json(await googleSignIn(code, verifier, redirectUri));
  } catch (err) {
    console.error("[auth] google exchange failed:", err);
    return c.json({ ok: false, code: "error" }, 500);
  }
}
