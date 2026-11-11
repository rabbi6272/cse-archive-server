import { randomUUID } from "crypto";
import type { drive_v3 } from "googleapis";
import { createDriveClient, getRootFolderId } from "../../config/drive";
import { getAdminDb } from "../../config/firebase";
import { env } from "../../config/env";
import {
  getCachedDriveData,
  invalidateAllDriveCaches,
  DRIVE_CACHE_TAG,
  DRIVE_CACHE_REVALIDATE_SECONDS,
} from "../../shared/cache";
import type {
  DriveFile,
  DriveFolderData,
  WatchInfo,
  WatchState,
  LastNotification,
  DriveChange,
  ProcessChangesResult,
} from "./drive.types";

export type {
  DriveFile,
  DriveFolderData,
  WatchInfo,
  WatchState,
  LastNotification,
  DriveChange,
  ProcessChangesResult,
};

const RTDB_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, label: string, ms = RTDB_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RTDB ${label} timed out after ${ms}ms (check FIREBASE_ADMIN_DATABASE_URL)`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function onceValue(path: string) {
  const db = getAdminDb();
  return withTimeout(db.ref(path).once("value"), `once(${path})`);
}

// ─── RTDB Meta Store ──────────────────────────────────────────

export async function getPageToken(): Promise<string | null> {
  const snap = await onceValue("drive/meta/pageToken");
  const token = snap.val();
  return typeof token === "string" ? token : null;
}

export async function setPageToken(token: string): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta/pageToken").set(token), "set(pageToken)");
  console.log("[DriveMeta] Page token updated");
}

export async function getWatchInfo(): Promise<WatchInfo | null> {
  const snap = await onceValue("drive/meta/watch");
  const val = snap.val();
  if (!val || typeof val !== "object") return null;
  return {
    channelId: val.channelId ?? "",
    resourceId: val.resourceId ?? null,
    expiration: val.expiration ? String(val.expiration) : null,
  };
}

export async function setWatchInfo(info: WatchInfo): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta/watch").set(info), "set(watch)");
}

export async function removeWatchInfo(): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta/watch").remove(), "remove(watch)");
}

export async function getLastNotification(): Promise<LastNotification | null> {
  const snap = await onceValue("drive/meta/lastNotification");
  const val = snap.val();
  if (!val || typeof val !== "object") return null;
  return {
    at: val.at ?? "",
    state: val.state ?? null,
    messageNumber: val.messageNumber ? String(val.messageNumber) : null,
    channelId: val.channelId ?? null,
  };
}

export async function setLastNotification(n: LastNotification): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta/lastNotification").set(n), "set(lastNotification)");
}

export async function clearDriveMeta(): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta").remove(), "remove(drive/meta)");
  console.log("[DriveMeta] Cleared drive/meta in RTDB");
}

// ─── Drive Fetching ───────────────────────────────────────────

export async function fetchDriveData(folderId: string): Promise<DriveFolderData> {
  const drive = await createDriveClient();

  const [folderInfo, filesResponse] = await Promise.all([
    drive.files.get({
      fileId: folderId,
      fields: "id, name, parents",
    }),
    drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, webViewLink, webContentLink, size, modifiedTime)",
      pageSize: 1000,
      orderBy: "name",
    }),
  ]);

  return {
    files: (filesResponse.data.files ?? []) as DriveFile[],
    parentFolderId: folderInfo.data.parents?.[0] ?? null,
    currentFolder: {
      id: folderInfo.data.id ?? "",
      name: folderInfo.data.name ?? "",
    },
  };
}

export async function getFolderData(folderId: string): Promise<DriveFolderData> {
  return getCachedDriveData(folderId, () => fetchDriveData(folderId));
}

// ─── Watch & Change Tracking ─────────────────────────────────

export async function createWatchChannel(webhookUrl: string, token: string): Promise<WatchState> {
  const drive = await createDriveClient();
  const channelId = randomUUID();

  let pageToken = await getPageToken();
  if (!pageToken) {
    const start = await drive.changes.getStartPageToken();
    pageToken = start.data.startPageToken ?? null;
  }
  if (!pageToken) {
    throw new Error("Cannot create Drive watch: no pageToken available");
  }

  const response = await drive.changes.watch({
    pageToken,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: webhookUrl,
      token: token,
    },
  });

  const { resourceId, expiration } = response.data ?? {};
  const watchState: WatchState = {
    channelId,
    resourceId: resourceId ?? null,
    expiration: expiration ? String(expiration) : null,
  };

  await setWatchInfo(watchState);
  console.log(`[DriveChanges] Watch created: channel=${channelId}`);
  return watchState;
}

export async function renewWatchIfNeeded(
  webhookUrl: string,
  token: string,
  safetyWindowMs = 24 * 60 * 60 * 1000,
): Promise<WatchState> {
  const watchInfo = await getWatchInfo();
  if (!watchInfo) {
    return await createWatchChannel(webhookUrl, token);
  }

  const expiration = Number(watchInfo.expiration);
  const remaining = Number.isFinite(expiration) ? expiration - Date.now() : 0;

  if (remaining <= safetyWindowMs) {
    await removeWatchInfo();
    return await createWatchChannel(webhookUrl, token);
  }

  return { ...watchInfo, renewed: false };
}

export async function initializePageToken(): Promise<string | null> {
  const existing = await getPageToken();
  if (existing) return existing;

  const drive = await createDriveClient();
  const response = await drive.changes.getStartPageToken();
  const token = response.data.startPageToken;
  if (!token) return null;

  await setPageToken(token);
  return token;
}

export async function processChanges(): Promise<ProcessChangesResult> {
  const drive = await createDriveClient();
  const pageToken = await getPageToken();
  if (!pageToken) {
    return { changes: [], newStartPageToken: null, hasRelevantChanges: false };
  }

  let allChanges: DriveChange[] = [];
  let nextPageToken: string | null = pageToken;
  let newStartPageToken: string | null = null;

  do {
    const response = (await drive.changes.list({
      pageToken: nextPageToken ?? undefined,
      pageSize: 1000,
      includeRemoved: true,
      fields: "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, parents, modifiedTime))",
    })) as drive_v3.Schema$ChangeList;

    const { changes, nextPageToken: next, newStartPageToken: nsp } = response ?? {};
    if (changes) allChanges = allChanges.concat(changes as DriveChange[]);
    nextPageToken = next ?? null;
    if (nsp) newStartPageToken = nsp;
  } while (nextPageToken);

  if (newStartPageToken) {
    await setPageToken(newStartPageToken);
  }

  return {
    changes: allChanges,
    newStartPageToken,
    hasRelevantChanges: true,
  };
}

export async function buildStatus() {
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
          expiration: watchInfo.expiration ? new Date(Number(watchInfo.expiration)).toISOString() : null,
          expired: watchInfo.expiration ? Date.now() > Number(watchInfo.expiration) : true,
        }
      : null,
    pageToken: pageToken ? "present" : "missing",
    lastNotification,
  };
}
