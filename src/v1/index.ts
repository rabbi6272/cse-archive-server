import { Hono } from "hono";
import { originCheck } from "./middleware/originCheck";
import { authRoutes } from "./routes/auth";
import { claimRoutes } from "./routes/claim";
import { googleRoutes } from "./routes/google";
import { meRoutes } from "./routes/me";
import { profilesRoutes } from "./routes/profiles";
import { claimsRoutes } from "./routes/claims";
import { adminRoutes } from "./routes/admin";
import { ensureIndexes } from "./mongo";

export const v1 = new Hono();

// Apply origin check on state-changing requests
v1.use("*", originCheck);

// Health check endpoint
v1.get("/health", (c) => c.text("ok"));

// Mount route modules
v1.route("/auth/claim", claimRoutes);
v1.route("/auth/google", googleRoutes);
v1.route("/auth", authRoutes);
v1.route("/me", meRoutes);
v1.route("/profiles", profilesRoutes);
v1.route("/claims", claimsRoutes);
v1.route("/admin", adminRoutes);

// Direct alias for DELETE /account -> /me/account
v1.delete("/account", (c) => meRoutes.fetch(c.req.raw));

// Asynchronously ensure indexes on startup
ensureIndexes().catch((err) => {
  console.error("[v1] Failed to initialize MongoDB indexes:", err);
});
