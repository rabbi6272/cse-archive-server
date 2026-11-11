import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { MongoClient } from "mongodb";
import getAdmin from "../src/firebase-admin";

const DRY = process.argv.includes("--dry-run");
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "CseArchive";

if (!uri) {
  console.error("MONGODB_URI must be set in environment.");
  process.exit(1);
}

const fs = getFirestore(getAdmin());
const mongo = new MongoClient(uri);
await mongo.connect();
const db = mongo.db(dbName);

console.log(`[migration] Starting Firestore -> MongoDB migration ${DRY ? "(DRY RUN)" : ""}`);
console.log(`[migration] Target MongoDB database: ${dbName}`);

function normalize(v: any): any {
  if (v instanceof Timestamp) return v.toDate();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

async function copyCollection(
  name: string,
  targetColName: string = name,
  mapDoc: (id: string, data: any) => any = (_id, data) => data,
) {
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let total = 0;
  const errors: unknown[] = [];

  for (; ;) {
    let q = fs.collection(name).orderBy("__name__").limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const ops = snap.docs.map((d) => {
      const normalized = normalize(d.data());
      const mapped = mapDoc(d.id, normalized);
      return {
        replaceOne: {
          filter: { _id: d.id },
          replacement: {
            _id: d.id,
            ...mapped,
            migratedAt: new Date(),
          },
          upsert: true,
        },
      };
    });

    if (!DRY) {
      try {
        await db.collection(targetColName).bulkWrite(ops as any, { ordered: false });
      } catch (e) {
        errors.push(e);
      }
    }

    total += snap.size;
    last = snap.docs.at(-1);
  }

  console.log(
    `${DRY ? "[dry] " : ""}${name} -> ${targetColName}: ${total} docs processed, ${errors.length} batch errors`,
  );
  return { total, errors };
}

// 1. Migrate Profiles
await copyCollection("profiles", "profiles", (id, d) => {
  const fullName = typeof d.fullName === "string" ? d.fullName : "";
  return {
    ...d,
    nameLower: fullName.trim().toLowerCase(),
  };
});

// 2. Migrate Private Contacts from profiles/{uid}/private/contact
console.log("[migration] Copying private contact subcollections...");
let contactCount = 0;
const profilesSnap = await fs.collection("profiles").get();
const contactOps: any[] = [];

for (const profileDoc of profilesSnap.docs) {
  const contactSnap = await profileDoc.ref.collection("private").doc("contact").get();
  if (contactSnap.exists) {
    const data = normalize(contactSnap.data());
    contactOps.push({
      replaceOne: {
        filter: { _id: profileDoc.id },
        replacement: {
          _id: profileDoc.id,
          ...data,
          migratedAt: new Date(),
        },
        upsert: true,
      },
    });
    contactCount++;
  }
}

if (!DRY && contactOps.length > 0) {
  await db.collection("privateContacts").bulkWrite(contactOps, { ordered: false });
}
console.log(`${DRY ? "[dry] " : ""}privateContacts: ${contactCount} docs migrated`);

// 3. Migrate Legacy Profiles
await copyCollection("legacyProfiles", "legacyProfiles", (_id, d) => ({
  ...d,
  email: String(d.email ?? "").trim().toLowerCase(),
}));

// 4. Migrate Roll Index
await copyCollection("rollIndex", "rollIndex");

console.log("[migration] Firestore -> MongoDB copy finished.");
await mongo.close();
process.exit(0);
