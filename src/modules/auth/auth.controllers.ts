import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { idTokenForUid, maskEmail, verifyPassword, sendOobCode } from "../../config/firebase";
import { env } from "../../config/env";
import { checkRateLimit, isLocked, recordFailure, clearFailures, clientIp } from "../../middleware/rateLimit";
import {
  setSessionCookie,
  clearSession,
  forgetSession,
  readSession,
  isGoogleConfigured,
  isAllowedRedirectUri,
  loadViewer,
  finishSignIn,
  verifySession,
  signUp,
  googleStart,
  googleSignIn,
} from "./auth.services";
import {
  loginSchema,
  signUpSchema,
  forgotPasswordSchema,
  googleStartSchema,
  googleExchangeSchema,
  type AuthFailure,
  type AuthFailureCode,
} from "./auth.types";

// Sign-in brute-force limits
const EMAIL_MAX_FAILURES = 5;
const IP_MAX_FAILURES = 20; // higher: Next.js server actions may share egress IPs
const FAILURE_WINDOW_S = 15 * 60;

const STATUS_BY_CODE: Partial<Record<AuthFailureCode, ContentfulStatusCode>> = {
  invalid: 401,
  rate_limited: 429,
  unavailable: 503,
  error: 500,
  exists: 409,
  "roll-held": 409,
  "series-closed": 400,
  "bad-series": 400,
  "no-account": 404,
  // "claim" stays 200 so callers can branch on the code without treating it as an error
};

function failure(c: Context, f: AuthFailure) {
  return c.json(f, STATUS_BY_CODE[f.code] ?? 200);
}

function invalidInput(c: Context, message?: string) {
  return c.json({ ok: false, code: "invalid", message: message ?? "Invalid input" }, 400);
}

// ─── Password sign-in ────────────────────────────────────────

export async function signInController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) return invalidInput(c, parsed.error.issues[0]?.message);

  const { email, password } = parsed.data;
  const ip = clientIp((n) => c.req.header(n));
  const emailKey = `signin:${email}`;
  const ipKey = `signin-ip:${ip}`;

  if ((await isLocked(emailKey, EMAIL_MAX_FAILURES)) || (await isLocked(ipKey, IP_MAX_FAILURES))) {
    console.log(`[auth] signin ${maskEmail(email)} -> rate-limited`);
    return failure(c, {
      ok: false,
      code: "rate_limited",
      message: "Too many failed attempts. Try again in 15 minutes or reset your password.",
    });
  }

  const verifyResult = await verifyPassword(email, password);
  if (!verifyResult.ok) {
    console.log(`[auth] signin ${maskEmail(email)} -> ${verifyResult.reason}`);
    if (verifyResult.reason === "invalid") {
      await Promise.all([
        recordFailure(emailKey, EMAIL_MAX_FAILURES, FAILURE_WINDOW_S),
        recordFailure(ipKey, IP_MAX_FAILURES, FAILURE_WINDOW_S),
      ]);
      return failure(c, { ok: false, code: "invalid", message: "Check your email and password." });
    }
    return failure(c, {
      ok: false,
      code: "unavailable",
      message: "Authentication service temporarily unavailable.",
    });
  }

  try {
    const result = await finishSignIn(verifyResult.idToken);
    if (!result.ok) {
      console.log(`[auth] signin ${maskEmail(email)} -> ${result.code}`);
      return failure(c, result);
    }

    await clearFailures(emailKey, ipKey);

    if (!result.emailVerified && !(await checkRateLimit(`verify:${email}`, 5 * 60))) {
      console.log(`[auth] signin ${maskEmail(email)} -> unverified (resending link)`);
      await sendOobCode({
        requestType: "VERIFY_EMAIL",
        email,
        idToken: verifyResult.idToken,
        continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
      }).catch((e) => console.error("[auth] auto-resend verification failed:", e));
    }

    setSessionCookie(c, result.session);
    console.log(`[auth] signin ${maskEmail(email)} -> ok (uid: ${result.viewer.uid}, role: ${result.viewer.role})`);
    return c.json(result);
  } catch (err) {
    console.error(`[auth] signin ${maskEmail(email)} -> error establishing session:`, err);
    return failure(c, { ok: false, code: "error", message: "Failed to establish session." });
  }
}

export async function signOutController(c: Context) {
  // Clears this session only. (Revoking refresh tokens would sign the user out
  // of every device and both client sites.)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.session === "string") forgetSession(body.session); // server-to-server sign-out
  clearSession(c);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
}

// ─── Sign-up ─────────────────────────────────────────────────

export async function signUpController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = signUpSchema.safeParse(json);
  if (!parsed.success) return invalidInput(c, parsed.error.issues[0]?.message);

  const ip = clientIp((n) => c.req.header(n));
  if (await checkRateLimit(`signup-ip:${ip}`, 10)) {
    return failure(c, { ok: false, code: "rate_limited", message: "Please wait a moment and try again." });
  }

  try {
    const result = await signUp(parsed.data);
    if (!result.ok) return failure(c, result);
    setSessionCookie(c, result.session);
    return c.json(result);
  } catch (err) {
    console.error(`[auth] signup ${maskEmail(parsed.data.email)} -> error:`, err);
    return failure(c, { ok: false, code: "error", message: "Failed to create account." });
  }
}

// ─── Password reset ──────────────────────────────────────────

export async function forgotPasswordController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = forgotPasswordSchema.safeParse(json);
  if (!parsed.success) return c.json({ ok: true }); // Anti-enumeration

  const { email } = parsed.data;
  if (await checkRateLimit(`forgot:${email}`, 60)) return c.json({ ok: true });

  await sendOobCode({
    requestType: "PASSWORD_RESET",
    email,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/signin`,
  }).catch((e) => console.error("[auth] forgot send failed:", e));

  return c.json({ ok: true });
}

// ─── Email verification ──────────────────────────────────────

/** Re-sends the VERIFY_EMAIL link for the signed-in account (60s cooldown). */
export async function resendVerificationController(c: Context) {
  const session = await readSession(c);
  if (!session) return c.json({ ok: false, code: "unauthenticated", message: "Sign in again to continue." }, 401);
  if (session.emailVerified) return c.json({ ok: true, alreadyVerified: true });

  if (await checkRateLimit(`verify:${session.email}`, 60)) {
    return failure(c, { ok: false, code: "rate_limited", message: "Please wait a minute before requesting another email." });
  }

  try {
    const idToken = await idTokenForUid(session.uid);
    const sent = await sendOobCode({
      requestType: "VERIFY_EMAIL",
      email: session.email,
      idToken,
      continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
    });
    if (!sent.ok) return failure(c, { ok: false, code: "unavailable", message: "Could not send the email. Try again." });
    return c.json({ ok: true });
  } catch (err) {
    console.error(`[auth] resend verification ${maskEmail(session.email)} failed:`, err);
    return failure(c, { ok: false, code: "error", message: "Could not send the email. Try again." });
  }
}

// ─── Session checks ──────────────────────────────────────────

export async function sessionCheckController(c: Context) {
  c.header("Cache-Control", "private, no-store");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const idToken = typeof body.idToken === "string" ? body.idToken : undefined;
  const sessionValue = typeof body.session === "string" ? body.session : undefined;

  // 1. Legacy: client-side Firebase Auth ID token exchange.
  // TODO(phase-4): remove once no client sends browser ID tokens.
  if (idToken) {
    try {
      const result = await finishSignIn(idToken);
      if (!result.ok) return failure(c, result);
      setSessionCookie(c, result.session);
      return c.json(result);
    } catch (err) {
      console.error("[auth] session creation from idToken failed:", err);
      return c.json({ ok: false, code: "invalid-token", message: "Invalid ID token." }, 401);
    }
  }

  // 2. Session cookie value passed in the body (server-to-server)
  if (sessionValue) {
    const viewer = await verifySession(sessionValue);
    return c.json(viewer ? { ok: true, viewer } : { ok: false });
  }

  // 3. Session cookie / Bearer on the request itself
  const currentSession = await readSession(c);
  if (currentSession) {
    const viewer = await loadViewer(currentSession);
    return c.json({
      ok: true,
      viewer,
      email: currentSession.email,
      emailVerified: currentSession.emailVerified,
    });
  }

  return c.json({ ok: false });
}

// ─── Google OAuth (PKCE) ─────────────────────────────────────

export async function configController(c: Context) {
  return c.json({ google: isGoogleConfigured() });
}

/**
 * Returns `{ url, state, verifier }` for the given client callback.
 * The Next.js client stores state + verifier in its own short-lived cookie,
 * redirects to `url`, and later calls /google/exchange from its callback route.
 */
export async function googleStartController(c: Context) {
  if (!isGoogleConfigured()) return c.json({ ok: false, code: "not-configured" }, 503);

  const fromBody = c.req.method === "POST" ? await c.req.json().catch(() => ({})) : {};
  const parsed = googleStartSchema.safeParse({
    redirectUri: c.req.query("redirectUri") ?? (fromBody as Record<string, unknown>).redirectUri,
  });
  if (!parsed.success) return invalidInput(c, "redirectUri is required");

  if (!isAllowedRedirectUri(parsed.data.redirectUri)) {
    console.warn(`[auth] google start -> rejected redirectUri ${parsed.data.redirectUri}`);
    return c.json({ ok: false, code: "bad-redirect", message: "redirectUri is not allowed." }, 400);
  }

  return c.json({ ok: true, ...googleStart(parsed.data.redirectUri) });
}

export async function googleExchangeController(c: Context) {
  if (!isGoogleConfigured()) return c.json({ ok: false, code: "not-configured" }, 503);

  const parsed = googleExchangeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return invalidInput(c);

  const { code, verifier, redirectUri } = parsed.data;
  if (!isAllowedRedirectUri(redirectUri)) {
    return c.json({ ok: false, code: "bad-redirect", message: "redirectUri is not allowed." }, 400);
  }

  try {
    const result = await googleSignIn(code, verifier, redirectUri);
    if (!result.ok) return failure(c, result);
    setSessionCookie(c, result.session);
    return c.json(result);
  } catch (err) {
    console.error("[auth] google exchange failed:", err);
    return failure(c, { ok: false, code: "error", message: "Google sign-in failed." });
  }
}
