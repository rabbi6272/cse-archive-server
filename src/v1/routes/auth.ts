import { Hono } from "hono";
import {
  loginSchema,
  signUpSchema,
  claimStartSchema,
  changePasswordSchema,
} from "../schemas";
import {
  adminAuth,
  maskEmail,
  sendOobCode,
  verifyPassword,
  postIdentityToolkit,
  idTokenForUid,
  freshEmailVerified,
} from "../firebase";
import { createSession, clearSession } from "../session";
import { requireSession, type AuthContext } from "../middleware/requireSession";
import { checkRateLimit } from "../middleware/rateLimit";
import { findLegacyByEmail } from "../repo/students.repo";
import { getSeries } from "../types/series";
import { env } from "../env";

export const authRoutes = new Hono<AuthContext>();

authRoutes.post("/signin", async (c) => {
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
    if (verifyResult.reason === "invalid") {
      return c.json(
        { ok: false, code: "invalid", message: "Check your email and password." },
        401,
      );
    }
    return c.json(
      { ok: false, code: "unavailable", message: "Authentication service temporarily unavailable." },
      503,
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

    await createSession(c, idToken);
    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] signin ${maskEmail(email)} -> ok (uid: ${decoded.uid})`);

    return c.json({
      ok: true,
      email: decoded.email ?? email,
      emailVerified,
    });
  } catch (err) {
    console.error(`[auth] signin ${maskEmail(email)} -> error verifying token:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to establish session." }, 500);
  }
});

authRoutes.post("/signout", async (c) => {
  clearSession(c);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
});

authRoutes.post("/signup", async (c) => {
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

  // Check if this is an old-directory email
  try {
    const user = await adminAuth.getUserByEmail(email);
    if (user.customClaims?.mustRotate === true) {
      console.log(`[auth] signup ${maskEmail(email)} -> old-directory (sent to claim)`);
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
      console.log(`[auth] signup ${maskEmail(email)} -> old-directory legacy (sent to claim)`);
      return c.json({
        ok: false,
        code: "claim",
        message: "This email has a profile from the old directory. Reclaim it with an email link instead.",
      });
    }
  }

  // Register account via Identity Toolkit
  const signUpRes = await postIdentityToolkit<{ idToken?: string; localId?: string }>(
    "accounts:signUp",
    {
      email,
      password,
      returnSecureToken: true,
    },
  );

  if (!signUpRes.ok) {
    if (signUpRes.code.includes("EMAIL_EXISTS")) {
      console.log(`[auth] signup ${maskEmail(email)} -> exists`);
      return c.json({ ok: false, code: "exists", message: "An account already exists with this email." }, 409);
    }
    console.error(`[auth] signup ${maskEmail(email)} -> rejected:`, signUpRes.code);
    return c.json({ ok: false, code: "error", message: "Failed to create account." }, 500);
  }

  const { idToken } = signUpRes.data;
  if (!idToken) {
    return c.json({ ok: false, code: "error", message: "Failed to obtain auth token." }, 500);
  }

  // Send verification email
  await sendOobCode({
    requestType: "VERIFY_EMAIL",
    email,
    idToken,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
  }).catch((e) => console.error("[auth] signup verify-email send failed:", e));

  // Establish session
  await createSession(c, idToken);
  c.header("Cache-Control", "private, no-store");
  console.log(`[auth] signup ${maskEmail(email)} -> ok`);

  return c.json({ ok: true });
});

authRoutes.post("/forgot", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimStartSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: true });
  }

  const { email } = parsed.data;
  const isLimited = await checkRateLimit(`forgot:${email}`, 60);
  if (isLimited) {
    console.log(`[auth] forgot ${maskEmail(email)} -> rate-limited (60s cooldown)`);
    return c.json({ ok: true });
  }

  const res = await sendOobCode({
    requestType: "PASSWORD_RESET",
    email,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/signin`,
  });

  if (!res.ok) {
    console.log(`[auth] forgot ${maskEmail(email)} -> ${res.code}`);
  } else {
    console.log(`[auth] forgot ${maskEmail(email)} -> sent`);
  }

  return c.json({ ok: true });
});

authRoutes.post("/password/change", requireSession, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = changePasswordSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { currentPassword, newPassword } = parsed.data;
  const verified = await verifyPassword(session.email, currentPassword);
  if (!verified.ok) {
    console.log(`[auth] change-password ${maskEmail(session.email)} -> bad-current-password`);
    return c.json({ ok: false, code: "bad-password", message: "Current password is incorrect." }, 400);
  }

  try {
    await adminAuth.updateUser(session.uid, { password: newPassword });
    await adminAuth.revokeRefreshTokens(session.uid);
    clearSession(c);
    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] change-password ${maskEmail(session.email)} -> ok`);
    return c.json({ ok: true });
  } catch (err) {
    console.error(`[auth] change-password ${maskEmail(session.email)} -> error:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to update password." }, 500);
  }
});

authRoutes.post("/verify/resend", requireSession, async (c) => {
  const session = c.get("session");
  const isVerified = await freshEmailVerified(session.uid);
  if (isVerified) {
    console.log(`[auth] verify-resend ${maskEmail(session.email)} -> already-verified`);
    return c.json({ ok: true, message: "Email is already verified." });
  }

  const idToken = await idTokenForUid(session.uid);
  if (!idToken) {
    return c.json({ ok: false, code: "error", message: "Failed to issue verification token." }, 500);
  }

  await sendOobCode({
    requestType: "VERIFY_EMAIL",
    email: session.email,
    idToken,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/create`,
  });

  console.log(`[auth] verify-resend ${maskEmail(session.email)} -> ok`);
  return c.json({ ok: true });
});
