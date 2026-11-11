import { adminAuth, freshEmailVerified, verifyPassword, maskEmail } from "../../config/firebase";
import {
  findProfileById,
  patchProfile,
  deleteProfile,
  reserveRoll,
  releaseRoll,
  getPrivateContact,
  setPrivateContact,
} from "../profile/profile.services";
import { seriesFromRoll } from "../profile/profile.types";
import type { Session } from "../auth/auth.session";

export async function getViewerStatus(session: Session | null) {
  if (!session) return { user: null };

  const emailVerified = session.emailVerified || (await freshEmailVerified(session.uid));
  let hasProfile = false;
  try {
    const profile = await findProfileById(session.uid);
    hasProfile = Boolean(profile);
  } catch (err) {
    console.error("[me] Error checking profile existence:", err);
  }

  return {
    user: {
      uid: session.uid,
      email: session.email,
      emailVerified,
      mustRotate: session.mustRotate,
      needsSection: session.needsSection,
      hasProfile,
    },
  };
}

export type UpdateProfileResult =
  | { ok: true; profile: any }
  | { ok: false; code: "not-found" | "bad-series" | "roll-held"; message: string };

export async function updateOwnProfile(
  uid: string,
  patch: any,
): Promise<UpdateProfileResult> {
  const current = await findProfileById(uid);
  if (!current) {
    return { ok: false, code: "not-found", message: "Profile not found." };
  }

  if (patch.roll && patch.roll !== current.roll) {
    const seriesConfig = seriesFromRoll(patch.roll);
    if (!seriesConfig) {
      return { ok: false, code: "bad-series", message: "Roll does not match registered series." };
    }

    const reserved = await reserveRoll(patch.roll, uid);
    if (!reserved) {
      return { ok: false, code: "roll-held", message: "Roll is already held by another user." };
    }
    await releaseRoll(current.roll, uid).catch(() => {});
  }

  await patchProfile(uid, patch);
  const updated = await findProfileById(uid);
  return { ok: true, profile: updated };
}

export async function deleteOwnAccount(
  uid: string,
  email: string,
  password: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const verified = await verifyPassword(email, password);
  if (!verified.ok) {
    console.log(`[auth] delete-account ${maskEmail(email)} -> bad-password`);
    return { ok: false, code: "bad-password", message: "Password is incorrect." };
  }

  try {
    const profile = await findProfileById(uid);
    if (profile?.roll) {
      await releaseRoll(profile.roll, uid).catch(() => {});
    }
    await deleteProfile(uid);
    await adminAuth.deleteUser(uid);
    console.log(`[auth] delete-account ${maskEmail(email)} -> ok uid=${uid}`);
    return { ok: true };
  } catch (err) {
    console.error(`[auth] delete-account ${maskEmail(email)} -> error:`, err);
    return { ok: false, code: "error", message: "Failed to delete account." };
  }
}

export { getPrivateContact, setPrivateContact, findProfileById };
