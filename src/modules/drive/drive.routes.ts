import { Hono } from "hono";
import { requireAdminSecretOrRole, requireCronOrAdmin, type RoleContext } from "../../middleware/requireAdmin";
import {
  getFolderController,
  getStatusController,
  webhookController,
  renewWatchController,
  adminActionController,
} from "./drive.controllers";

export const driveRoutes = new Hono<RoleContext>();

// Public folder querying
driveRoutes.post("/", getFolderController);

// Status checks
driveRoutes.get("/", getStatusController);
driveRoutes.get("/status", getStatusController);

// Webhook notification receiver from Google Drive
driveRoutes.post("/webhook", webhookController);

// Cron job to renew watch
driveRoutes.get("/renew-watch", requireCronOrAdmin, renewWatchController);
driveRoutes.post("/renew-watch", requireCronOrAdmin, renewWatchController);

// Drive admin operations: ADMIN_SECRET (automation) or a super_admin session
driveRoutes.get("/admin", requireAdminSecretOrRole("super_admin"), getStatusController);
driveRoutes.post("/admin", requireAdminSecretOrRole("super_admin"), adminActionController);
