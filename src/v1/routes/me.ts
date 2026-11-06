import { Hono } from "hono";
import { readSession, clearSession } from "../session";
import { freshEmailVerified, verifyPassword, adminAuth, maskEmail } from "../firebase";
import {
  findProfileById,
  patchProfile,
  getPrivateContact,
  setPrivateContact,
  deleteProfile,
  reserveRoll,
  releaseRoll,
} from "../repo/students.repo";
import { requireSession, type AuthContext } from "../middleware/requireSession";
import { updateProfileSchema, updateContactSchema, deleteAccountSchema } from "../schemas";
import { seriesFromRoll } from "../types/series";

export const meRoutes = new Hono<AuthContext>();

// GET /me - Session viewer
meRoutes.get("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await readSession(c);

  if (!session) {
    return c.json({ user: null });
  }

  const emailVerified = session.emailVerified || (await freshEmailVerified(session.uid));
  let hasProfile = false;
  try {
    const profile = await findProfileById(session.uid);
    hasProfile = Boolean(profile);
  } catch (err) {
    console.error("[me] Error checking profile existence:", err);
  }

  return c.json({
    user: {
      uid: session.uid,
      email: session.email,
      emailVerified,
      mustRotate: session.mustRotate,
      needsSection: session.needsSection,
      hasProfile,
    },
  });
});

// GET /me/profile - View own profile
meRoutes.get("/profile", requireSession, async (c) => {
  const session = c.get("session");
  const profile = await findProfileById(session.uid);
  if (!profile) {
    return c.json({ ok: false, code: "not-found", message: "Profile not found." }, 404);
  }
  return c.json({ ok: true, profile });
});

// PUT /me/profile - Update own profile
meRoutes.put("/profile", requireSession, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = updateProfileSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const current = await findProfileById(session.uid);
  if (!current) {
    return c.json({ ok: false, code: "not-found", message: "Profile not found." }, 404);
  }

  const patch = parsed.data;

  // Handle roll change if provided
  if (patch.roll && patch.roll !== current.roll) {
    const seriesConfig = seriesFromRoll(patch.roll);
    if (!seriesConfig) {
      return c.json({ ok: false, code: "bad-series", message: "Roll does not match registered series." }, 400);
    }

    const reserved = await reserveRoll(patch.roll, session.uid);
    if (!reserved) {
      return c.json({ ok: false, code: "roll-held", message: "Roll is already held by another user." }, 409);
    }
    // Release previous roll
    await releaseRoll(current.roll, session.uid).catch(() => {});
  }

  await patchProfile(session.uid, patch);
  const updated = await findProfileById(session.uid);
  return c.json({ ok: true, profile: updated });
});

// GET /me/contact - View own private contact
meRoutes.get("/contact", requireSession, async (c) => {
  const session = c.get("session");
  const contact = await getPrivateContact(session.uid);
  return c.json({ ok: true, contact: contact ?? { mobileNumber: "" } });
});

// PUT /me/contact - Update own private contact
meRoutes.put("/contact", requireSession, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = updateContactSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  await setPrivateContact(session.uid, parsed.data);
  return c.json({ ok: true, contact: parsed.data });
});

// DELETE /me/account (or mapped from /account)
meRoutes.delete("/account", requireSession, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = deleteAccountSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: false, code: "invalid", message: "Password is required." }, 400);
  }

  const verified = await verifyPassword(session.email, parsed.data.password);
  if (!verified.ok) {
    console.log(`[auth] delete-account ${maskEmail(session.email)} -> bad-password`);
    return c.json({ ok: false, code: "bad-password", message: "Password is incorrect." }, 400);
  }

  try {
    await deleteProfile(session.uid);
    await adminAuth.deleteUser(session.uid);
    clearSession(c);
    c.header("Cache-Control", "private, no-store");
    console.log(`[auth] delete-account ${maskEmail(session.email)} -> ok uid=${session.uid}`);
    return c.json({ ok: true });
  } catch (err) {
    console.error(`[auth] delete-account ${maskEmail(session.email)} -> error:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to delete account." }, 500);
  }
});
