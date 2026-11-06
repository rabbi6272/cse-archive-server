import { beforeAll, expect, test } from "bun:test";
import { auth } from "./routes";

beforeAll(() => {
  process.env.AUTH_SERVICE_SECRET = "test-secret";
});

test("rejects requests without the shared secret", async () => {
  expect((await auth.request("/config")).status).toBe(401);
  expect((await auth.request("/config", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await auth.request("/login", { method: "POST", body: "{}" })).status).toBe(401);
});

test("accepts the shared secret", async () => {
  const res = await auth.request("/config", { headers: { Authorization: "Bearer test-secret" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveProperty("google");
});

test("validates login input before calling Firebase", async () => {
  const res = await auth.request("/login", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "" }),
  });
  expect(await res.json()).toEqual({ ok: false, code: "invalid" });
});

test("only accepts a Google callback redirect URI", async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
  const start = (redirectUri: string) =>
    auth.request("/google/start", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri }),
    });
  expect(((await (await start("https://evil.example/steal")).json()) as { ok: boolean }).ok).toBe(false);
  const ok = (await (await start("https://ruetcsearchive.vercel.app/api/auth/google/callback")).json()) as {
    ok: boolean;
    url: string;
  };
  expect(ok.ok).toBe(true);
  expect(ok.url).toContain("code_challenge_method=S256");
});
