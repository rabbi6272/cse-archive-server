import type { Context } from "hono";
import type { RoleContext } from "../../middleware/requireAdmin";
import { sendBroadcastEmail, setCustomClaims, reserveRoll, releaseRoll } from "./admin.services";
import { broadcastSchema, setClaimsSchema, rollActionSchema } from "./admin.types";

// Role checks happen in admin.routes.ts via requireRole(); controllers assume an authorised caller.

export async function broadcastController(c: Context<RoleContext>) {
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

export async function setClaimsController(c: Context<RoleContext>) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = setClaimsSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: false, code: "invalid", message: "Invalid payload" }, 400);
  }

  try {
    await setCustomClaims(parsed.data.uid, parsed.data.claims);
    console.log(`[admin] claims set on ${parsed.data.uid} by ${c.get("session").uid}`);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, code: "error", message: "Failed to set claims" }, 500);
  }
}

export async function reserveRollController(c: Context<RoleContext>) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = rollActionSchema.safeParse(json);
  if (!parsed.success) return c.json({ ok: false, code: "invalid" }, 400);

  const reserved = await reserveRoll(parsed.data.roll, parsed.data.uid);
  return c.json({ ok: reserved });
}

export async function releaseRollController(c: Context<RoleContext>) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = rollActionSchema.safeParse(json);
  if (!parsed.success) return c.json({ ok: false, code: "invalid" }, 400);

  await releaseRoll(parsed.data.roll, parsed.data.uid);
  return c.json({ ok: true });
}
