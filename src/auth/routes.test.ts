import { beforeAll, expect, test } from "bun:test";
import { env } from "../config/env";
import { auth } from "./routes";

// `env` is parsed once at import time, so tests mutate the parsed object.
beforeAll(() => {
  env.AUTH_SERVICE_SECRET = "test-secret";
  env.GOOGLE_OAUTH_CLIENT_ID = "id";
  env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
});

const authed = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

test("rejects requests without the shared secret", async () => {
  expect((await auth.request("/config")).status).toBe(401);
  expect((await auth.request("/config", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await auth.request("/login", { method: "POST", body: "{}" })).status).toBe(401);
});

test("accepts the shared secret", async () => {
  const res = await auth.request("/config", { headers: authed });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveProperty("google");
});

test("validates login input before calling Firebase", async () => {
  const res = await auth.request("/login", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ email: "not-an-email", password: "" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, code: "invalid" });
});

test("only accepts an allow-listed Google callback redirect URI", async () => {
  const start = (redirectUri: string) =>
    auth.request("/google/start", { method: "POST", headers: authed, body: JSON.stringify({ redirectUri }) });

  const bad = await start("https://evil.example/steal");
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ ok: false, code: "bad-redirect" });

  const ok = (await (await start("https://ruetcsearchive.vercel.app/api/auth/google/callback")).json()) as {
    ok: boolean;
    url: string;
    state: string;
    verifier: string;
  };
  expect(ok.ok).toBe(true);
  expect(ok.url).toContain("code_challenge_method=S256");
  expect(ok.state).toBeTruthy();
  expect(ok.verifier).toBeTruthy();
});

test("google exchange rejects a non-allow-listed redirect URI before calling Google", async () => {
  const res = await auth.request("/google/exchange", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ code: "c", verifier: "v", redirectUri: "https://evil.example/cb" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "bad-redirect" });
});

test("signup rejects a client-supplied role", async () => {
  const res = await auth.request("/signup", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      series: "24",
      email: "new@example.com",
      password: "longenough1",
      role: "super_admin",
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, code: "invalid" });
});
