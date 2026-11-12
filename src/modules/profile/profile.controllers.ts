import type { Context } from "hono";
import type { AuthContext } from "../../middleware/requireSession";
import {
  listPublicProfiles,
  findProfileById,
  writeProfile,
  reserveRoll,
  releaseOtherRolls,
  setPrivateContact,
} from "./profile.services";
import { createProfileSchema, seriesFromRoll, type Profile, type Section } from "./profile.types";

export async function listProfilesController(c: Context) {
  const series = c.req.query("series");
  const sec = c.req.query("sec") as Section | undefined;
  const q = c.req.query("q");
  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 250;

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
}

export async function getProfileByIdController(c: Context) {
  const uid = c.req.param("uid") ?? "";
  try {
    const profile = await findProfileById(uid);
    if (!profile || !profile.published) {
      return c.json({ ok: false, code: "not-found", message: "Profile not found." }, 404);
    }

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ ok: true, profile });
  } catch (err) {
    console.error(`[profiles] Error getting profile for ${uid}:`, err);
    return c.json({ ok: false, code: "error", message: "Failed to get profile." }, 500);
  }
}

export async function createProfileController(c: Context<AuthContext>) {
  const session = c.get("session");
  const json = await c.req.json().catch(() => ({}));
  const parsed = createProfileSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const existing = await findProfileById(session.uid);
  if (existing) {
    return c.json({ ok: false, code: "exists", message: "Profile already exists." }, 409);
  }

  const { profile: draft, contact } = parsed.data;
  const seriesConfig = seriesFromRoll(draft.roll);
  if (!seriesConfig) {
    return c.json({ ok: false, code: "bad-series", message: "Roll number does not match any registered series." }, 400);
  }

  const reserved = await reserveRoll(draft.roll, session.uid);
  if (!reserved) {
    return c.json({ ok: false, code: "roll-held", message: "This roll number is already registered to another user." }, 409);
  }

  const now = Date.now();
  const profile: Profile = {
    id: session.uid,
    fullName: draft.fullName,
    nickname: draft.nickname ?? "",
    email: session.email,
    roll: draft.roll,
    series: seriesConfig.id,
    sec: draft.sec,
    bloodGroup: draft.bloodGroup ?? "",
    bio: draft.bio ?? "",
    hobby: draft.hobby ?? "",
    fbProfile: draft.fbProfile ?? "",
    profilePicture: draft.profilePicture ?? { publicId: "", url: "" },
    published: true,
    createdAt: now,
    updatedAt: now,
    claimedAt: now,
  };

  try {
    await writeProfile(session.uid, profile);
    // Drop a different roll that may have been reserved at sign-up.
    await releaseOtherRolls(session.uid, profile.roll).catch(() => {});
    if (contact && contact.mobileNumber) {
      await setPrivateContact(session.uid, contact);
    }
    return c.json({ ok: true, profile });
  } catch (err) {
    console.error("[profiles] Error writing profile:", err);
    return c.json({ ok: false, code: "error", message: "Failed to save profile." }, 500);
  }
}
