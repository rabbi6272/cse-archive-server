export const DRIVE_CACHE_TAG = "drive";
export const DRIVE_CACHE_REVALIDATE_SECONDS = 12 * 60 * 60;

// shortcut: per-process Map, lost on restart; move to Redis if Render ever runs >1 instance
const store = new Map<string, { data: unknown; at: number }>();

export async function invalidateAllDriveCaches(): Promise<boolean> {
  store.clear();
  console.log("[DriveCache] Invalidated all Drive caches");
  return true;
}

export async function getCachedDriveData<T>(
  folderId: string,
  fetchFn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(folderId);
  if (hit && Date.now() - hit.at < DRIVE_CACHE_REVALIDATE_SECONDS * 1000) {
    return hit.data as T;
  }

  const data = await fetchFn();
  store.set(folderId, { data, at: Date.now() });
  return data;
}
