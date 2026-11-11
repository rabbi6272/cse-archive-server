import { Hono } from "hono";
import { requireAuthSecret } from "../middleware/requireAdmin";
import { authRoutes } from "../modules/auth/auth.routes";

export const auth = new Hono();
auth.use("*", requireAuthSecret);
auth.route("/", authRoutes);
