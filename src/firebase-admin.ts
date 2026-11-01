import { cert, getApps, getApp, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getDatabase, type Database } from "firebase-admin/database";
import { getAuth, type Auth } from "firebase-admin/auth";

interface AdminSingleton {
  app?: App;
  db?: Database;
  auth?: Auth;
  loggedUrl?: boolean;
}

const globalStore = globalThis as typeof globalThis & { __firebaseAdmin?: AdminSingleton };

function loadServiceAccount(): ServiceAccount {
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID?.trim();

  const missing = [
    !clientEmail && "FIREBASE_ADMIN_CLIENT_EMAIL",
    !privateKey && "FIREBASE_ADMIN_PRIVATE_KEY",
    !projectId && "FIREBASE_ADMIN_PROJECT_ID",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `Firebase Admin credentials missing: ${missing.join(", ")}. Set them in .env.local / Vercel env.`,
    );
  }

  return { clientEmail, privateKey, projectId } as ServiceAccount;
}

function resolveDatabaseURL(): string {
  const url =
    process.env.FIREBASE_ADMIN_DATABASE_URL?.trim() ||
    process.env.FIREBASE_DATABASE_URL?.trim();

  if (!url) {
    throw new Error(
      "Firebase Admin database URL missing. Set FIREBASE_ADMIN_DATABASE_URL to the regional RTDB URL (e.g. https://<project>-default-rtdb.<region>.firebasedatabase.app). Do not fall back to NEXT_PUBLIC_FIREBASE_DATABASE_URL — it may point at a different project and cause requests to hang.",
    );
  }

  // Non-regional firebaseio.com URLs hang forever when the instance lives in a region.
  // Fail fast instead of letting .once() never resolve.
  if (/^https:\/\/[^/]+-default-rtdb\.firebaseio\.com\/?$/.test(url)) {
    throw new Error(
      `Firebase Admin database URL looks non-regional: ${url}. Use the regional URL from Firebase console (e.g. https://<project>-default-rtdb.asia-southeast1.firebasedatabase.app). Non-regional URLs cause RTDB reads to hang.`,
    );
  }

  return url.replace(/\/+$/, "");
}

function getAdminApp(): App {
  const store = globalStore.__firebaseAdmin;
  if (store?.app) return store.app;

  const existing = getApps();
  const app = existing.length > 0 ? getApp() : initializeApp({
    credential: cert(loadServiceAccount()),
    databaseURL: resolveDatabaseURL(),
  });

  (globalStore.__firebaseAdmin ??= {}).app = app;
  if (!store?.loggedUrl) {
    console.log(
      `[FirebaseAdmin] initialized project=${process.env.FIREBASE_ADMIN_PROJECT_ID} databaseURL=${process.env.FIREBASE_ADMIN_DATABASE_URL}`,
    );
    (globalStore.__firebaseAdmin ??= {}).loggedUrl = true;
  }
  return app;
}

export function getAdminDb(): Database {
  const store = globalStore.__firebaseAdmin;
  if (store?.db) return store.db;
  const db = getDatabase(getAdminApp());
  (globalStore.__firebaseAdmin ??= {}).db = db;
  return db;
}

export function getAdminAuth(): Auth {
  const store = globalStore.__firebaseAdmin;
  if (store?.auth) return store.auth;
  const auth = getAuth(getAdminApp());
  (globalStore.__firebaseAdmin ??= {}).auth = auth;
  return auth;
}

export default function getAdmin(): App {
  return getAdminApp();
}
