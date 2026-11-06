import { getFirestore } from "firebase-admin/firestore";
import { MongoClient } from "mongodb";
import getAdmin, { getAdminAuth } from "../src/firebase-admin";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ruetcse";

if (!uri) {
  console.error("MONGODB_URI must be set in environment.");
  process.exit(1);
}

const fs = getFirestore(getAdmin());
const auth = getAdminAuth();
const mongo = new MongoClient(uri);
await mongo.connect();
const db = mongo.db(dbName);

console.log(`[verify] Verifying MongoDB database "${dbName}" against Firestore...`);

let issues = 0;
function report(checkName: string, passed: boolean, extra = "") {
  const symbol = passed ? "✓" : "✗";
  console.log(`${symbol} ${checkName}${extra ? ` (${extra})` : ""}`);
  if (!passed) issues++;
}

// 1. Document Counts Check
const [fsProfiles, mongoProfiles] = await Promise.all([
  fs.collection("profiles").count().get(),
  db.collection("profiles").countDocuments(),
]);
report("Profiles count matches", fsProfiles.data().count === mongoProfiles, `FS: ${fsProfiles.data().count}, Mongo: ${mongoProfiles}`);

const [fsLegacy, mongoLegacy] = await Promise.all([
  fs.collection("legacyProfiles").count().get(),
  db.collection("legacyProfiles").countDocuments(),
]);
report("Legacy profiles count matches", fsLegacy.data().count === mongoLegacy, `FS: ${fsLegacy.data().count}, Mongo: ${mongoLegacy}`);

const [fsRolls, mongoRolls] = await Promise.all([
  fs.collection("rollIndex").count().get(),
  db.collection("rollIndex").countDocuments(),
]);
report("RollIndex count matches", fsRolls.data().count === mongoRolls, `FS: ${fsRolls.data().count}, Mongo: ${mongoRolls}`);

// 2. Unique Rolls Check in Mongo
const duplicateRolls = await db
  .collection("profiles")
  .aggregate([
    { $match: { roll: { $exists: true, $ne: "" } } },
    { $group: { _id: "$roll", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ])
  .toArray();
report("Profiles roll numbers are unique", duplicateRolls.length === 0, `${duplicateRolls.length} duplicates`);

// 3. Lowercased emails in legacyProfiles
const upperLegacy = await db
  .collection("legacyProfiles")
  .find({ email: { $regex: /[A-Z]/ } })
  .toArray();
report("Legacy profiles emails are all lowercased", upperLegacy.length === 0, `${upperLegacy.length} uppercase`);

// 4. Sample Deep Verification
console.log("[verify] Sampling 50 profiles for deep inspection...");
const sampleDocs = await db.collection("profiles").aggregate([{ $sample: { size: 50 } }]).toArray();
let sampleMatches = 0;
for (const mDoc of sampleDocs) {
  const fsDoc = await fs.collection("profiles").doc(mDoc._id).get();
  if (fsDoc.exists) {
    const fsData = fsDoc.data()!;
    if (fsData.roll === mDoc.roll && fsData.fullName === mDoc.fullName) {
      sampleMatches++;
    }
  }
}
report("Sampled profiles match Firestore source", sampleMatches === sampleDocs.length, `${sampleMatches}/${sampleDocs.length}`);

// 5. Check Firebase Auth Users
console.log("[verify] Checking batch of profile UIDs in Firebase Auth...");
const profileUids = sampleDocs.slice(0, 50).map((d) => ({ uid: d._id }));
if (profileUids.length > 0) {
  const authUsers = await auth.getUsers(profileUids);
  report("Sampled profiles exist in Firebase Auth", authUsers.users.length === profileUids.length, `${authUsers.users.length}/${profileUids.length}`);
}

console.log("-----------------------------------------");
if (issues === 0) {
  console.log("🎉 All verification checks passed!");
} else {
  console.error(`⚠️ Found ${issues} verification issue(s).`);
}

await mongo.close();
process.exit(issues === 0 ? 0 : 1);
