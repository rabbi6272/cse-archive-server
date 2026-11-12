import { z } from "zod";
import { emailSchema, passwordSchema, seriesSchema, rollSchema } from "../profile/profile.types";

// ─── Roles ───────────────────────────────────────────────────
// Hierarchy: student < admin < super_admin.
// Every new account is created as "student". Roles are raised manually in the
// MongoDB `users` collection; no API endpoint can change a role.

export const ROLES = ["student", "admin", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  student: 0,
  admin: 1,
  super_admin: 2,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// ─── Viewer / Session ────────────────────────────────────────

export interface Viewer {
  uid: string;
  email: string;
  emailVerified: boolean;
  role: Role;
  /** Empty strings until the user has created / claimed a profile. */
  roll: string;
  series: string;
  name: string;
  profilePictureUrl: string;
  hasProfile: boolean;
}

export type Session = {
  uid: string;
  email: string;
  emailVerified: boolean;
  mustRotate: boolean;
  needsSection: boolean;
};

export type SessionPayload = { value: string; maxAge: number };

export type AuthFailureCode =
  | "invalid"
  | "claim"
  | "no-profile"
  | "no-account"
  | "throttled"
  | "rate_limited"
  | "error"
  | "unavailable"
  | "exists"
  | "series-closed"
  | "bad-series"
  | "roll-held";

export type AuthFailure = {
  ok: false;
  code: AuthFailureCode;
  message?: string;
};

export type AuthSuccess = {
  ok: true;
  viewer: Viewer;
  email: string;
  emailVerified: boolean;
  session: SessionPayload;
};

// ─── Schemas ─────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const signUpSchema = z
  .object({
    series: seriesSchema,
    email: emailSchema,
    password: passwordSchema,
    /** Optional: when given it must belong to `series` and is reserved immediately. */
    roll: rollSchema.optional(),
  })
  .strict(); // rejects unknown keys such as `role`

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const googleStartSchema = z.object({
  redirectUri: z.url(),
});

export const googleExchangeSchema = z.object({
  code: z.string().min(1),
  verifier: z.string().min(1),
  redirectUri: z.url(),
});
