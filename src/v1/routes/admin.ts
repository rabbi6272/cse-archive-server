import { Hono } from "hono";
import { requireSession, type AuthContext } from "../middleware/requireSession";
import { getProfilesCol } from "../mongo";
import { env } from "../env";

export const adminRoutes = new Hono<AuthContext>();

function isAdmin(email: string): boolean {
  const allowlist = env.ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.trim().toLowerCase());
}

adminRoutes.post("/broadcast", requireSession, async (c) => {
  const session = c.get("session");
  if (!isAdmin(session.email)) {
    return c.json({ ok: false, code: "forbidden", message: "Not authorised." }, 403);
  }

  const json = await c.req.json().catch(() => ({}));
  const subject = String(json.subject ?? "").trim();
  const body = String(json.body ?? "").trim();

  if (!subject) {
    return c.json({ ok: false, code: "invalid", message: "Subject is required." }, 400);
  }
  if (!body) {
    return c.json({ ok: false, code: "invalid", message: "Body is required." }, 400);
  }

  const col = await getProfilesCol();
  const profiles = await col
    .find({ published: true, email: { $exists: true, $ne: "" } }, { projection: { email: 1 } })
    .toArray();

  const recipients = profiles.map((p) => p.email).filter(Boolean);
  if (recipients.length === 0) {
    return c.json({ ok: true, message: "No recipients found.", recipientCount: 0 });
  }

  if (!env.RESEND_API_KEY) {
    console.warn("[admin] RESEND_API_KEY not configured; broadcast logged but not sent.");
    return c.json({
      ok: true,
      message: "Broadcast simulated (no RESEND_API_KEY configured).",
      recipientCount: recipients.length,
    });
  }

  try {
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
      return c.json({ ok: false, code: "send-failed", message: "Failed to send batch emails." }, 500);
    }

    return c.json({ ok: true, recipientCount: recipients.length });
  } catch (err) {
    console.error("[admin] Error sending broadcast:", err);
    return c.json({ ok: false, code: "error", message: "Internal server error." }, 500);
  }
});
