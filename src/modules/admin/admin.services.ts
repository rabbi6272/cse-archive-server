import { env } from "../../config/env";
import { getProfilesCol } from "../../config/mongo";
import { adminAuth } from "../../config/firebase";
import { reserveRoll, releaseRoll } from "../profile/profile.services";

export function isAuthorizedAdmin(email: string): boolean {
  const allowlist = env.ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.trim().toLowerCase());
}

export async function sendBroadcastEmail(
  subject: string,
  body: string,
): Promise<{ ok: boolean; recipientCount: number; message?: string }> {
  const col = await getProfilesCol();
  const profiles = await col
    .find({ published: true, email: { $exists: true, $ne: "" } }, { projection: { email: 1 } })
    .toArray();

  const recipients = profiles.map((p) => p.email).filter(Boolean);
  if (recipients.length === 0) {
    return { ok: true, recipientCount: 0, message: "No recipients found." };
  }

  if (!env.RESEND_API_KEY) {
    console.warn("[admin] RESEND_API_KEY not configured; broadcast logged but not sent.");
    return {
      ok: true,
      recipientCount: recipients.length,
      message: "Broadcast simulated (no RESEND_API_KEY configured).",
    };
  }

  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      recipients.map((to) => ({
        from: "RUET CSE <updates@ruetcsearchive.app>",
        to,
        subject,
        text: body,
      })),
    ),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[admin] Resend broadcast batch failed:", err);
    throw new Error("Failed to send batch emails.");
  }

  return { ok: true, recipientCount: recipients.length };
}

export async function setCustomClaims(uid: string, claims: Record<string, any>): Promise<void> {
  await adminAuth.setCustomUserClaims(uid, claims);
}

export { reserveRoll, releaseRoll };
