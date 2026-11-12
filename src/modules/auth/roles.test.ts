import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireRole, type RoleContext } from "../../middleware/requireAdmin";
import { ensureUserUpdate } from "./auth.services";
import { hasRole, isRole, signUpSchema, type Role, type Session } from "./auth.types";

const session = (uid: string): Session => ({
  uid,
  email: `${uid}@example.com`,
  emailVerified: true,
  mustRotate: false,
  needsSection: false,
});

/** Builds a tiny app gated by requireRole with an in-memory role table (no Mongo / Firebase). */
function gatedApp(roles: Record<string, Role | undefined>) {
  const deps = {
    readSession: async (c: any) => {
      const uid = c.req.header("x-test-uid");
      return uid ? session(uid) : null;
    },
    getUserRole: async (uid: string): Promise<Role> => roles[uid] ?? "student",
  };
  const app = new Hono<RoleContext>();
  app.get("/admin", requireRole("admin", deps), (c) => c.json({ ok: true, role: c.get("role") }));
  app.get("/super", requireRole("super_admin", deps), (c) => c.json({ ok: true, role: c.get("role") }));
  return app;
}

const as = (uid?: string) => (uid ? { headers: { "x-test-uid": uid } } : {});

describe("role hierarchy", () => {
  it("ranks student < admin < super_admin", () => {
    expect(hasRole("student", "student")).toBe(true);
    expect(hasRole("student", "admin")).toBe(false);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("admin", "super_admin")).toBe(false);
    expect(hasRole("super_admin", "admin")).toBe(true);
    expect(hasRole("super_admin", "super_admin")).toBe(true);
  });

  it("only recognises the three roles", () => {
    expect(isRole("student")).toBe(true);
    expect(isRole("super_admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe("requireRole", () => {
  const app = gatedApp({ a: "admin", s: "super_admin", st: "student" });

  it("401s without a session", async () => {
    expect((await app.request("/admin", as())).status).toBe(401);
  });

  it("forbids students from admin routes", async () => {
    const res = await app.request("/admin", as("st"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
  });

  it("treats a user with no users record as student", async () => {
    expect((await app.request("/admin", as("unknown"))).status).toBe(403);
  });

  it("lets admins into admin routes but not super_admin routes", async () => {
    expect((await app.request("/admin", as("a"))).status).toBe(200);
    expect((await app.request("/super", as("a"))).status).toBe(403);
  });

  it("lets super_admins into everything", async () => {
    expect((await app.request("/admin", as("s"))).status).toBe(200);
    const res = await app.request("/super", as("s"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "super_admin" });
  });

  it("re-reads the role on every request (manual DB change applies immediately)", async () => {
    const roles: Record<string, Role> = { u: "student" };
    const live = gatedApp(roles);
    expect((await live.request("/admin", as("u"))).status).toBe(403);
    roles.u = "admin";
    expect((await live.request("/admin", as("u"))).status).toBe(200);
  });
});

describe("ensureUser", () => {
  it("sets role only on insert, so an existing role is never downgraded", () => {
    const update = ensureUserUpdate("uid1", " Mixed@Example.com ", new Date(0));
    expect(update.$setOnInsert.role).toBe("student");
    expect("role" in update.$set).toBe(false);
    expect(update.$set.email).toBe("mixed@example.com");
  });
});

describe("signUpSchema", () => {
  const base = { series: "24", email: "a@example.com", password: "longenough1" };

  it("accepts a normal sign-up", () => {
    expect(signUpSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a client-supplied role", () => {
    expect(signUpSchema.safeParse({ ...base, role: "admin" }).success).toBe(false);
  });

  it("validates an optional roll", () => {
    expect(signUpSchema.safeParse({ ...base, roll: "2403001" }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...base, roll: "123" }).success).toBe(false);
  });
});
