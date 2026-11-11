import type { Context } from "hono";
import type { AuthContext } from "../../middleware/requireSession";
import { checkRateLimit } from "../../middleware/rateLimit";
import { createSession } from "../auth/auth.services";
import {
  processClaimStart,
  processClaimOpen,
  processClaimComplete,
  countUnclaimed,
} from "./claim.services";
import { claimStartSchema, claimOpenSchema, claimCompleteSchema } from "./claim.types";

export async function claimStartController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimStartSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: true }); // Anti-enumeration
  }

  const { email } = parsed.data;
  const isLimited = await checkRateLimit(`claim:${email}`, 60);
  if (isLimited) {
    return c.json({ ok: true });
  }

  await processClaimStart(email);
  return c.json({ ok: true });
}

export async function claimOpenController(c: Context) {
  const json = await c.req.json().catch(() => ({}));
  const parsed = claimOpenSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: "Invalid claim link parameters." },
      400,
    );
  }

  const { oobCode, email } = parsed.data;
  const result = await processClaimOpen(oobCode, email);

  if (!result.ok) {
    return c.json(
      { ok: false, code: result.code, message: result.message },
      result.code === "no-legacy" ? 404 : result.code === "roll-held" ? 409 : 400,
    );
  }

  await createSession(c, result.idToken);
  c.header("Cache-Control", "private, no-store");

  return c.json({
    ok: true,
    mode: result.mode,
    needsSection: result.needsSection,
  });
}

export async function claimCompleteController(c: Context<AuthContext>) {
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
  const result = await processClaimComplete(session, password, sec);

  if (!result.ok) {
    return c.json(
      { ok: false, code: result.code, message: result.message },
      result.code === "no-legacy" ? 404 : result.code === "roll-held" ? 409 : 400,
    );
  }

  if (result.freshToken) {
    await createSession(c, result.freshToken);
  }

  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true });
}

export async function claimCountController(c: Context) {
  try {
    const count = await countUnclaimed();
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ ok: true, count });
  } catch (err) {
    console.error("[claim] Error getting unclaimed count:", err);
    return c.json({ ok: false, code: "error", message: "Failed to get count." }, 500);
  }
}
