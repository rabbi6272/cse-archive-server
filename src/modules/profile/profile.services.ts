import {
  getProfilesCol,
  getPrivateContactsCol,
  getLegacyProfilesCol,
  getRollIndexCol,
  type ProfileDoc,
} from "../../config/mongo";
import type { Profile, PrivateContact, LegacyProfile, Section } from "./profile.types";

export function toProfile(doc: ProfileDoc): Profile {
  const { _id, nameLower: _nl, migratedAt: _ma, ...rest } = doc;
  return {
    id: _id,
    ...rest,
  };
}

export async function findProfileById(uid: string): Promise<Profile | null> {
  const col = await getProfilesCol();
  const doc = await col.findOne({ _id: uid });
  return doc ? toProfile(doc) : null;
}

export async function findProfileByEmail(email: string): Promise<Profile | null> {
  const col = await getProfilesCol();
  const doc = await col.findOne({ email: email.trim().toLowerCase() });
  return doc ? toProfile(doc) : null;
}

export async function findProfileByRoll(roll: string): Promise<string | null> {
  const col = await getRollIndexCol();
  const doc = await col.findOne({ _id: roll.trim() });
  return doc ? doc.uid : null;
}

export interface ListProfilesOptions {
  series?: string;
  sec?: Section;
  q?: string;
  limit?: number;
  cursor?: string;
}

export async function listPublicProfiles(options: ListProfilesOptions = {}): Promise<{
  profiles: Array<Omit<Profile, "email">>;
  nextCursor?: string;
}> {
  const col = await getProfilesCol();
  const filter: Record<string, unknown> = { published: true };

  if (options.series) {
    filter.series = options.series;
  }
  if (options.sec) {
    filter.sec = options.sec;
  }
  if (options.q) {
    const qLower = options.q.trim().toLowerCase();
    filter.nameLower = { $regex: `^${qLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
  }
  if (options.cursor) {
    filter._id = { $gt: options.cursor };
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  // Exclude email and internal fields in public projection
  const docs = await col
    .find(filter, {
      projection: {
        email: 0,
        nameLower: 0,
        migratedAt: 0,
      },
    })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .toArray();

  let nextCursor: string | undefined;
  if (docs.length > limit) {
    const nextItem = docs.pop();
    nextCursor = nextItem?._id;
  }

  const profiles = docs.map((doc) => {
    const { _id, ...rest } = doc;
    return {
      id: _id,
      ...rest,
    } as Omit<Profile, "email">;
  });

  return { profiles, nextCursor };
}

export async function writeProfile(uid: string, profile: Profile): Promise<void> {
  const col = await getProfilesCol();
  const { id: _ignored, ...fields } = profile;
  const nameLower = fields.fullName.trim().toLowerCase();

  await col.replaceOne(
    { _id: uid },
    {
      ...fields,
      nameLower,
    },
    { upsert: true },
  );
}

export async function patchProfile(
  uid: string,
  patch: Partial<Omit<Profile, "id" | "createdAt">>,
): Promise<void> {
  const col = await getProfilesCol();
  const updateDoc: Record<string, unknown> = {
    ...patch,
    updatedAt: Date.now(),
  };

  if (patch.fullName) {
    updateDoc.nameLower = patch.fullName.trim().toLowerCase();
  }

  await col.updateOne({ _id: uid }, { $set: updateDoc });
}

export async function deleteProfile(uid: string): Promise<void> {
  const profiles = await getProfilesCol();
  const contacts = await getPrivateContactsCol();

  await Promise.all([
    profiles.deleteOne({ _id: uid }),
    contacts.deleteOne({ _id: uid }),
  ]);
}

export async function reserveRoll(roll: string, uid: string): Promise<boolean> {
  const col = await getRollIndexCol();
  try {
    const res = await col.updateOne(
      { _id: roll.trim() },
      {
        $setOnInsert: {
          _id: roll.trim(),
          uid,
          claimedAt: new Date(),
        },
      },
      { upsert: true },
    );
    // Matched means already held by someone else
    return res.upsertedCount > 0;
  } catch {
    return false;
  }
}

export async function releaseRoll(roll: string, uid: string): Promise<void> {
  const col = await getRollIndexCol();
  await col.deleteOne({ _id: roll.trim(), uid });
}

export async function getPrivateContact(uid: string): Promise<PrivateContact | null> {
  const col = await getPrivateContactsCol();
  const doc = await col.findOne({ _id: uid });
  if (!doc) return null;
  return { mobileNumber: doc.mobileNumber };
}

export async function setPrivateContact(uid: string, contact: PrivateContact): Promise<void> {
  const col = await getPrivateContactsCol();
  await col.replaceOne(
    { _id: uid },
    {
      mobileNumber: contact.mobileNumber,
      updatedAt: new Date(),
    },
    { upsert: true },
  );
}

export async function findLegacyByEmail(email: string): Promise<LegacyProfile | null> {
  const col = await getLegacyProfilesCol();
  const doc = await col.findOne({ email: email.trim().toLowerCase() });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return {
    legacyId: _id,
    ...rest,
  };
}

export async function removeLegacy(email: string): Promise<void> {
  const col = await getLegacyProfilesCol();
  await col.deleteOne({ email: email.trim().toLowerCase() });
}

export async function countUnclaimed(): Promise<number> {
  const col = await getLegacyProfilesCol();
  return col.countDocuments();
}
