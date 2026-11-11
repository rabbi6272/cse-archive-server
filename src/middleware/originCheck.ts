import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";

const allowed = new Set(
  env.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const originCheck: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (!origin || !allowed.has(origin)) {
    console.warn(`[originCheck] Rejected origin: "${origin}" for ${c.req.method} ${c.req.path}`);
    return c.json({ ok: false, code: "bad-origin" }, 403);
  }
  return next();
};
