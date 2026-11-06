export type Section = "a" | "b" | "c";

export type SectionFilter = "All" | Section;

export interface ProfilePicture {
  publicId: string;
  url: string;
}

/**
 * Public directory profile.
 * In Mongo: _id is uid.
 */
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

export interface SessionUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  mustRotate: boolean;
  needsSection: boolean;
}

export const SECTION_LABELS: Record<SectionFilter, string> = {
  All: "All sections",
  a: "Section A",
  b: "Section B",
  c: "Section C",
};

export const BLOOD_GROUPS = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
] as const;

export type BloodGroup = (typeof BLOOD_GROUPS)[number];
