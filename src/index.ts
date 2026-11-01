import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fetchDriveData } from "./drive/data";
import { getRootFolderId } from "./drive/config";
import {
  createWatchChannel,
  initializePageToken,
  processChanges,
  renewWatchIfNeeded,
  type WatchState,
} from "./drive/changes";
import {
  clearDriveMeta,
  getLastNotification,
  getPageToken,
  getWatchInfo,
  setLastNotification,
  type WatchInfo,
} from "./drive/meta";
import {
  DRIVE_CACHE_REVALIDATE_SECONDS,
  DRIVE_CACHE_TAG,
  getCachedDriveData,
  invalidateAllDriveCaches,
} from "./cache";

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;
const WEBHOOK_URL = process.env.GOOGLE_DRIVE_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.GOOGLE_DRIVE_WEBHOOK_TOKEN;
const ALLOWED_ORIGIN = ["http://localhost:3000", "https://ruetcsearchive.vercel.app"];

// Drive file/folder ids are URL-safe base64-ish; anything else must never reach the Drive query.
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{10,80}$/;

const app = new Hono();

// Only the "-->" response line, which carries status and timing.
app.use(logger((line) => !line.startsWith("<--") && console.log(line)));

if (!ALLOWED_ORIGIN) {
  console.warn("[Server] ALLOWED_ORIGIN not set - browser requests will be blocked by CORS");
}
app.use(
  "/api/drive/*",
  cors({
    origin: ALLOWED_ORIGIN ?? "",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use("/api/drive", cors({ origin: ALLOWED_ORIGIN ?? "", allowHeaders: ["Content-Type"] }));

app.get("/health", (c) => c.text("ok"));

// =================== /api/drive ===================

app.post("/api/drive", async (c) => {
  let folderId: string | undefined;

  try {
    const body = await c.req.json();
    folderId = body.folderId;
  } catch {
    return c.json(
      { error: "Invalid request body. Expected JSON with folderId field." },
      400,
    );
  }

  if (!folderId) {
    return c.json({ error: "Folder ID is required" }, 400);
  }
  if (typeof folderId !== "string" || !FOLDER_ID_PATTERN.test(folderId)) {
    return c.json({ error: "Invalid folder ID" }, 400);
  }

  try {
    const data = await getCachedDriveData(folderId, () =>
      fetchDriveData(folderId),
    );

    return c.json(data, 200, {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    });
  } catch (err) {
    console.error("Google Drive API Error:", err);

    let errorMessage = "Failed to fetch files from Google Drive";
    let statusCode: ContentfulStatusCode = 500;

    const apiError = err as {
      code?: string | number;
      message?: string;
      response?: { status?: number };
    };

    if (apiError.code === "ENOENT") {
      errorMessage = "Google Drive credentials file not found";
    } else if (apiError.code === 403 || apiError.response?.status === 403) {
      errorMessage = "Access denied. Check your Google Drive API permissions.";
      statusCode = 403;
    } else if (apiError.code === 404 || apiError.response?.status === 404) {
      errorMessage = "Folder not found or not accessible.";
      statusCode = 404;
    } else if (apiError.code === 429 || apiError.response?.status === 429) {
      errorMessage = "Rate limit exceeded. Please try again in a moment.";
      statusCode = 429;
    } else if (apiError.message?.includes("invalid_grant")) {
      errorMessage =
        "Authentication failed. Check your service account credentials and system time.";
    } else if (apiError.message?.includes("JWT")) {
      errorMessage =
        "JWT token error. Please regenerate your service account credentials.";
    } else if (apiError.message?.includes("credentials not found")) {
      errorMessage =
        "Google Drive credentials not found. Please add credentials.json or set environment variables.";
    } else if (apiError.message) {
      errorMessage = apiError.message;
    }

    return c.json({ error: errorMessage }, statusCode, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
  }
});

app.get("/api/drive", async (c) => {
  let db: { ok: boolean; error?: string } = { ok: true };
  let watchInfo: WatchInfo | null = null;
  let pageToken: string | null = null;
  let lastNotification: string | null = null;

  try {
    [watchInfo, pageToken, lastNotification] = await Promise.all([
      getWatchInfo(),
      getPageToken(),
      getLastNotification(),
    ]);
  } catch (err) {
    db = { ok: false, error: (err as Error).message };
  }

  return c.json({
    storage: "in-memory cache + firebase-rtdb (drive/meta)",
    db,
    watch: watchInfo
      ? {
        channelId: watchInfo.channelId,
        expiration: watchInfo.expiration
          ? new Date(Number(watchInfo.expiration)).toISOString()
          : null,
        expired: watchInfo.expiration
          ? Date.now() > Number(watchInfo.expiration)
          : true,
      }
      : null,
    pageToken: pageToken ? "present" : "missing",
    lastNotification,
  });
});

// =================== /api/drive/webhook ===================

app.post("/api/drive/webhook", async (c) => {
  const headers = {
    "x-goog-channel-id": c.req.header("x-goog-channel-id") ?? null,
    "x-goog-channel-token": c.req.header("x-goog-channel-token") ?? null,
    "x-goog-resource-id": c.req.header("x-goog-resource-id") ?? null,
    "x-goog-resource-state": c.req.header("x-goog-resource-state") ?? null,
    "x-goog-message-number": c.req.header("x-goog-message-number") ?? null,
  };

  if (WEBHOOK_TOKEN && headers["x-goog-channel-token"] !== WEBHOOK_TOKEN) {
    console.warn("[Webhook] Invalid token, ignoring");
    return c.body(null, 403);
  }

  const watchInfo = await getWatchInfo();
  if (watchInfo) {
    if (
      watchInfo.channelId &&
      headers["x-goog-channel-id"] !== watchInfo.channelId
    ) {
      console.warn("[Webhook] Unknown channel, ignoring");
      return c.body(null, 200);
    }
    if (
      watchInfo.resourceId &&
      headers["x-goog-resource-id"] !== watchInfo.resourceId
    ) {
      console.warn("[Webhook] Resource ID mismatch, ignoring");
      return c.body(null, 200);
    }
  }

  const resourceState = headers["x-goog-resource-state"];
  const messageNumber = headers["x-goog-message-number"];

  console.log(
    `[Webhook] Received: state=${resourceState}, message=${messageNumber}, channel=${headers["x-goog-channel-id"]}`,
  );

  await recordNotification(
    resourceState,
    messageNumber,
    headers["x-goog-channel-id"],
  );

  if (resourceState === "sync") {
    console.log("[Webhook] Sync notification, acknowledging");
    return c.body(null, 200);
  }

  try {
    const { changes } = await processChanges();

    if (changes.length === 0) {
      console.log("[Webhook] No changes detected");
    } else {
      console.log(
        `[Webhook] ${changes.length} change(s) detected — invalidating cache`,
      );
      await invalidateAllDriveCaches();
    }

    return c.body(null, 200);
  } catch (err) {
    console.error(
      "[Webhook] Processing failed:",
      err instanceof Error ? err.message : err,
    );
    return c.body(null, 500);
  }
});

async function recordNotification(
  state: string | null,
  messageNumber: string | null,
  channelId: string | null,
) {
  try {
    await setLastNotification({
      at: new Date().toISOString(),
      state: state || null,
      messageNumber: messageNumber || null,
      channelId: channelId || null,
    });
  } catch (err) {
    console.error(
      "[Webhook] Failed to record notification marker:",
      err instanceof Error ? err.message : err,
    );
  }
}

// =================== /api/drive/renew-watch ===================

function bearerToken(c: Context): string | null {
  const authHeader = c.req.header("authorization") || "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
}

// GET is what cron-job.org sends; POST kept for manual calls.
app.on(["GET", "POST"], "/api/drive/renew-watch", async (c) => {
  const token = bearerToken(c);
  const authorized = Boolean(
    token &&
    ((ADMIN_SECRET && token === ADMIN_SECRET) ||
      (CRON_SECRET && token === CRON_SECRET)),
  );
  if (!authorized) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
    return c.json(
      {
        error: "GOOGLE_DRIVE_WEBHOOK_URL and GOOGLE_DRIVE_WEBHOOK_TOKEN must be set",
      },
      500,
    );
  }

  try {
    const result = await renewWatchIfNeeded(WEBHOOK_URL, WEBHOOK_TOKEN);

    if (result.renewed === false) {
      return c.json({
        status: "no_renewal_needed",
        expiresAt: result.expiration
          ? new Date(Number(result.expiration)).toISOString()
          : null,
      });
    }

    return c.json({
      status: "renewed",
      watch: {
        channelId: result.channelId,
        resourceId: result.resourceId,
        expiration: new Date(Number(result.expiration)).toISOString(),
      },
    });
  } catch (err) {
    console.error("[RenewWatch] Failed:", err);
    return c.json(
      { error: `Renewal failed: ${err instanceof Error ? err.message : err}` },
      500,
    );
  }
});

// =================== /api/drive/admin ===================

const VALID_ACTIONS = ["setup", "revalidate", "delete", "renew", "status"] as const;
type AdminAction = (typeof VALID_ACTIONS)[number];

function isAdmin(c: Context): boolean {
  return Boolean(ADMIN_SECRET) && bearerToken(c) === ADMIN_SECRET;
}

async function buildStatus() {
  const [watchInfo, pageToken, lastNotification] = await Promise.all([
    getWatchInfo(),
    getPageToken(),
    getLastNotification(),
  ]);

  return {
    cache: {
      tag: DRIVE_CACHE_TAG,
      revalidateFallbackSeconds: DRIVE_CACHE_REVALIDATE_SECONDS,
      invalidation: "webhook (in-memory clear) + 12h TTL",
    },
    watch: watchInfo
      ? {
        channelId: watchInfo.channelId,
        resourceId: watchInfo.resourceId || null,
        expiration: watchInfo.expiration
          ? new Date(Number(watchInfo.expiration)).toISOString()
          : null,
        expired: watchInfo.expiration
          ? Date.now() > Number(watchInfo.expiration)
          : true,
      }
      : null,
    pageToken: pageToken ? "present" : "missing",
    lastNotification,
  };
}

app.get("/api/drive/admin", async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: "Unauthorized" }, 401);
  try {
    return c.json(await buildStatus());
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

app.post("/api/drive/admin", async (c) => {
  if (!isAdmin(c)) return c.json({ ok: false, error: "Unauthorized" }, 401);

  let action: AdminAction;
  let opts: { warm?: boolean; clearMeta?: boolean } = {};
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object") throw new Error("Invalid body");
    const candidate = String((body as { action?: unknown }).action ?? "");
    if (!VALID_ACTIONS.includes(candidate as AdminAction)) {
      return c.json(
        {
          ok: false,
          error: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
        },
        400,
      );
    }
    action = candidate as AdminAction;
    opts = {
      warm: Boolean((body as { warm?: unknown }).warm),
      clearMeta: Boolean((body as { clearMeta?: unknown }).clearMeta),
    };
  } catch {
    return c.json(
      {
        ok: false,
        error: "Invalid request body. Expected JSON with action field.",
      },
      400,
    );
  }

  const missingWatchEnv = (verb: string) =>
    c.json(
      {
        ok: false,
        error: `GOOGLE_DRIVE_WEBHOOK_URL and GOOGLE_DRIVE_WEBHOOK_TOKEN must be set to ${verb} the watch channel`,
      },
      500,
    );

  try {
    const details: Record<string, unknown> = {};

    if (action === "setup") {
      if (!WEBHOOK_URL || !WEBHOOK_TOKEN) return missingWatchEnv("create");

      const pageToken = await initializePageToken();
      details.pageToken = pageToken ? "present" : "missing";

      let watchInfo: WatchInfo | null = await getWatchInfo();
      let watchCreated = false;
      if (
        !watchInfo ||
        !watchInfo.expiration ||
        Date.now() > Number(watchInfo.expiration)
      ) {
        watchInfo = await createWatchChannel(WEBHOOK_URL, WEBHOOK_TOKEN);
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
        await getCachedDriveData(getRootFolderId(), () =>
          fetchDriveData(getRootFolderId()),
        );
        details.warmedFolder = getRootFolderId();
      }

      if (action === "delete" && opts.clearMeta) {
        await clearDriveMeta();
        details.metaCleared = true;
      }

      details.invalidated = invalidated;
    }

    if (action === "renew") {
      if (!WEBHOOK_URL || !WEBHOOK_TOKEN) return missingWatchEnv("renew");

      const result: WatchState = await renewWatchIfNeeded(
        WEBHOOK_URL,
        WEBHOOK_TOKEN,
      );
      details.renewed = result.renewed !== false;
      details.watch = {
        channelId: result.channelId,
        resourceId: result.resourceId || null,
        expiration: result.expiration
          ? new Date(Number(result.expiration)).toISOString()
          : null,
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
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

export { app };

export default {
  port: Number(process.env.PORT) || 3005,
  fetch: app.fetch,
};
