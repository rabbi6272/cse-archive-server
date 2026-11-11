import { MongoClient, type Db, type Collection } from "mongodb";
import { env } from "./env";
import type { Profile, PrivateContact, LegacyProfile } from "../modules/profile/profile.types";

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
  lastSentAt: Date;
  expireAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    console.log(`[mongo] Connected to MongoDB database: ${env.MONGODB_DB}`);
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

    // Rate limits (TTL)
    await d.collection("rateLimits").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });

    indexesEnsured = true;
    console.log("[mongo] Indexes verified");
  } catch (err) {
    console.error("[mongo] Index creation error:", err);
  }
}
