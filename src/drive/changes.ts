import { randomUUID } from "crypto";
import { createDriveClient } from "./auth";
import type { drive_v3 } from "googleapis";
import {
  getPageToken,
  setPageToken,
  getWatchInfo,
  setWatchInfo,
  removeWatchInfo,
  type WatchInfo,
} from "./meta";

export interface DriveChange {
  fileId?: string;
  removed?: boolean;
  file?: {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    modifiedTime?: string;
  } | null;
}

export interface ProcessChangesResult {
  changes: DriveChange[];
  newStartPageToken: string | null;
  hasRelevantChanges: boolean;
}

export type WatchState = WatchInfo & { renewed?: boolean };

// =================== Watch Channel ===================

export async function createWatchChannel(
  webhookUrl: string,
  token: string,
): Promise<WatchState> {
  const drive = await createDriveClient();
  const channelId = randomUUID();

  // changes.watch requires pageToken (query param). Prefer the stored token so
  // the watch resumes from the same stream; otherwise fetch a fresh start token.
  let pageToken = await getPageToken();
  if (!pageToken) {
    const start = await drive.changes.getStartPageToken();
    pageToken = start.data.startPageToken ?? null;
  }
  if (!pageToken) {
    throw new Error(
      "Cannot create Drive watch: no pageToken available (changes.getStartPageToken failed)",
    );
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

  console.log(
    `[DriveChanges] Watch created: channel=${channelId}, expires=${watchState.expiration ?? "unknown"}`,
  );

  return watchState;
}

// =================== Renewal Check ===================

export async function renewWatchIfNeeded(
  webhookUrl: string,
  token: string,
  safetyWindowMs = 24 * 60 * 60 * 1000,
): Promise<WatchState> {
  const watchInfo = await getWatchInfo();

  if (!watchInfo) {
    console.log("[DriveChanges] No watch found, creating new one");
    return await createWatchChannel(webhookUrl, token);
  }

  const expiration = Number(watchInfo.expiration);
  const now = Date.now();
  const remaining = Number.isFinite(expiration) ? expiration - now : 0;

  if (remaining <= safetyWindowMs) {
    console.log(
      `[DriveChanges] Watch expiring in ${Math.round(remaining / 3600000)}h, renewing`,
    );
    await removeWatchInfo();
    return await createWatchChannel(webhookUrl, token);
  }

  console.log(
    `[DriveChanges] Watch valid for ${Math.round(remaining / 3600000)}h, no renewal needed`,
  );
  return { ...watchInfo, renewed: false };
}

// =================== Initialize Token ===================

export async function initializePageToken(): Promise<string | null> {
  const existing = await getPageToken();
  if (existing) {
    console.log(
      "[DriveChanges] Page token already exists, skipping initialization",
    );
    return existing;
  }

  const drive = await createDriveClient();
  const response = await drive.changes.getStartPageToken();
  const token = response.data.startPageToken;

  if (!token) {
    console.log("[DriveChanges] No start page token returned");
    return null;
  }

  await setPageToken(token);
  console.log(`[DriveChanges] Initial page token obtained: ${token}`);
  return token;
}

// =================== Process Changes ===================

export async function processChanges(): Promise<ProcessChangesResult> {
  const drive = await createDriveClient();
  const pageToken = await getPageToken();

  if (!pageToken) {
    console.log("[DriveChanges] No page token, cannot process changes");
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
      fields:
        "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, parents, modifiedTime))",
    })) as drive_v3.Schema$ChangeList;

    const { changes, nextPageToken: next, newStartPageToken: nsp } =
      response ?? {};

    if (changes) {
      allChanges = allChanges.concat(changes as DriveChange[]);
    }

    nextPageToken = next ?? null;
    if (nsp) newStartPageToken = nsp;
  } while (nextPageToken);

  console.log(`[DriveChanges] Fetched ${allChanges.length} change(s)`);

  if (newStartPageToken) {
    await setPageToken(newStartPageToken);
  }

  return {
    changes: allChanges,
    newStartPageToken,
    hasRelevantChanges: true,
  };
}