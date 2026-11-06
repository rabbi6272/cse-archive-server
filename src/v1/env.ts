import { z } from "zod";

const envSchema = z.object({
  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DB: z.string().default("ruetcse"),
  FIREBASE_ADMIN_PROJECT_ID: z.string().min(1, "FIREBASE_ADMIN_PROJECT_ID required"),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().min(1, "FIREBASE_ADMIN_CLIENT_EMAIL required"),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().min(1, "FIREBASE_ADMIN_PRIVATE_KEY required"),
  FIREBASE_WEB_API_KEY: z.string().default("AIzaSyCxod-eup82Oy_Od04YLHs7iOQdFGBmEHU"),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://localhost:3001,https://ruetcse24-new.vercel.app,https://ruetcsearchive.vercel.app",
    ),
  PUBLIC_SITE_URL: z.string().default("https://ruetcse24-new.vercel.app"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? process.env.NODE_ENV === "production" : v === "true")),
  ADMIN_EMAILS: z.string().default(""),
  RESEND_API_KEY: z.string().optional(),
  PORT: z.string().default("3005"),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;

export function getEnv(): Env {
  if (parsedEnv) return parsedEnv;
  const result = envSchema.safeParse({
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB: process.env.MONGODB_DB,
    FIREBASE_ADMIN_PROJECT_ID: process.env.FIREBASE_ADMIN_PROJECT_ID,
    FIREBASE_ADMIN_CLIENT_EMAIL: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    FIREBASE_ADMIN_PRIVATE_KEY: process.env.FIREBASE_ADMIN_PRIVATE_KEY,
    FIREBASE_WEB_API_KEY:
      process.env.FIREBASE_WEB_API_KEY ||
      process.env.USERS_FIREBASE_API_KEY ||
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL,
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    PORT: process.env.PORT,
  });

  if (!result.success) {
    console.error("[env] Configuration errors:", result.error.format());
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }

  parsedEnv = result.data;
  return parsedEnv;
}

export const env = getEnv();
