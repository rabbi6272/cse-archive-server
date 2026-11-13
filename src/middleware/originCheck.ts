import type { MiddlewareHandler } from "hono";
import { env } from "../config/env";
import { ALLOWED_ORIGINS } from "../config/origins";

const allowed = new Set(ALLOWED_ORIGINS);

export function isAllowedOrigin(origin: string): boolean {
  return allowed.has(origin);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * POST endpoints exempt from the CSRF origin check:
 *  - `/drive`: public folder listing. A read that happens to use POST; it takes no
 *    session and changes nothing, so there is nothing to forge. Browsers prefetch it
 *    directly and some (privacy settings, extensions) send `Origin: null`.
 *  - `/drive/webhook`: called by Google with no browser origin; it verifies its own
 *    `x-goog-channel-token`.
 */
const EXEMPT_POST = /\/v1\/drive(\/webhook)?\/?$/;

export const originCheck: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (EXEMPT_POST.test(c.req.path)) return next();

  // Browsers send the literal string "null" for opaque origins; treat it as absent.
  const rawOrigin = c.req.header("origin");
  const origin = rawOrigin === "null" ? undefined : rawOrigin;
  const referer = c.req.header("referer");
  const authHeader = c.req.header("authorization");

  // Server-to-server calls with Bearer secrets bypass CSRF origin checks
  const bearerSecrets = [env.AUTH_SERVICE_SECRET, env.ADMIN_SECRET, env.CRON_SECRET].filter(Boolean);
  if (authHeader && bearerSecrets.some((secret) => authHeader === `Bearer ${secret}`)) {
    return next();
  }

  // Check origin or referer origin against allowed origins
  const refererOrigin = originOf(referer);
  if (!origin && referer && !refererOrigin) {
    return c.json({ ok: false, code: "bad-origin" }, 403);
  }
  const effectiveOrigin = origin || refererOrigin;

  if (effectiveOrigin && allowed.has(effectiveOrigin)) {
    return next();
  }

  // Allow server-to-server / localhost loopback calls when origin is omitted
  const host = c.req.header("host");
  if (!effectiveOrigin && host && (host.includes("localhost") || host.includes("127.0.0.1"))) {
    return next();
  }

  console.warn(`[originCheck] Rejected origin: "${rawOrigin ?? effectiveOrigin}" for ${c.req.method} ${c.req.path}`);
  return c.json({ ok: false, code: "bad-origin" }, 403);
};
