import {
  getProfilesCol,
  getPrivateContactsCol,
  getLegacyProfilesCol,
  getRollIndexCol,
  type ProfileDoc,
} from "../mongo";
import type { Profile, PrivateContact, LegacyProfile, Section } from "../types/Student";

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
      updatedAt: Date.now(),
    },
    { upsert: true },
  );
}

export async function patchProfile(
  uid: string,
  patch: Partial<Profile> & { id?: string },
): Promise<void> {
  const col = await getProfilesCol();
  const { id: _ignored, ...fields } = patch;
  const updateData: Record<string, unknown> = {
    ...fields,
    updatedAt: Date.now(),
  };

  if (typeof fields.fullName === "string") {
    updateData.nameLower = fields.fullName.trim().toLowerCase();
  }

  await col.updateOne({ _id: uid }, { $set: updateData });
}

export async function deleteProfile(uid: string): Promise<void> {
  const [profilesCol, contactsCol, rollCol] = await Promise.all([
    getProfilesCol(),
    getPrivateContactsCol(),
    getRollIndexCol(),
  ]);

  const profile = await profilesCol.findOne({ _id: uid });
  if (profile?.roll) {
    await rollCol.deleteOne({ _id: profile.roll, uid });
  }

  await Promise.all([
    profilesCol.deleteOne({ _id: uid }),
    contactsCol.deleteOne({ _id: uid }),
  ]);
}

export async function getPrivateContact(uid: string): Promise<PrivateContact | null> {
  const col = await getPrivateContactsCol();
  const doc = await col.findOne({ _id: uid });
  if (!doc) return null;
  return { mobileNumber: doc.mobileNumber };
}

export async function setPrivateContact(uid: string, contact: PrivateContact): Promise<void> {
  const col = await getPrivateContactsCol();
  await col.updateOne(
    { _id: uid },
    {
      $set: {
        _id: uid,
        mobileNumber: contact.mobileNumber,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function findLegacyByEmail(email: string): Promise<LegacyProfile | null> {
  const col = await getLegacyProfilesCol();
  const doc = await col.findOne({ email: email.trim().toLowerCase() });
  if (!doc) return null;
  const { _id, migratedAt: _ma, ...rest } = doc;
  return { legacyId: _id, ...rest };
}

export async function removeLegacy(legacyId: string): Promise<void> {
  const col = await getLegacyProfilesCol();
  await col.deleteOne({ _id: legacyId });
}

export async function countUnclaimed(): Promise<number> {
  const [legacyCol, profileCol, rollCol] = await Promise.all([
    getLegacyProfilesCol(),
    getProfilesCol(),
    getRollIndexCol(),
  ]);

  const [allLegacy, allProfiles, allRolls] = await Promise.all([
    legacyCol.find({}, { projection: { _id: 1, roll: 1 } }).toArray(),
    profileCol.find({}, { projection: { _id: 1 } }).toArray(),
    rollCol.find({}, { projection: { _id: 1 } }).toArray(),
  ]);

  const claimed = new Set(allProfiles.map((p) => p._id));
  const reservedRolls = new Set(allRolls.map((r) => r._id));

  let unclaimed = 0;
  for (const doc of allLegacy) {
    if (claimed.has(doc._id)) continue;
    if (doc.roll && reservedRolls.has(doc.roll)) continue;
    unclaimed += 1;
  }

  return unclaimed;
}

export async function countPublishedBySeries(series: string): Promise<number> {
  const col = await getProfilesCol();
  return col.countDocuments({ series, published: true });
}

/**
 * Race-safe roll reservation via unique index on _id in rollIndex.
 * Returns true if successfully reserved, false if already held by another user.
 */
export async function reserveRoll(roll: string, uid: string): Promise<boolean> {
  const col = await getRollIndexCol();
  const normalizedRoll = roll.trim();

  try {
    const res = await col.updateOne(
      { _id: normalizedRoll },
      {
        $setOnInsert: {
          _id: normalizedRoll,
          uid,
          claimedAt: new Date(),
        },
      },
      { upsert: true },
    );
    // If it was already there and not upserted, check if held by same user
    if (!res.upsertedCount) {
      const existing = await col.findOne({ _id: normalizedRoll });
      return existing?.uid === uid;
    }
    return true;
  } catch (err: any) {
    if (err.code === 11000) {
      const existing = await col.findOne({ _id: normalizedRoll });
      return existing?.uid === uid;
    }
    throw err;
  }
}

export async function releaseRoll(roll: string, uid: string): Promise<void> {
  const col = await getRollIndexCol();
  await col.deleteOne({ _id: roll.trim(), uid });
}
