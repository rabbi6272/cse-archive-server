import { Hono } from "hono";
import { requireAdmin, requireCronOrAdmin } from "../../middleware/requireAdmin";
import {
  getFolderController,
  getStatusController,
  webhookController,
  renewWatchController,
  adminActionController,
} from "./drive.controllers";

export const driveRoutes = new Hono();

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

// Drive admin operations
driveRoutes.get("/admin", requireAdmin, getStatusController);
driveRoutes.post("/admin", requireAdmin, adminActionController);
