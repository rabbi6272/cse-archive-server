import { describe, expect, it } from "bun:test";
import { parseAllowedOrigins } from "./env";
import { app } from "../app";

describe("parseAllowedOrigins", () => {
  it("parses a comma-separated list", () => {
    expect(parseAllowedOrigins("https://a.app, https://b.app/", "production")).toEqual([
      "https://a.app",
      "https://b.app",
    ]);
  });

  it("parses a JSON array (with quotes and spaces)", () => {
    expect(
      parseAllowedOrigins('["http://localhost:3005", "https://ruetcse24-new.vercel.app"]', "production"),
    ).toEqual(["http://localhost:3005", "https://ruetcse24-new.vercel.app"]);
  });

  it("adds local Next.js dev origins outside production only", () => {
    expect(parseAllowedOrigins("https://a.app", "development")).toContain("http://localhost:3000");
    expect(parseAllowedOrigins("https://a.app", "production")).not.toContain("http://localhost:3000");
  });

  it("drops invalid entries", () => {
    expect(parseAllowedOrigins("not a url,https://ok.app", "production")).toEqual(["https://ok.app"]);
  });
});

describe("CORS on /api/v1", () => {
  it("answers a preflight for /api/v1/profiles from an allowed origin", async () => {
    const res = await app.request("/api/v1/profiles", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("does not echo an unknown origin", async () => {
    const res = await app.request("/api/v1/profiles", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});
