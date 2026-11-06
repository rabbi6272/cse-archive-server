import { describe, it, expect, mock } from "bun:test";
import { v1 } from "./index";
import { app } from "../index";
import * as repo from "./repo/students.repo";

mock.module("./repo/students.repo", () => ({
  countUnclaimed: async () => 42,
  listPublicProfiles: async () => ({ profiles: [], nextCursor: undefined }),
  findProfileById: async () => null,
  findProfileByEmail: async () => null,
  findProfileByRoll: async () => null,
  findLegacyByEmail: async () => null,
  reserveRoll: async () => true,
  releaseRoll: async () => {},
  writeProfile: async () => {},
  patchProfile: async () => {},
  deleteProfile: async () => {},
  getPrivateContact: async () => null,
  setPrivateContact: async () => {},
  removeLegacy: async () => {},
  countPublishedBySeries: async () => 0,
}));

const ALLOWED_ORIGIN = "http://localhost:3000";

describe("V1 Auth & Server API under /api/v1", () => {
  it("GET /api/v1/health returns ok", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /v1/health also returns ok (compatibility alias)", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("POST /api/v1/auth/signin rejects request with bad origin", async () => {
    const res = await app.request("/api/v1/auth/signin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://malicious-website.com",
      },
      body: JSON.stringify({ email: "test@example.com", password: "password123" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("bad-origin");
  });

  it("POST /api/v1/auth/signin returns 400 on invalid input", async () => {
    const res = await app.request("/api/v1/auth/signin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ email: "invalid-email", password: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("invalid");
  });

  it("GET /api/v1/me returns { user: null } when unauthenticated", async () => {
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });

  it("POST /api/v1/auth/signout clears session cookie", async () => {
    const res = await app.request("/api/v1/auth/signout", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("__session=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("GET /api/v1/claims/unclaimed-count returns ok with count", async () => {
    const res = await app.request("/api/v1/claims/unclaimed-count");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(typeof body.count).toBe("number");
  });

  it("GET /api/v1/profiles returns ok with profiles array", async () => {
    const res = await app.request("/api/v1/profiles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; profiles: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.profiles)).toBe(true);
  });
});
