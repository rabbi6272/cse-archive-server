import type { Context } from "hono";
import type { AuthContext } from "../../middleware/requireSession";
import { readSession, clearSession } from "../auth/auth.session";
import {
  getViewerStatus,
  findProfileById,
  updateOwnProfile,
  getPrivateContact,
  setPrivateContact,
  deleteOwnAccount,
} from "./me.services";
import { updateProfileSchema, updateContactSchema, deleteAccountSchema } from "./me.types";

export async function getViewerController(c: Context) {
  c.header("Cache-Control", "private, no-store");
  const session = await readSession(c);
  const result = await getViewerStatus(session);
  return c.json(result);
}

export async function getOwnProfileController(c: Context<AuthContext>) {
  const session = c.get("session");
  const profile = await findProfileById(session.uid);
  if (!profile) {
    return c.json({ ok: false, code: "not-found", message: "Profile not found." }, 404);
  }
  return c.json({ ok: true, profile });
}

export async function updateOwnProfileController(c: Context<AuthContext>) {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = updateProfileSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const result = await updateOwnProfile(session.uid, parsed.data);
  if (!result.ok) {
    return c.json(
      { ok: false, code: result.code, message: result.message },
      result.code === "not-found" ? 404 : result.code === "roll-held" ? 409 : 400,
    );
  }
  return c.json({ ok: true, profile: result.profile });
}

export async function getOwnContactController(c: Context<AuthContext>) {
  const session = c.get("session");
  const contact = await getPrivateContact(session.uid);
  return c.json({ ok: true, contact: contact ?? { mobileNumber: "" } });
}

export async function updateOwnContactController(c: Context<AuthContext>) {
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
}

export async function deleteOwnAccountController(c: Context<AuthContext>) {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = deleteAccountSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: false, code: "invalid", message: "Password is required." }, 400);
  }

  const result = await deleteOwnAccount(session.uid, session.email, parsed.data.password);
  if (!result.ok) {
    return c.json({ ok: false, code: result.code, message: result.message }, result.code === "bad-password" ? 400 : 500);
  }

  clearSession(c);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
}
