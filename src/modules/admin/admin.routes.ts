import { Hono } from "hono";
import { requireSession } from "../../middleware/requireSession";
import { requireRole, type RoleContext } from "../../middleware/requireAdmin";
import {
  broadcastController,
  setClaimsController,
  reserveRollController,
  releaseRollController,
} from "./admin.controllers";

export const adminRoutes = new Hono<RoleContext>();

// Every admin route needs a session; the role gate is per route.
adminRoutes.use("*", requireSession);

// admin+
adminRoutes.post("/broadcast", requireRole("admin"), broadcastController);
adminRoutes.post("/roll/reserve", requireRole("admin"), reserveRollController);
adminRoutes.post("/roll/release", requireRole("admin"), releaseRollController);

// super_admin only: raw Firebase custom claims can affect any account (e.g. mustRotate)
adminRoutes.post("/claims", requireRole("super_admin"), setClaimsController);
