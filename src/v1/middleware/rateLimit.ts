import { getRateLimitsCol } from "../mongo";

export function sha256(val: string): string {
  return new Bun.CryptoHasher("sha256").update(val).digest("hex");
}

/**
 * Checks and records rate limits (default 60s cooldown).
 * Returns true if rate limited (i.e. cooldown not yet elapsed).
 */
export async function checkRateLimit(key: string, cooldownSeconds = 60): Promise<boolean> {
  const col = await getRateLimitsCol();
  const id = sha256(key);
  const now = new Date();

  const existing = await col.findOne({ _id: id });
  if (existing) {
    const elapsedMs = now.getTime() - new Date(existing.lastSentAt).getTime();
    if (elapsedMs < cooldownSeconds * 1000) {
      return true; // Still in cooldown
    }
  }

  const expireAt = new Date(now.getTime() + cooldownSeconds * 1000);
  await col.updateOne(
    { _id: id },
    { $set: { lastSentAt: now, expireAt } },
    { upsert: true },
  );

  return false;
}
