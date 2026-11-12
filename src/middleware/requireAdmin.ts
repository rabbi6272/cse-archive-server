import type { Context, MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { safeCompare } from "../shared/utils";
import { readSession, getUserRole } from "../modules/auth/auth.services";
import { hasRole, type Role } from "../modules/auth/auth.types";
import type { AuthContext } from "./requireSession";

export type RoleContext = {
  Variables: AuthContext["Variables"] & { role: Role };
};

function bearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Requires a signed-in user whose role is at least `min`
 * (student < admin < super_admin). The role is read from MongoDB on every
 * request so a manual role change applies immediately.
 */
export function requireRole(
  min: Role,
  deps: { readSession: typeof readSession; getUserRole: typeof getUserRole } = { readSession, getUserRole },
): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const session = c.get("session") ?? (await deps.readSession(c));
    if (!session) return c.json({ ok: false, code: "unauthenticated" }, 401);

    const role = await deps.getUserRole(session.uid);
    if (!hasRole(role, min)) {
      console.warn(`[auth] forbidden uid=${session.uid} role=${role} needs=${min} ${c.req.method} ${c.req.path}`);
      return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
    }

    c.set("session", session);
    c.set("role", role);
    await next();
  };
}

/**
 * For automation endpoints: accepts the `ADMIN_SECRET` bearer token (cron / scripts)
 * or, failing that, a signed-in user with at least role `min`.
 */
export function requireAdminSecretOrRole(min: Role): MiddlewareHandler<RoleContext> {
  const roleCheck = requireRole(min);
  return async (c, next) => {
    const token = bearer(c);
    if (env.ADMIN_SECRET && token && safeCompare(token, env.ADMIN_SECRET)) return next();
    return roleCheck(c, next);
  };
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const secret = env.ADMIN_SECRET;
  if (!secret) return c.json({ ok: false, error: "Unauthorized" }, 401);

  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token || !safeCompare(token, secret)) {
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }
  return next();
};

export const requireCronOrAdmin: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const adminSecret = env.ADMIN_SECRET;
  const cronSecret = env.CRON_SECRET;

  const isAdmin = adminSecret && safeCompare(token, adminSecret);
  const isCron = cronSecret && safeCompare(token, cronSecret);

  if (!isAdmin && !isCron) {
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }
  return next();
};

export const requireAuthSecret: MiddlewareHandler = async (c, next) => {
  const secret = env.AUTH_SERVICE_SECRET;
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!secret || !token || !safeCompare(token, secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};
