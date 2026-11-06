import { Hono } from "hono";
import { countUnclaimed } from "../repo/students.repo";

export const claimsRoutes = new Hono();

claimsRoutes.get("/unclaimed-count", async (c) => {
  try {
    const count = await countUnclaimed();
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ ok: true, count });
  } catch (err) {
    console.error("[claims] Error getting unclaimed count:", err);
    return c.json({ ok: false, code: "error", message: "Failed to get unclaimed count." }, 500);
  }
});
