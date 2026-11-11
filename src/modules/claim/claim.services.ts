import { adminAuth, maskEmail, sendOobCode, signInWithOutboundLink, idTokenForUid } from "../../config/firebase";
import { env } from "../../config/env";
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
  countUnclaimed,
} from "../profile/profile.services";
import { seriesFromRoll, type Profile, type Section } from "../profile/profile.types";
import type { Session } from "../auth/auth.session";

export async function processClaimStart(email: string): Promise<void> {
  let pendingActivation = false;
  try {
    const user = await adminAuth.getUserByEmail(email);
    if (user.customClaims?.mustRotate === true) {
      pendingActivation = true;
    } else {
      console.log(`[auth] claim start ${maskEmail(email)} -> auth-exists`);
      return; // Already activated
    }
  } catch (err: any) {
    if (err.code !== "auth/user-not-found") throw err;
  }

  if (!pendingActivation) {
    const legacy = await findLegacyByEmail(email);
    if (!legacy) {
      console.log(`[auth] claim start ${maskEmail(email)} -> no-legacy`);
      return;
    }

    const series = seriesFromRoll(legacy.roll);
    if (!series) {
      console.log(`[auth] claim start ${maskEmail(email)} -> bad-series`);
      return;
    }

    const heldUid = await findProfileByRoll(legacy.roll);
    if (heldUid) {
      console.log(`[auth] claim start ${maskEmail(email)} -> roll-held`);
      return;
    }
  }

  const lineReason = pendingActivation ? "eligible (activate)" : "eligible";
  console.log(`[auth] claim start ${maskEmail(email)} -> ${lineReason}`);

  await sendOobCode({
    requestType: "EMAIL_SIGNIN",
    email,
    continueUrl: `${env.PUBLIC_SITE_URL}/profiles/claim`,
    canHandleCodeInApp: true,
  });
}

export type ClaimOpenResult =
  | { ok: true; idToken: string; mode: "activate" | "claim"; needsSection: boolean }
  | { ok: false; code: "invalid" | "email-mismatch" | "no-legacy" | "roll-held"; message: string };

export async function processClaimOpen(
  oobCode: string,
  targetEmail?: string,
): Promise<ClaimOpenResult> {
  const normTarget = targetEmail ? targetEmail.trim().toLowerCase() : "";
  const exchange = await signInWithOutboundLink(oobCode, normTarget);
  if (!exchange.ok || !exchange.data.idToken) {
    console.log(`[auth] claim link -> exchange-failed`);
    return { ok: false, code: "invalid", message: "Invalid or expired claim link." };
  }

  const { idToken } = exchange.data;
  const decoded = await adminAuth.verifyIdToken(idToken);
  const email = (decoded.email ?? normTarget).trim().toLowerCase();

  if (normTarget && decoded.email && decoded.email.toLowerCase() !== normTarget) {
    console.log(`[auth] claim link ${maskEmail(email)} -> email-mismatch`);
    return { ok: false, code: "email-mismatch", message: "Claim link was opened with a mismatched email." };
  }

  if (decoded.mustRotate === true) {
    console.log(`[auth] claim link ${maskEmail(email)} -> ok mode=activate`);
    return {
      ok: true,
      idToken,
      mode: "activate",
      needsSection: decoded.needsSection === true,
    };
  }

  const legacy = await findLegacyByEmail(email);
  if (!legacy) {
    console.log(`[auth] claim link ${maskEmail(email)} -> no-legacy`);
    return { ok: false, code: "no-legacy", message: "Legacy profile not found." };
  }

  const heldUid = await findProfileByRoll(legacy.roll);
  if (heldUid && heldUid !== decoded.uid) {
    console.log(`[auth] claim link ${maskEmail(email)} -> roll-held`);
    return { ok: false, code: "roll-held", message: "This roll number has already been claimed." };
  }

  console.log(`[auth] claim link ${maskEmail(email)} -> ok mode=claim`);
  return {
    ok: true,
    idToken,
    mode: "claim",
    needsSection: !legacy.sec,
  };
}

export type ClaimCompleteResult =
  | { ok: true; freshToken: string | null }
  | { ok: false; code: "no-legacy" | "bad-series" | "roll-held" | "error"; message: string };

export async function processClaimComplete(
  session: Session,
  password: string,
  sec?: Section,
): Promise<ClaimCompleteResult> {
  if (session.mustRotate) {
    try {
      if (sec) {
        await patchProfile(session.uid, { sec });
      }

      await adminAuth.updateUser(session.uid, { password, emailVerified: true });
      await adminAuth.setCustomUserClaims(session.uid, null);
      await adminAuth.revokeRefreshTokens(session.uid);

      await removeLegacy(session.email).catch(() => {});
      const freshToken = await idTokenForUid(session.uid).catch(() => null);

      console.log(`[auth] claim complete ${maskEmail(session.email)} -> ok (activated)`);
      return { ok: true, freshToken };
    } catch (err) {
      console.error(`[auth] claim complete activation failed for ${maskEmail(session.email)}:`, err);
      return { ok: false, code: "error", message: "Failed to complete account activation." };
    }
  }

  const legacy = await findLegacyByEmail(session.email);
  if (!legacy) {
    return { ok: false, code: "no-legacy", message: "No legacy profile found to claim." };
  }

  const series = seriesFromRoll(legacy.roll);
  if (!series) {
    return { ok: false, code: "bad-series", message: "Invalid roll format." };
  }

  const resolvedSection = sec || legacy.sec || "a";

  const reserved = await reserveRoll(legacy.roll, session.uid);
  if (!reserved) {
    return { ok: false, code: "roll-held", message: "This roll number has already been claimed." };
  }

  const now = Date.now();
  const profile: Profile = {
    id: session.uid,
    fullName: legacy.fullName,
    nickname: legacy.nickname,
    email: session.email,
    roll: legacy.roll,
    series: series.id,
    sec: resolvedSection as Section,
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
    await removeLegacy(session.email);

    const freshToken = await idTokenForUid(session.uid).catch(() => null);
    console.log(`[auth] claim complete ${maskEmail(session.email)} -> ok uid=${session.uid}`);
    return { ok: true, freshToken };
  } catch (err) {
    console.error(`[auth] claim complete failure, rolling back:`, err);
    await releaseRoll(legacy.roll, session.uid).catch(() => {});
    await deleteProfile(session.uid).catch(() => {});
    return { ok: false, code: "error", message: "Failed to claim profile." };
  }
}

export { countUnclaimed };
