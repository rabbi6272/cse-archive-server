import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { safeCompare } from "../shared/utils";

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
