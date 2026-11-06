import { timingSafeEqual, createHash } from "node:crypto";
import { Hono } from "hono";
import { googleConfigured, googleSignIn, googleStart, passwordSignIn, verifySession } from "./auth";

// Server-to-server only: called by the Next.js site, never by browsers (so no CORS here).
// Every request must carry Authorization: Bearer <AUTH_SERVICE_SECRET>, shared with the Next.js site.
export const auth = new Hono();

const hash = (s: string) => createHash("sha256").update(s).digest();

auth.use("*", async (c, next) => {
  const secret = process.env.AUTH_SERVICE_SECRET;
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secret || !token || !timingSafeEqual(hash(token), hash(secret))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}
const str = (v: unknown, max = 2048) => (typeof v === "string" && v.length <= max ? v : "");

auth.post("/login", async (c) => {
  const b = await body(c);
  const email = str(b.email, 254).trim().toLowerCase();
  const password = str(b.password, 1024);
  if (!email.includes("@") || !password) return c.json({ ok: false, code: "invalid" });
  try {
    return c.json(await passwordSignIn(email, password));
  } catch (err) {
    console.error("[auth] signin -> failed", err);
    return c.json({ ok: false, code: "error" });
  }
});

auth.post("/session", async (c) => {
  const value = str((await body(c)).session, 8192);
  const viewer = value ? await verifySession(value) : null;
  return c.json(viewer ? { ok: true, viewer } : { ok: false });
});

auth.get("/config", (c) => c.json({ google: googleConfigured() }));

auth.post("/google/start", async (c) => {
  if (!googleConfigured()) return c.json({ ok: false, code: "not-configured" });
  const redirectUri = str((await body(c)).redirectUri);
  if (!/^https?:\/\/[^/]+\/api\/auth\/google\/callback$/.test(redirectUri)) return c.json({ ok: false, code: "error" });
  return c.json({ ok: true, ...googleStart(redirectUri) });
});

auth.post("/google/exchange", async (c) => {
  if (!googleConfigured()) return c.json({ ok: false, code: "error" });
  const b = await body(c);
  const code = str(b.code);
  const verifier = str(b.verifier, 128);
  const redirectUri = str(b.redirectUri);
  if (!code || !verifier || !redirectUri) return c.json({ ok: false, code: "error" });
  try {
    return c.json(await googleSignIn(code, verifier, redirectUri));
  } catch (err) {
    console.error("[auth] google -> failed", err);
    return c.json({ ok: false, code: "error" });
  }
});
