import { z } from "zod";

export type Section = "a" | "b" | "c";
export type SectionFilter = "All" | Section;

export const BLOOD_GROUPS = [
  "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-",
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export interface ProfilePicture {
  publicId: string;
  url: string;
}

export interface Profile {
  id: string; // mapped from _id
  fullName: string;
  nickname: string;
  email: string;
  roll: string;
  series: string;
  sec: Section;
  bloodGroup: string;
  bio: string;
  hobby: string;
  fbProfile: string;
  profilePicture: ProfilePicture;
  published: boolean;
  createdAt: number;
  updatedAt: number;
  claimedAt: number;
}

export type ProfileDraft = Omit<
  Profile,
  "id" | "email" | "series" | "published" | "createdAt" | "updatedAt" | "claimedAt"
>;

export interface PrivateContact {
  mobileNumber: string;
}

export interface LegacyProfile {
  legacyId: string;
  fullName: string;
  nickname: string;
  email: string;
  roll: string;
  sec: Section | "";
  bloodGroup: string;
  bio: string;
  hobby: string;
  fbProfile: string;
  mobileNumber: string;
  profilePicture: ProfilePicture;
  createdAt: number;
}

export interface SeriesConfig {
  id: string;
  name: string;
  rollRegex: RegExp;
  sections: Section[];
  status: "open" | "closed" | "read-only";
}

export const SERIES_REGISTRY: Record<string, SeriesConfig> = {
  "24": {
    id: "24",
    name: "Series 24",
    rollRegex: /^2403(00[1-9]|0[1-9][0-9]|1[0-7][0-9]|180)$/,
    sections: ["a", "b", "c"],
    status: "open",
  },
  "23": {
    id: "23",
    name: "Series 23",
    rollRegex: /^2303(00[1-9]|0[1-9][0-9]|1[0-7][0-9]|180)$/,
    sections: ["a", "b", "c"],
    status: "closed",
  },
};

export function seriesFromRoll(roll: string): SeriesConfig | null {
  const trimmed = roll.trim();
  for (const config of Object.values(SERIES_REGISTRY)) {
    if (config.rollRegex.test(trimmed)) {
      return config;
    }
  }
  return null;
}

export function getSeries(seriesId: string): SeriesConfig | null {
  return SERIES_REGISTRY[seriesId] ?? null;
}

// ─── Zod Schemas ─────────────────────────────────────────────

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

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Password must be 128 characters or fewer");

export const profilePictureSchema = z.object({
  publicId: z.string().trim().max(300),
  url: z.string().trim().max(600),
});

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
  .partial({
    nickname: true,
    bio: true,
    hobby: true,
    fbProfile: true,
  });

export const privateContactSchema = z.object({
  mobileNumber: mobileNumberSchema,
});

export const createProfileSchema = z.object({
  profile: profileDraftSchema,
  contact: privateContactSchema.optional(),
});

export const updateProfileSchema = profileDraftSchema.partial();
export const updateContactSchema = privateContactSchema;
