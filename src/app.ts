import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { allowedOrigins } from "./config/env";
import { ensureIndexes } from "./config/mongo";
import { originCheck } from "./middleware/originCheck";
import { requireAuthSecret } from "./middleware/requireAdmin";

// Feature modules
import { driveRoutes } from "./modules/drive/drive.routes";
import { authRoutes } from "./modules/auth/auth.routes";
import { claimRoutes } from "./modules/claim/claim.routes";
import { profileRoutes } from "./modules/profile/profile.routes";
import { meRoutes } from "./modules/me/me.routes";
import { adminRoutes } from "./modules/admin/admin.routes";

export const app = new Hono();

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://ruetcse24-new.vercel.app",
  "https://ruetcsearchive.vercel.app"
];

// Logger middleware
app.use(logger((line) => !line.startsWith("<--") && console.log(line)));

// CORS: browsers on the allow-listed client sites may call any /api/v1 route
// directly (public reads such as /profiles, plus Drive). Credentials are allowed so
// a same-site deployment can send the session cookie; origins are an explicit list.
const corsPolicy = cors({
  origin: ALLOWED_ORIGINS,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 600,
});

for (const path of ["/api/v1", "/api/v1/*", "/v1", "/v1/*", "/api/drive", "/api/drive/*"]) {
  app.use(path, corsPolicy);
}

// Health checks
app.get("/health", (c) => c.text("ok"));
app.get("/", (c) => c.text("CSE Archive Server is running"));

// ─── Canonical V1 Router (/api/v1) ───────────────────────────

export const v1 = new Hono();

// Apply CSRF origin check on state-changing requests
v1.use("*", originCheck);

v1.get("/health", (c) => c.text("ok"));

// Mount feature modules
v1.route("/drive", driveRoutes);
v1.route("/auth", authRoutes);
v1.route("/auth/claim", claimRoutes); // Alias
v1.route("/claim", claimRoutes);
v1.route("/claims", claimRoutes);     // Alias
v1.route("/profiles", profileRoutes);
v1.route("/me", meRoutes);
v1.route("/admin", adminRoutes);

// Direct alias for DELETE /account -> /me/account
v1.delete("/account", (c) => meRoutes.fetch(c.req.raw));

// Mount under canonical prefix
app.route("/api/v1", v1);

// ─── Backward Compatibility Layer ────────────────────────────

// 1. Alias /v1/* -> /api/v1/*
app.route("/v1", v1);

// 2. Legacy server-to-server auth route (/api/auth) for cse-archive-client
const legacyAuth = new Hono();
legacyAuth.use("*", requireAuthSecret);
legacyAuth.route("/", authRoutes);
app.route("/api/auth", legacyAuth);

// 3. Legacy drive routes (/api/drive) for cse-archive-client
app.all("/api/drive/*", (c) =>
  app.fetch(new Request(c.req.url.replace("/api/drive", "/api/v1/drive"), c.req.raw)),
);
app.all("/api/drive", (c) =>
  app.fetch(new Request(c.req.url.replace("/api/drive", "/api/v1/drive"), c.req.raw)),
);

// Asynchronously ensure indexes on startup
ensureIndexes().catch((err) => {
  console.error("[mongo] Failed to initialize MongoDB indexes:", err);
});
