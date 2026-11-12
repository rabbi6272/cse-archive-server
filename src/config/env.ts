import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("3005"),
  NODE_ENV: z.string().default("development"),

  // MongoDB
  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DB: z.string().default("CseArchive"),

  // Firebase Admin & RTDB
  FIREBASE_ADMIN_PROJECT_ID: z.string().min(1, "FIREBASE_ADMIN_PROJECT_ID required"),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().min(1, "FIREBASE_ADMIN_CLIENT_EMAIL required"),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().min(1, "FIREBASE_ADMIN_PRIVATE_KEY required"),
  FIREBASE_ADMIN_DATABASE_URL: z.string().optional(),
  FIREBASE_DATABASE_URL: z.string().optional(),
  FIREBASE_WEB_API_KEY: z.string().default("AIzaSyCxod-eup82Oy_Od04YLHs7iOQdFGBmEHU"),

  // Google Drive Service Account
  GOOGLE_CLIENT_EMAIL: z.string().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_DRIVE_WEBHOOK_URL: z.string().optional(),
  GOOGLE_DRIVE_WEBHOOK_TOKEN: z.string().optional(),

  // Secrets
  ADMIN_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  AUTH_SERVICE_SECRET: z.string().optional(),

  // Google OAuth
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Sites & Origins
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://localhost:3001,https://ruetcse24-new.vercel.app,https://ruetcsearchive.vercel.app",
    ),
  PUBLIC_SITE_URL: z.string().default("https://ruetcse24-new.vercel.app"),

  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? process.env.NODE_ENV === "production" : v === "true")),

  RESEND_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;

export function getEnv(): Env {
  if (parsedEnv) return parsedEnv;
  const result = envSchema.safeParse({
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB: process.env.MONGODB_DB,
    FIREBASE_ADMIN_PROJECT_ID: process.env.FIREBASE_ADMIN_PROJECT_ID,
    FIREBASE_ADMIN_CLIENT_EMAIL: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    FIREBASE_ADMIN_PRIVATE_KEY: process.env.FIREBASE_ADMIN_PRIVATE_KEY,
    FIREBASE_ADMIN_DATABASE_URL: process.env.FIREBASE_ADMIN_DATABASE_URL,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
    FIREBASE_WEB_API_KEY:
      process.env.FIREBASE_WEB_API_KEY ||
      process.env.USERS_FIREBASE_API_KEY ||
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    GOOGLE_DRIVE_WEBHOOK_URL: process.env.GOOGLE_DRIVE_WEBHOOK_URL,
    GOOGLE_DRIVE_WEBHOOK_TOKEN: process.env.GOOGLE_DRIVE_WEBHOOK_TOKEN,
    ADMIN_SECRET: process.env.ADMIN_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    AUTH_SERVICE_SECRET: process.env.AUTH_SERVICE_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  });

  if (!result.success) {
    console.error("[env] Configuration errors:", result.error.format());
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }

  parsedEnv = result.data;
  return parsedEnv;
}

export const env = getEnv();

const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];

/**
 * Parses ALLOWED_ORIGINS into clean origins. Accepts either a comma-separated list
 * (`https://a.app,https://b.app`) or a JSON array (`["https://a.app", "https://b.app"]`),
 * strips quotes, brackets and trailing slashes, and normalises each entry to its origin.
 * Outside production the local Next.js dev ports are always allowed.
 */
export function parseAllowedOrigins(raw: string, nodeEnv = env.NODE_ENV): string[] {
  let entries: string[];
  const trimmed = raw.trim();
  try {
    const parsed: unknown = trimmed.startsWith("[") ? JSON.parse(trimmed) : null;
    entries = Array.isArray(parsed) ? parsed.map(String) : trimmed.split(",");
  } catch {
    entries = trimmed.replace(/^\[|\]$/g, "").split(",");
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    const value = entry.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      console.warn(`[env] ignoring invalid ALLOWED_ORIGINS entry: ${entry}`);
    }
  }
  if (nodeEnv !== "production") DEV_ORIGINS.forEach((o) => origins.add(o));
  return [...origins];
}

export const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
