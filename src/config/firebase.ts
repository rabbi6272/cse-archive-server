import { cert, getApps, getApp, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getDatabase, type Database } from "firebase-admin/database";
import { getAuth, type Auth } from "firebase-admin/auth";
import { env } from "./env";

interface AdminSingleton {
  app?: App;
  db?: Database;
  auth?: Auth;
  loggedUrl?: boolean;
}

const globalStore = globalThis as typeof globalThis & { __firebaseAdmin?: AdminSingleton };

function loadServiceAccount(): ServiceAccount {
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim();
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const projectId = env.FIREBASE_ADMIN_PROJECT_ID?.trim();

  return { clientEmail, privateKey, projectId } as ServiceAccount;
}

function resolveDatabaseURL(): string {
  const url = env.FIREBASE_ADMIN_DATABASE_URL?.trim() || env.FIREBASE_DATABASE_URL?.trim();

  if (!url) {
    throw new Error(
      "Firebase Admin database URL missing. Set FIREBASE_ADMIN_DATABASE_URL to the regional RTDB URL (e.g. https://<project>-default-rtdb.<region>.firebasedatabase.app).",
    );
  }

  if (/^https:\/\/[^/]+-default-rtdb\.firebaseio\.com\/?$/.test(url)) {
    throw new Error(
      `Firebase Admin database URL looks non-regional: ${url}. Use the regional URL from Firebase console (e.g. https://<project>-default-rtdb.asia-southeast1.firebasedatabase.app). Non-regional URLs cause RTDB reads to hang.`,
    );
  }

  return url.replace(/\/+$/, "");
}

export function getAdminApp(): App {
  const store = globalStore.__firebaseAdmin;
  if (store?.app) return store.app;

  const existing = getApps();
  const app = existing.length > 0
    ? getApp()
    : initializeApp({
        credential: cert(loadServiceAccount()),
        databaseURL: resolveDatabaseURL(),
      });

  (globalStore.__firebaseAdmin ??= {}).app = app;
  if (!store?.loggedUrl) {
    console.log(
      `[FirebaseAdmin] initialized project=${env.FIREBASE_ADMIN_PROJECT_ID} databaseURL=${env.FIREBASE_ADMIN_DATABASE_URL}`,
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

export const adminAuth = getAdminAuth();
export default getAdminApp;

// ─── Identity Toolkit (Client Auth API) ──────────────────────────

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

export async function postIdentityToolkit<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(`${IDENTITY_TOOLKIT}/${path}?key=${env.FIREBASE_WEB_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`[auth] identity toolkit ${path} request failed:`, error);
    return { ok: false, code: "NETWORK_ERROR" };
  }

  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    idToken?: string;
  };

  if (response.ok) return { ok: true, data: data as T };

  const code = data.error?.message ?? "UNKNOWN";
  return { ok: false, code };
}

export type OobRequestType = "PASSWORD_RESET" | "EMAIL_SIGNIN" | "VERIFY_EMAIL";

export async function sendOobCode(options: {
  requestType: OobRequestType;
  email: string;
  idToken?: string;
  continueUrl?: string;
  canHandleCodeInApp?: boolean;
}): Promise<ApiResult<{ requestType?: string }>> {
  const body: Record<string, unknown> = {
    requestType: options.requestType,
    email: options.email.trim().toLowerCase(),
    returnOobLink: false,
  };
  if (options.idToken) body.idToken = options.idToken;
  if (options.continueUrl) body.continueUrl = options.continueUrl;
  if (options.canHandleCodeInApp !== undefined) {
    body.canHandleCodeInApp = options.canHandleCodeInApp;
  }

  const result = await postIdentityToolkit<{ requestType?: string }>(
    "accounts:sendOobCode",
    body,
  );

  const line = `[auth] oob ${options.requestType} ${maskEmail(body.email as string)} -> ${
    result.ok ? "sent" : result.code
  }`;
  if (result.ok) console.log(line);
  else console.error(line);
  return result;
}

export async function signInWithOutboundLink(
  oobCode: string,
  email: string,
): Promise<ApiResult<{ idToken: string; email?: string; localId?: string }>> {
  const result = await postIdentityToolkit<{ idToken: string; email?: string; localId?: string }>(
    "accounts:signInWithEmailLink",
    {
      oobCode,
      email: email.trim().toLowerCase(),
    },
  );

  const line = `[auth] oob-exchange ${maskEmail(email.trim().toLowerCase())} -> ${
    result.ok ? "ok" : result.code
  }`;
  if (result.ok) console.log(line);
  else console.error(line);
  return result;
}

export type VerifyPasswordResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: "invalid" | "unavailable" };

export async function verifyPassword(
  email: string,
  password: string,
): Promise<VerifyPasswordResult> {
  const result = await postIdentityToolkit<{ idToken?: string }>(
    "accounts:signInWithPassword",
    {
      email: email.trim().toLowerCase(),
      password,
      returnSecureToken: true,
    },
  );

  if (result.ok && result.data.idToken) {
    return { ok: true, idToken: result.data.idToken };
  }

  if (!result.ok) {
    if (result.code.includes("INVALID_LOGIN_CREDENTIALS") ||
        result.code.includes("EMAIL_NOT_FOUND") ||
        result.code.includes("INVALID_PASSWORD") ||
        result.code.includes("INVALID_EMAIL") ||
        result.code.includes("USER_DISABLED")) {
      return { ok: false, reason: "invalid" };
    }
  }

  return { ok: false, reason: "unavailable" };
}

export type SignUpResult =
  | { ok: true; idToken: string; uid: string }
  | { ok: false; reason: "exists" | "weak-password" | "unavailable" };

/** Creates an email/password account via Identity Toolkit `accounts:signUp`. */
export async function signUpWithPassword(email: string, password: string): Promise<SignUpResult> {
  const result = await postIdentityToolkit<{ idToken?: string; localId?: string }>("accounts:signUp", {
    email: email.trim().toLowerCase(),
    password,
    returnSecureToken: true,
  });

  if (result.ok && result.data.idToken && result.data.localId) {
    return { ok: true, idToken: result.data.idToken, uid: result.data.localId };
  }
  if (!result.ok && result.code.includes("EMAIL_EXISTS")) return { ok: false, reason: "exists" };
  if (!result.ok && result.code.includes("WEAK_PASSWORD")) return { ok: false, reason: "weak-password" };
  console.error(`[auth] signUp ${maskEmail(email)} -> ${!result.ok ? result.code : "no-token"}`);
  return { ok: false, reason: "unavailable" };
}

export type IdpSignInResult =
  | { ok: true; idToken: string; uid: string; email: string; isNewUser: boolean }
  | { ok: false; reason: "unavailable" };

/**
 * Signs in (or creates) a Firebase user from a verified Google OAuth `id_token`
 * via Identity Toolkit `accounts:signInWithIdp`.
 */
export async function signInWithIdp(googleIdToken: string, requestUri: string): Promise<IdpSignInResult> {
  const result = await postIdentityToolkit<{
    idToken?: string;
    localId?: string;
    email?: string;
    isNewUser?: boolean;
  }>("accounts:signInWithIdp", {
    postBody: new URLSearchParams({ id_token: googleIdToken, providerId: "google.com" }).toString(),
    requestUri,
    returnSecureToken: true,
    returnIdpCredential: false,
  });

  if (result.ok && result.data.idToken && result.data.localId) {
    return {
      ok: true,
      idToken: result.data.idToken,
      uid: result.data.localId,
      email: (result.data.email ?? "").toLowerCase(),
      isNewUser: result.data.isNewUser === true,
    };
  }
  console.error(`[auth] signInWithIdp -> ${!result.ok ? result.code : "no-token"}`);
  return { ok: false, reason: "unavailable" };
}

export async function idTokenForUid(uid: string): Promise<string> {
  const customToken = await adminAuth.createCustomToken(uid);
  const result = await postIdentityToolkit<{ idToken: string }>(
    "accounts:signInWithCustomToken",
    {
      token: customToken,
      returnSecureToken: true,
    },
  );
  if (!result.ok || !result.data.idToken) {
    throw new Error(`Failed to exchange custom token for idToken: ${!result.ok ? result.code : "no-token"}`);
  }
  return result.data.idToken;
}

export async function freshEmailVerified(uid: string): Promise<boolean> {
  try {
    const user = await adminAuth.getUser(uid);
    return user.emailVerified;
  } catch (err) {
    console.error(`[auth] failed to refresh emailVerified for ${uid}:`, err);
    return false;
  }
}
