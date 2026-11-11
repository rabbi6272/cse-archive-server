import { Hono } from "hono";
import { requireSession, type AuthContext } from "../../middleware/requireSession";
import {
  getViewerController,
  getOwnProfileController,
  updateOwnProfileController,
  getOwnContactController,
  updateOwnContactController,
  deleteOwnAccountController,
} from "./me.controllers";

export const meRoutes = new Hono<AuthContext>();

meRoutes.get("/", getViewerController);
meRoutes.get("/profile", requireSession, getOwnProfileController);
meRoutes.put("/profile", requireSession, updateOwnProfileController);
meRoutes.patch("/profile", requireSession, updateOwnProfileController);
meRoutes.get("/contact", requireSession, getOwnContactController);
meRoutes.put("/contact", requireSession, updateOwnContactController);
meRoutes.patch("/contact", requireSession, updateOwnContactController);
meRoutes.delete("/account", requireSession, deleteOwnAccountController);
meRoutes.delete("/", requireSession, deleteOwnAccountController);
