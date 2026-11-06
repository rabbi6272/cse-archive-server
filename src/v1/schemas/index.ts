import { z } from "zod";
import { BLOOD_GROUPS } from "../types/Student";
import { seriesFromRoll } from "../types/series";

const optionalUrl = z
  .union([z.url("Enter a valid URL, including https://"), z.literal("")])
  .transform((value) => value.trim());

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your full name")
  .max(80, "Name must be 80 characters or fewer");

export const nicknameSchema = z
  .string()
  .trim()
  .max(40, "Nickname must be 40 characters or fewer");

export const emailSchema = z
  .email("Enter a valid email address")
  .max(254)
  .transform((value) => value.trim().toLowerCase());

export const rollSchema = z
  .string()
  .trim()
  .refine(
    (value) => seriesFromRoll(value) !== null,
    "Roll must be a valid CSE roll number",
  );

export const sectionSchema = z.enum(["a", "b", "c"]);

export const seriesSchema = z
  .string()
  .trim()
  .regex(/^\d{2}$/, "Series must be a two-digit id");

export const bloodGroupSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => value === "" || (BLOOD_GROUPS as readonly string[]).includes(value),
    `Blood group must be one of ${BLOOD_GROUPS.join(", ")}`,
  );

export const bioSchema = z
  .string()
  .trim()
  .max(500, "Bio must be 500 characters or fewer");

export const hobbySchema = z
  .string()
  .trim()
  .max(60, "Hobby must be 60 characters or fewer");

export const mobileNumberSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^[+\d][\d\s-]{5,19}$/.test(value),
    "Enter a valid mobile number",
  );

export const profilePictureSchema = z.object({
  publicId: z.string().trim().max(300),
  url: z.string().trim().max(600),
});

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Password must be 128 characters or fewer");

export const profileSchema = z.object({
  fullName: fullNameSchema,
  nickname: nicknameSchema,
  email: emailSchema,
  roll: rollSchema,
  series: seriesSchema,
  sec: sectionSchema,
  bloodGroup: bloodGroupSchema,
  bio: bioSchema,
  hobby: hobbySchema,
  fbProfile: optionalUrl,
  profilePicture: profilePictureSchema,
  published: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  claimedAt: z.number().int().nonnegative(),
});

export const profileDraftSchema = profileSchema
  .omit({
    email: true,
    series: true,
    published: true,
    createdAt: true,
    updatedAt: true,
    claimedAt: true,
  })
  .strict();

export const createProfileSchema = z.object({
  profile: profileDraftSchema,
  password: passwordSchema.optional(), // for when user is created or updated
  contact: z.object({ mobileNumber: mobileNumberSchema }).strict(),
});

export const updateProfileSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    nickname: nicknameSchema.optional(),
    roll: rollSchema.optional(),
    sec: sectionSchema.optional(),
    bloodGroup: bloodGroupSchema.optional(),
    bio: bioSchema.optional(),
    hobby: hobbySchema.optional(),
    fbProfile: optionalUrl.optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied");

export const updateContactSchema = z
  .object({ mobileNumber: mobileNumberSchema })
  .strict();

export const loginSchema = z
  .object({ email: emailSchema, password: z.string().min(1, "Enter your password") })
  .strict();

export const claimStartSchema = z
  .object({ email: emailSchema })
  .strict();

export const claimOpenSchema = z
  .object({ oobCode: z.string().min(1), email: emailSchema.optional() })
  .strict();

export const signUpSchema = z
  .object({ series: seriesSchema, email: emailSchema, password: passwordSchema })
  .strict();

export const claimCompleteSchema = z
  .object({ password: passwordSchema, sec: sectionSchema.optional() })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
  .strict();

export const deleteAccountSchema = z
  .object({ password: z.string().min(1) })
  .strict();
