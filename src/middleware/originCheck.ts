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
  const referer = c.req.header("referer");
  const authHeader = c.req.header("authorization");

  // Server-to-server calls with Bearer secrets bypass CSRF origin checks
  if (
    authHeader &&
    ((env.AUTH_SERVICE_SECRET && authHeader === `Bearer ${env.AUTH_SERVICE_SECRET}`) ||
      (env.ADMIN_SECRET && authHeader === `Bearer ${env.ADMIN_SECRET}`))
  ) {
    return next();
  }

  // Check origin or referer origin against allowed origins
  const refererOrigin = referer ? new URL(referer).origin : null;
  const effectiveOrigin = origin || refererOrigin;

  if (effectiveOrigin && allowed.has(effectiveOrigin)) {
    return next();
  }

  // Allow server-to-server / localhost loopback calls when origin is omitted
  const host = c.req.header("host");
  if (!effectiveOrigin && host && (host.includes("localhost") || host.includes("127.0.0.1"))) {
    return next();
  }

  console.warn(`[originCheck] Rejected origin: "${effectiveOrigin}" for ${c.req.method} ${c.req.path}`);
  return c.json({ ok: false, code: "bad-origin" }, 403);
};
