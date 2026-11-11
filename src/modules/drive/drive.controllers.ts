import type { Context } from "hono";
import { env } from "../../config/env";
import { getRootFolderId } from "../../config/drive";
import { invalidateAllDriveCaches, getCachedDriveData } from "../../shared/cache";
import {
  getFolderData,
  buildStatus,
  setLastNotification,
  getWatchInfo,
  processChanges,
  initializePageToken,
  createWatchChannel,
  clearDriveMeta,
  renewWatchIfNeeded,
  fetchDriveData,
} from "./drive.services";
import { folderIdSchema, VALID_ACTIONS, type AdminAction, type WatchInfo, type WatchState } from "./drive.types";

export async function getFolderController(c: Context) {
  let folderId: string;
  try {
    const body = await c.req.json();
    const parsed = folderIdSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid folderId" }, 400);
    }
    folderId = parsed.data.folderId;
  } catch {
    return c.json({ error: "Invalid request body. Expected JSON with folderId field." }, 400);
  }

  try {
    const data = await getFolderData(folderId);
    return c.json(data);
  } catch (err) {
    console.error(`[DriveController] Error fetching folder ${folderId}:`, err);
    return c.json({ error: "Failed to fetch folder data" }, 500);
  }
}

export async function getStatusController(c: Context) {
  try {
    return c.json(await buildStatus());
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
}

export async function webhookController(c: Context) {
  const token = c.req.header("x-goog-channel-token");
  const expectedToken = env.GOOGLE_DRIVE_WEBHOOK_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    console.warn("[DriveWebhook] Invalid token, ignoring");
    return c.text("invalid token", 401);
  }

  const channelId = c.req.header("x-goog-channel-id") ?? null;
  const resourceState = c.req.header("x-goog-resource-state") ?? null;
  const messageNumber = c.req.header("x-goog-message-number") ?? null;

  try {
    await setLastNotification({
      at: new Date().toISOString(),
      state: resourceState,
      messageNumber,
      channelId,
    });
  } catch (err) {
    console.warn("[DriveWebhook] Failed to record last notification in RTDB:", err);
  }

  if (resourceState === "sync") {
    console.log("[DriveWebhook] Sync notification received, ignoring");
    return c.text("sync ack", 200);
  }

  const watchInfo = await getWatchInfo().catch(() => null);
  if (watchInfo && channelId && watchInfo.channelId !== channelId) {
    console.warn(`[DriveWebhook] Unknown channel ${channelId}, ignoring`);
    return c.text("unknown channel", 200);
  }

  try {
    await invalidateAllDriveCaches();
    await processChanges();
    console.log("[DriveWebhook] Cache cleared and changes processed");
    return c.text("ok", 200);
  } catch (err) {
    console.error("[DriveWebhook] Failed to process webhook:", err);
    return c.text("error", 500);
  }
}

export async function renewWatchController(c: Context) {
  const webhookUrl = env.GOOGLE_DRIVE_WEBHOOK_URL;
  const webhookToken = env.GOOGLE_DRIVE_WEBHOOK_TOKEN;

  if (!webhookUrl || !webhookToken) {
    return c.json({ ok: false, error: "GOOGLE_DRIVE_WEBHOOK_URL and GOOGLE_DRIVE_WEBHOOK_TOKEN must be set" }, 500);
  }

  try {
    const result = await renewWatchIfNeeded(webhookUrl, webhookToken);
    return c.json({
      ok: true,
      renewed: result.renewed !== false,
      channelId: result.channelId,
      expiration: result.expiration ? new Date(Number(result.expiration)).toISOString() : null,
    });
  } catch (err) {
    console.error("[DriveRenew] Failed to renew watch:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
}

export async function adminActionController(c: Context) {
  let action: AdminAction;
  let opts: { warm?: boolean; clearMeta?: boolean } = {};

  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const candidate = String(body.action ?? "");
    if (!VALID_ACTIONS.includes(candidate as AdminAction)) {
      return c.json({ ok: false, error: `action must be one of: ${VALID_ACTIONS.join(", ")}` }, 400);
    }
    action = candidate as AdminAction;
    opts = {
      warm: Boolean(body.warm),
      clearMeta: Boolean(body.clearMeta),
    };
  } catch {
    return c.json({ ok: false, error: "Invalid request body." }, 400);
  }

  const webhookUrl = env.GOOGLE_DRIVE_WEBHOOK_URL;
  const webhookToken = env.GOOGLE_DRIVE_WEBHOOK_TOKEN;

  try {
    const details: Record<string, unknown> = {};

    if (action === "setup") {
      if (!webhookUrl || !webhookToken) {
        return c.json({ ok: false, error: "Webhook URL and token required" }, 500);
      }
      const pageToken = await initializePageToken();
      details.pageToken = pageToken ? "present" : "missing";

      let watchInfo: WatchInfo | null = await getWatchInfo();
      let watchCreated = false;
      if (!watchInfo || !watchInfo.expiration || Date.now() > Number(watchInfo.expiration)) {
        watchInfo = await createWatchChannel(webhookUrl, webhookToken);
        watchCreated = true;
      }
      details.watch = {
        channelId: watchInfo.channelId,
        resourceId: watchInfo.resourceId || null,
        expiration: new Date(Number(watchInfo.expiration)).toISOString(),
        created: watchCreated,
      };
    }

    if (action === "revalidate" || action === "delete") {
      const invalidated = await invalidateAllDriveCaches();
      if (action === "revalidate" && opts.warm) {
        await getCachedDriveData(getRootFolderId(), () => fetchDriveData(getRootFolderId()));
        details.warmedFolder = getRootFolderId();
      }
      if (action === "delete" && opts.clearMeta) {
        await clearDriveMeta();
        details.metaCleared = true;
      }
      details.invalidated = invalidated;
    }

    if (action === "renew") {
      if (!webhookUrl || !webhookToken) {
        return c.json({ ok: false, error: "Webhook URL and token required" }, 500);
      }
      const result: WatchState = await renewWatchIfNeeded(webhookUrl, webhookToken);
      details.renewed = result.renewed !== false;
      details.watch = {
        channelId: result.channelId,
        resourceId: result.resourceId || null,
        expiration: result.expiration ? new Date(Number(result.expiration)).toISOString() : null,
      };
    }

    return c.json({
      ok: true,
      action,
      details,
      status: await buildStatus(),
    });
  } catch (err) {
    console.error(`[DriveAdmin] ${action} failed:`, err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
}
