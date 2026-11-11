import type { Context } from "hono";
import type { AuthContext } from "../../middleware/requireSession";
import {
  isAuthorizedAdmin,
  sendBroadcastEmail,
  setCustomClaims,
  reserveRoll,
  releaseRoll,
} from "./admin.services";
import { broadcastSchema, setClaimsSchema, rollActionSchema } from "./admin.types";

export async function broadcastController(c: Context<AuthContext>) {
  const session = c.get("session");
  if (!isAuthorizedAdmin(session.email)) {
    return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
  }

  const json = await c.req.json().catch(() => ({}));
  const parsed = broadcastSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  try {
    const result = await sendBroadcastEmail(parsed.data.subject, parsed.data.body);
    return c.json(result);
  } catch (err: any) {
    return c.json({ ok: false, code: "send-failed", message: err.message ?? "Broadcast failed" }, 500);
  }
}

export async function setClaimsController(c: Context<AuthContext>) {
  const session = c.get("session");
  if (!isAuthorizedAdmin(session.email)) {
    return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
  }

  const json = await c.req.json().catch(() => ({}));
  const parsed = setClaimsSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: false, code: "invalid", message: "Invalid payload" }, 400);
  }

  try {
    await setCustomClaims(parsed.data.uid, parsed.data.claims);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, code: "error", message: "Failed to set claims" }, 500);
  }
}

export async function reserveRollController(c: Context<AuthContext>) {
  const session = c.get("session");
  if (!isAuthorizedAdmin(session.email)) {
    return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
  }

  const json = await c.req.json().catch(() => ({}));
  const parsed = rollActionSchema.safeParse(json);
  if (!parsed.success) return c.json({ ok: false, code: "invalid" }, 400);

  const reserved = await reserveRoll(parsed.data.roll, parsed.data.uid);
  return c.json({ ok: reserved });
}

export async function releaseRollController(c: Context<AuthContext>) {
  const session = c.get("session");
  if (!isAuthorizedAdmin(session.email)) {
    return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
  }

  const json = await c.req.json().catch(() => ({}));
  const parsed = rollActionSchema.safeParse(json);
  if (!parsed.success) return c.json({ ok: false, code: "invalid" }, 400);

  await releaseRoll(parsed.data.roll, parsed.data.uid);
  return c.json({ ok: true });
}
