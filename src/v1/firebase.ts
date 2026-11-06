import { getAdminAuth } from "../firebase-admin";
import { env } from "./env";

export const adminAuth = getAdminAuth();

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
  const result = await postIdentityToolkit<{ idToken: string }>(
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

  const code = result.ok ? "" : result.code;
  if (
    code.includes("INVALID_PASSWORD") ||
    code.includes("EMAIL_NOT_FOUND") ||
    code.includes("USER_DISABLED") ||
    code.includes("INVALID_LOGIN_CREDENTIALS")
  ) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: false, reason: "unavailable" };
}

export async function idTokenForUid(uid: string): Promise<string | null> {
  try {
    const customToken = await adminAuth.createCustomToken(uid);
    const exchange = await postIdentityToolkit<{ idToken: string }>(
      "accounts:signInWithCustomToken",
      { token: customToken, returnSecureToken: true },
    );
    if (!exchange.ok || !exchange.data.idToken) {
      console.error("[auth] custom token exchange failed:", exchange);
      return null;
    }
    return exchange.data.idToken;
  } catch (err) {
    console.error("[auth] failed to create custom token:", err);
    return null;
  }
}

export async function freshEmailVerified(uid: string): Promise<boolean> {
  try {
    const user = await adminAuth.getUser(uid);
    return user.emailVerified;
  } catch (error) {
    console.error("[auth] fresh email verification check failed:", error);
    return false;
  }
}
