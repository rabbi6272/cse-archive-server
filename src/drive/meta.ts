import { getAdminDb } from "../firebase-admin";

export interface WatchInfo {
  channelId: string;
  resourceId: string | null;
  expiration: string | null;
}

export interface LastNotification {
  at: string;
  state: string | null;
  messageNumber: string | null;
  channelId: string | null;
}

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

export async function setWatchInfo({
  channelId,
  resourceId,
  expiration,
}: WatchInfo): Promise<void> {
  const db = getAdminDb();
  await withTimeout(
    db.ref("drive/meta/watch").set({ channelId, resourceId, expiration: String(expiration) }),
    "set(watch)",
  );
  console.log(`[DriveMeta] Watch info stored: channel=${channelId}`);
}

export async function removeWatchInfo(): Promise<void> {
  const db = getAdminDb();
  await withTimeout(db.ref("drive/meta/watch").remove(), "remove(watch)");
}

export async function getLastNotification(): Promise<string | null> {
  const snap = await onceValue("drive/meta/lastNotification");
  const val = snap.val();
  if (!val || typeof val !== "object") return null;
  const at = val.at;
  return typeof at === "string" ? at : null;
}

export async function setLastNotification(
  notification: LastNotification,
): Promise<void> {
  const db = getAdminDb();
  await withTimeout(
    db.ref("drive/meta/lastNotification").set(notification),
    "set(lastNotification)",
  );
}

export async function clearDriveMeta(): Promise<void> {
  const db = getAdminDb();
  await withTimeout(
    Promise.all([
      db.ref("drive/meta/pageToken").remove(),
      db.ref("drive/meta/watch").remove(),
      db.ref("drive/meta/lastNotification").remove(),
    ]),
    "clear(drive/meta)",
  );
  console.log("[DriveMeta] Cleared drive/meta/*");
}
