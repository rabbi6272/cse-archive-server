import { Hono } from "hono";
import { claimStartSchema, claimOpenSchema, claimCompleteSchema } from "../schemas";
import {
  adminAuth,
  maskEmail,
  sendOobCode,
  signInWithOutboundLink,
  idTokenForUid,
} from "../firebase";
import { createSession } from "../session";
import { requireSession, type AuthContext } from "../middleware/requireSession";
import { checkRateLimit } from "../middleware/rateLimit";
import {
  findLegacyByEmail,
  findProfileByRoll,
  reserveRoll,
  releaseRoll,
  writeProfile,
  patchProfile,
  deleteProfile,
  setPrivateContact,
  removeLegacy,
} from "../repo/students.repo";
import { seriesFromRoll } from "../types/series";
import { env } from "../env";
import type { Profile } from "../types/Student";

export const claimRoutes = new Hono<AuthContext>();

claimRoutes.post("/start", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimStartSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: true });
  }

  const { email } = parsed.data;
  const isLimited = await checkRateLimit(`claim:${email}`, 60);
  if (isLimited) {
    console.log(`[auth] claim cooldown ${maskEmail(email)} (resend dropped)`);
    return c.json({ ok: true });
  }

  // 1. Check if user is pending activation (seeded account on pincode)
  let pendingActivation = false;
  try {
    const user = await adminAuth.getUserByEmail(email);
    if (user.customClaims?.mustRotate === true) {
      pendingActivation = true;
    } else {
      // User is already activated
      console.log(`[auth] claim start ${maskEmail(email)} -> auth-exists`);
      return c.json({ ok: true });
    }
  } catch (err: any) {
    if (err.code !== "auth/user-not-found") throw err;
  }

  // 2. If not pending activation, check legacy profile eligibility
  if (!pendingActivation) {
    const legacy = await findLegacyByEmail(email);
    if (!legacy) {
      console.log(`[auth] claim start ${maskEmail(email)} -> no-legacy`);
      return c.json({ ok: true });
    }

    const series = seriesFromRoll(legacy.roll);
    if (!series) {
      console.log(`[auth] claim start ${maskEmail(email)} -> bad-series`);
      return c.json({ ok: true });
    }

    const heldUid = await findProfileByRoll(legacy.roll);
    if (heldUid) {
      console.log(`[auth] claim start ${maskEmail(email)} -> roll-held`);
      return c.json({ ok: true });
    }
  }

  // 3. Send magic link
  const lineReason = pendingActivation ? "eligible (activate)" : "eligible";
  console.log(`[auth] claim start ${maskEmail(email)} -> ${lineReason}`);

  await sendOobCode({
    requestType: "EMAIL_SIGNIN",
    email,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/claim`,
    canHandleCodeInApp: true,
  });

  return c.json({ ok: true });
});

claimRoutes.post("/open", async (c) => {
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimOpenSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: "Invalid claim link parameters." },
      400,
    );
  }

  const { oobCode, email: queryEmail } = parsed.data;
  const targetEmail = queryEmail ? queryEmail.trim().toLowerCase() : "";

  // Exchange magic link for idToken (creates Auth user if none exists)
  const exchange = await signInWithOutboundLink(oobCode, targetEmail);
  if (!exchange.ok) {
    console.log(`[auth] claim link -> exchange-failed code=${exchange.code}`);
    return c.json(
      { ok: false, code: "invalid", message: "Invalid or expired claim link." },
      400,
    );
  }

  const { idToken } = exchange.data;
  if (!idToken) {
    return c.json(
      { ok: false, code: "invalid", message: "Invalid claim response." },
      400,
    );
  }
  const decoded = await adminAuth.verifyIdToken(idToken);
  const email = (decoded.email ?? targetEmail).trim().toLowerCase();

  if (targetEmail && decoded.email && decoded.email.toLowerCase() !== targetEmail) {
    console.log(`[auth] claim link ${maskEmail(email)} -> email-mismatch`);
    return c.json(
      { ok: false, code: "email-mismatch", message: "Claim link was opened with a mismatched email." },
      400,
    );
  }

  // Branch A: Seeded account activation
  if (decoded.mustRotate === true) {
    await createSession(c, idToken);
    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] claim link ${maskEmail(email)} -> ok mode=activate`);
    return c.json({
      ok: true,
      mode: "activate" as const,
      needsSection: decoded.needsSection === true,
    });
  }

  // Branch B: Legacy profile claim
  const legacy = await findLegacyByEmail(email);
  if (!legacy) {
    console.log(`[auth] claim link ${maskEmail(email)} -> no-legacy`);
    return c.json({ ok: false, code: "no-legacy", message: "Legacy profile not found." }, 404);
  }

  const heldUid = await findProfileByRoll(legacy.roll);
  if (heldUid && heldUid !== decoded.uid) {
    console.log(`[auth] claim link ${maskEmail(email)} -> roll-held`);
    return c.json({ ok: false, code: "roll-held", message: "This roll number has already been claimed." }, 409);
  }

  await createSession(c, idToken);
  c.header("Cache-Control", "private, no-store");
  console.log(`[auth] claim link ${maskEmail(email)} -> ok mode=claim`);

  return c.json({
    ok: true,
    mode: "claim" as const,
    needsSection: !legacy.sec,
  });
});

claimRoutes.post("/complete", requireSession, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimCompleteSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { password, sec } = parsed.data;

  // Branch A: Activation
  if (session.mustRotate) {
    try {
      if (sec) {
        await patchProfile(session.uid, { sec });
      }

      await adminAuth.updateUser(session.uid, { password, emailVerified: true });
      await adminAuth.setCustomUserClaims(session.uid, null);
      await adminAuth.revokeRefreshTokens(session.uid);

      // Best effort removal of legacy record
      const legacy = await findLegacyByEmail(session.email);
      if (legacy) {
        await removeLegacy(legacy.legacyId).catch(() => {});
      }

      // Mint a fresh session without mustRotate
      const freshToken = await idTokenForUid(session.uid);
      if (freshToken) {
        await createSession(c, freshToken);
      }

      c.header("Cache-Control", "private, no-store");
      console.log(`[auth] claim complete ${maskEmail(session.email)} -> ok (activated)`);
      return c.json({ ok: true });
    } catch (err) {
      console.error(`[auth] claim complete activation failed for ${maskEmail(session.email)}:`, err);
      return c.json({ ok: false, code: "error", message: "Failed to complete account activation." }, 500);
    }
  }

  // Branch B: Normal legacy profile claim
  const legacy = await findLegacyByEmail(session.email);
  if (!legacy) {
    console.log(`[auth] claim complete ${maskEmail(session.email)} -> no-legacy`);
    return c.json({ ok: false, code: "no-legacy", message: "No legacy profile found to claim." }, 404);
  }

  const series = seriesFromRoll(legacy.roll);
  if (!series) {
    console.log(`[auth] claim complete ${maskEmail(session.email)} -> bad-series`);
    return c.json({ ok: false, code: "bad-series", message: "Invalid roll format." }, 400);
  }

  const resolvedSection = (sec || legacy.sec || series.sectionFromRoll(legacy.roll) || "a") as any;

  // Race-safe roll reservation
  const reserved = await reserveRoll(legacy.roll, session.uid);
  if (!reserved) {
    console.log(`[auth] claim complete ${maskEmail(session.email)} -> roll-held`);
    return c.json({ ok: false, code: "roll-held", message: "This roll number has already been claimed." }, 409);
  }

  const now = Date.now();
  const profile: Profile = {
    id: session.uid,
    fullName: legacy.fullName,
    nickname: legacy.nickname,
    email: session.email,
    roll: legacy.roll,
    series: series.id,
    sec: resolvedSection,
    bloodGroup: legacy.bloodGroup,
    bio: legacy.bio,
    hobby: legacy.hobby,
    fbProfile: legacy.fbProfile,
    profilePicture: legacy.profilePicture,
    published: true,
    createdAt: legacy.createdAt || now,
    updatedAt: now,
    claimedAt: now,
  };

  try {
    await writeProfile(session.uid, profile);
    await setPrivateContact(session.uid, { mobileNumber: legacy.mobileNumber });
    await adminAuth.updateUser(session.uid, { password, emailVerified: true });
    await removeLegacy(legacy.legacyId);

    const freshToken = await idTokenForUid(session.uid);
    if (freshToken) {
      await createSession(c, freshToken);
    }

    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] claim complete ${maskEmail(session.email)} -> ok uid=${session.uid} roll=${legacy.roll}`);
    return c.json({ ok: true });
  } catch (err) {
    console.error(`[auth] claim complete ${maskEmail(session.email)} -> failure, rolling back:`, err);
    // Compensating rollback
    await releaseRoll(legacy.roll, session.uid).catch(() => {});
    await deleteProfile(session.uid).catch(() => {});
    return c.json({ ok: false, code: "error", message: "Failed to claim profile." }, 500);
  }
});
