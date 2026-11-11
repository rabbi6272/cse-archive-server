import { Hono } from "hono";
import { requireSession, type AuthContext } from "../../middleware/requireSession";
import {
  broadcastController,
  setClaimsController,
  reserveRollController,
  releaseRollController,
} from "./admin.controllers";

export const adminRoutes = new Hono<AuthContext>();

adminRoutes.post("/broadcast", requireSession, broadcastController);
adminRoutes.post("/claims", requireSession, setClaimsController);
adminRoutes.post("/roll/reserve", requireSession, reserveRollController);
adminRoutes.post("/roll/release", requireSession, releaseRollController);
