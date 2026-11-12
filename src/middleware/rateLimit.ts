import { getRateLimitsCol } from "../config/mongo";
import { sha256 } from "../shared/utils";

const DUPLICATE_KEY = 11000;

/**
 * Single-hit cooldown limiter (default 60s), atomic.
 * Returns true if rate limited (i.e. cooldown not yet elapsed).
 *
 * The update only matches when the previous hit is older than the cooldown. If a
 * fresh record exists, the upsert collides on `_id` and Mongo raises a duplicate
 * key error, which means "still cooling down".
 */
export async function checkRateLimit(key: string, cooldownSeconds = 60): Promise<boolean> {
  const col = await getRateLimitsCol();
  const id = sha256(`cooldown:${key}`);
  const now = new Date();
  const cutoff = new Date(now.getTime() - cooldownSeconds * 1000);

  try {
    await col.updateOne(
      { _id: id, $or: [{ lastSentAt: { $lte: cutoff } }, { lastSentAt: { $exists: false } }] },
      { $set: { lastSentAt: now, expireAt: new Date(now.getTime() + cooldownSeconds * 1000) } },
      { upsert: true },
    );
    return false;
  } catch (err: any) {
    if (err?.code === DUPLICATE_KEY) return true;
    throw err;
  }
}

/** Returns true when `key` has reached `max` failures within the current window. */
export async function isLocked(key: string, max: number): Promise<boolean> {
  const col = await getRateLimitsCol();
  const doc = await col.findOne({ _id: sha256(`fail:${key}`) });
  return Boolean(doc && (doc.count ?? 0) >= max && doc.expireAt.getTime() > Date.now());
}

/**
 * Atomically records a failure for `key`. The window starts at the first failure;
 * once `max` is reached the record is extended to `lockSeconds` from now.
 * Returns the failure count after this call.
 */
export async function recordFailure(
  key: string,
  max: number,
  windowSeconds: number,
  lockSeconds = windowSeconds,
): Promise<number> {
  const col = await getRateLimitsCol();
  const id = sha256(`fail:${key}`);
  const now = Date.now();

  // Expired-but-not-yet-reaped records start a fresh window.
  await col.deleteOne({ _id: id, expireAt: { $lte: new Date(now) } });

  const doc = await col.findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(now + windowSeconds * 1000) } },
    { upsert: true, returnDocument: "after" },
  );

  const count = doc?.count ?? 1;
  if (count >= max) {
    await col.updateOne({ _id: id }, { $set: { expireAt: new Date(now + lockSeconds * 1000) } });
  }
  return count;
}

export async function clearFailures(...keys: string[]): Promise<void> {
  const col = await getRateLimitsCol();
  await col.deleteMany({ _id: { $in: keys.map((k) => sha256(`fail:${k}`)) } });
}

/** Best-effort client IP (behind Render / Vercel proxies). */
export function clientIp(headers: (name: string) => string | undefined): string {
  const fwd = headers("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers("x-real-ip") || headers("cf-connecting-ip") || "unknown";
}
