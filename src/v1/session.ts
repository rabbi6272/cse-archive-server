import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { adminAuth } from "./firebase";
import { env } from "./env";

export const SESSION_COOKIE = "__session";
export const SESSION_MAX_AGE_S = 5 * 24 * 60 * 60; // 5 days
const TTL_MS = 60_000;

export type Session = {
  uid: string;
  email: string;
  emailVerified: boolean;
  mustRotate: boolean;
  needsSection: boolean;
};

const cache = new Map<string, { session: Session; expires: number }>();
const hash = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

// Prune expired cache entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires < now) cache.delete(k);
  }
}, 60_000);

export async function createSession(c: Context, idToken: string): Promise<string> {
  const cookie = await adminAuth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_S * 1000,
  });

  setCookie(c, SESSION_COOKIE, cookie, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });

  return cookie;
}

export function clearSession(c: Context): void {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) cache.delete(hash(cookie));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function readSession(c: Context): Promise<Session | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;

  const key = hash(cookie);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.session;

  try {
    const d = await adminAuth.verifySessionCookie(cookie, true); // checkRevoked = true
    const session: Session = {
      uid: d.uid,
      email: d.email ?? "",
      emailVerified: d.email_verified === true,
      mustRotate: d.mustRotate === true,
      needsSection: d.needsSection === true,
    };
    cache.set(key, { session, expires: Date.now() + TTL_MS });
    return session;
  } catch {
    cache.delete(key);
    return null;
  }
}
