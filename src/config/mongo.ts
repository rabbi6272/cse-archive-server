import { MongoClient, type Db, type Collection } from "mongodb";
import { env } from "./env";
import type { Profile, PrivateContact, LegacyProfile } from "../modules/profile/profile.types";
import type { Role } from "../modules/auth/auth.types";

export interface ProfileDoc extends Omit<Profile, "id"> {
  _id: string; // Firebase Auth uid
  nameLower?: string;
  migratedAt?: Date;
}

export interface PrivateContactDoc extends PrivateContact {
  _id: string; // Firebase Auth uid
  updatedAt?: Date;
}

export interface LegacyProfileDoc extends Omit<LegacyProfile, "legacyId"> {
  _id: string; // legacyId (hashKey of email)
  migratedAt?: Date;
}

export interface RollIndexDoc {
  _id: string; // roll number
  uid: string;
  claimedAt: Date;
}

export interface RateLimitDoc {
  _id: string; // sha256(key)
  lastSentAt?: Date; // cooldown limiter
  count?: number; // failure counter
  expireAt: Date;
}

/** Private per-account record holding the role. Never exposed via public listings. */
export interface UserDoc {
  _id: string; // Firebase Auth uid
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

/** Host part of the URI only — never logs credentials. */
function mongoHost(uri: string): string {
  return uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").split(/[/?]/)[0] || "(empty)";
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    const next = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    try {
      await next.connect();
    } catch (err) {
      // Don't cache a client that never connected; the next request retries.
      await next.close().catch(() => {});
      console.error(
        `[mongo] Connection to ${mongoHost(env.MONGODB_URI)} failed. Check MONGODB_URI on this host ` +
          `and that MongoDB Atlas Network Access allows this server's IP.`,
        err,
      );
      throw err;
    }
    client = next;
    console.log(`[mongo] Connected to ${mongoHost(env.MONGODB_URI)}, database: ${env.MONGODB_DB}`);
  }
  return client;
}

export async function getDb(): Promise<Db> {
  if (!db) {
    const c = await getMongoClient();
    db = c.db(env.MONGODB_DB);
  }
  return db;
}

export async function getProfilesCol(): Promise<Collection<ProfileDoc>> {
  const d = await getDb();
  return d.collection<ProfileDoc>("profiles");
}

export async function getPrivateContactsCol(): Promise<Collection<PrivateContactDoc>> {
  const d = await getDb();
  return d.collection<PrivateContactDoc>("privateContacts");
}

export async function getLegacyProfilesCol(): Promise<Collection<LegacyProfileDoc>> {
  const d = await getDb();
  return d.collection<LegacyProfileDoc>("legacyProfiles");
}

export async function getRollIndexCol(): Promise<Collection<RollIndexDoc>> {
  const d = await getDb();
  return d.collection<RollIndexDoc>("rollIndex");
}

export async function getRateLimitsCol(): Promise<Collection<RateLimitDoc>> {
  const d = await getDb();
  return d.collection<RateLimitDoc>("rateLimits");
}

export async function getUsersCol(): Promise<Collection<UserDoc>> {
  const d = await getDb();
  return d.collection<UserDoc>("users");
}

let indexesEnsured = false;

export async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const d = await getDb();

  try {
    // Profiles
    await d.collection("profiles").createIndex({ roll: 1 }, { unique: true, sparse: true });
    await d.collection("profiles").createIndex({ series: 1, sec: 1 });
    await d.collection("profiles").createIndex({ published: 1, series: 1 });
    await d.collection("profiles").createIndex({ nameLower: 1 });

    // Legacy profiles
    await d.collection("legacyProfiles").createIndex({ email: 1 }, { unique: true, sparse: true });

    // Users (roles)
    await d.collection("users").createIndex({ role: 1 });
    await d.collection("users").createIndex({ email: 1 });

    // Rate limits (TTL)
    await d.collection("rateLimits").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });

    indexesEnsured = true;
    console.log("[mongo] Indexes verified");
  } catch (err) {
    console.error("[mongo] Index creation error:", err);
  }
}
