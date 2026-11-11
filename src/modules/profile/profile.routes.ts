import { Hono } from "hono";
import { requireSession, type AuthContext } from "../../middleware/requireSession";
import { requireVerified } from "../../middleware/requireVerified";
import {
  listProfilesController,
  getProfileByIdController,
  createProfileController,
} from "./profile.controllers";

export const profileRoutes = new Hono<AuthContext>();

profileRoutes.get("/", listProfilesController);
profileRoutes.get("/:uid", getProfileByIdController);
profileRoutes.post("/", requireSession, requireVerified, createProfileController);
