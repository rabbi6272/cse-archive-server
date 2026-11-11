import { z } from "zod";
import { emailSchema, passwordSchema, seriesSchema } from "../profile/profile.types";

export interface Viewer {
  uid: string;
  email: string;
  roll: string;
  name: string;
  profilePictureUrl: string;
}

export type Session = {
  uid: string;
  email: string;
  emailVerified: boolean;
  mustRotate: boolean;
  needsSection: boolean;
};

export type AuthFailure = {
  ok: false;
  code: "invalid" | "claim" | "no-profile" | "no-account" | "throttled" | "error" | "unavailable" | "exists" | "series-closed";
  message?: string;
};

export type AuthSuccess = {
  ok: true;
  viewer?: Viewer;
  email?: string;
  emailVerified?: boolean;
  session?: { value: string; maxAge: number };
};

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const signUpSchema = z.object({
  series: seriesSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password required"),
  newPassword: passwordSchema,
});
