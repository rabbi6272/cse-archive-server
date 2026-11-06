import { Hono } from "hono";
import {
  listPublicProfiles,
  findProfileById,
  writeProfile,
  reserveRoll,
  releaseRoll,
  setPrivateContact,
} from "../repo/students.repo";
import { requireSession, type AuthContext } from "../middleware/requireSession";
import { requireVerified } from "../middleware/requireVerified";
import { createProfileSchema } from "../schemas";
import { seriesFromRoll } from "../types/series";
import type { Profile, Section } from "../types/Student";

export const profilesRoutes = new Hono<AuthContext>();

// GET /profiles - List published profiles with filtering & cursor pagination
profilesRoutes.get("/", async (c) => {
  const series = c.req.query("series");
  const sec = c.req.query("sec") as Section | undefined;
  const q = c.req.query("q");
  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

  try {
    const result = await listPublicProfiles({
      series,
      sec,
      q,
      cursor,
      limit,
    });

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[profiles] Error listing profiles:", err);
    return c.json({ ok: false, code: "error", message: "Failed to list profiles." }, 500);
  }
});

// GET /profiles/:uid - Single published profile
profilesRoutes.get("/:uid", async (c) => {
  const uid = c.req.param("uid");
  try {
    const profile = await findProfileById(uid);
    if (!profile || !profile.published) {
      return c.json({ ok: false, code: "not-found", message: "Profile not found." }, 404);
    }

    // Strip email in public projection
    const { email: _email, ...publicProfile } = profile;
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ ok: true, profile: publicProfile });
  } catch (err) {
    console.error(`[profiles] Error getting profile for ${uid}:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to get profile." }, 500);
  }
});

// POST /profiles - Create own profile (requires session + verified email)
profilesRoutes.post("/", requireSession, requireVerified, async (c) => {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = createProfileSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  // Check if profile already exists
  const existing = await findProfileById(session.uid);
  if (existing) {
    return c.json({ ok: false, code: "exists", message: "Profile already exists." }, 409);
  }

  const { profile: draft, contact } = parsed.data;
  const seriesConfig = seriesFromRoll(draft.roll);
  if (!seriesConfig) {
    return c.json({ ok: false, code: "bad-series", message: "Roll number does not match any registered series." }, 400);
  }

  // Attempt to reserve the roll
  const reserved = await reserveRoll(draft.roll, session.uid);
  if (!reserved) {
    return c.json({ ok: false, code: "roll-held", message: "This roll number is already registered to another user." }, 409);
  }

  const now = Date.now();
  const profile: Profile = {
    id: session.uid,
    fullName: draft.fullName,
    nickname: draft.nickname,
    email: session.email,
    roll: draft.roll,
    series: seriesConfig.id,
    sec: draft.sec,
    bloodGroup: draft.bloodGroup,
    bio: draft.bio,
    hobby: draft.hobby,
    fbProfile: draft.fbProfile,
    profilePicture: draft.profilePicture,
    published: true,
    createdAt: now,
    updatedAt: now,
    claimedAt: now,
  };

  try {
    await writeProfile(session.uid, profile);
    await setPrivateContact(session.uid, contact);
    return c.json({ ok: true, profile });
  } catch (err) {
    console.error("[profiles] Error creating profile:", err);
    await releaseRoll(draft.roll, session.uid).catch(() => {});
    return c.json({ ok: false, code: "error", message: "Failed to create profile." }, 500);
  }
});
