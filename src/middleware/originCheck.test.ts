import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { originCheck } from "./originCheck";

// A stand-in v1 router so the check runs without touching Drive / Mongo / Firebase.
const app = new Hono();
const v1 = new Hono();
v1.use("*", originCheck);
v1.post("/drive", (c) => c.json({ ok: true }));
v1.post("/drive/webhook", (c) => c.json({ ok: true }));
v1.post("/drive/admin", (c) => c.json({ ok: true }));
v1.post("/auth/signin", (c) => c.json({ ok: true }));
app.route("/api/v1", v1);

const post = (path: string, headers: Record<string, string>) =>
  app.request(path, { method: "POST", headers: { host: "api.example.com", ...headers } });

describe("originCheck", () => {
  it("lets the public Drive folder listing through with Origin: null", async () => {
    expect((await post("/api/v1/drive", { Origin: "null" })).status).toBe(200);
  });

  it("lets Google's Drive webhook through without an origin", async () => {
    expect((await post("/api/v1/drive/webhook", {})).status).toBe(200);
  });

  it("still blocks other POSTs with Origin: null", async () => {
    expect((await post("/api/v1/auth/signin", { Origin: "null" })).status).toBe(403);
    expect((await post("/api/v1/drive/admin", { Origin: "null" })).status).toBe(403);
  });

  it("still blocks a foreign origin", async () => {
    expect((await post("/api/v1/auth/signin", { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("allows an allow-listed origin", async () => {
    expect((await post("/api/v1/auth/signin", { Origin: "http://localhost:3000" })).status).toBe(200);
  });
});
