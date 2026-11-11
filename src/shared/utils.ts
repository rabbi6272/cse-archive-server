import { createHash, timingSafeEqual } from "node:crypto";

export function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")
    ? s.slice(0, 512)
    : "/";
}

export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
