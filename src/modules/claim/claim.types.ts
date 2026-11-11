import { z } from "zod";
import { emailSchema, passwordSchema, sectionSchema } from "../profile/profile.types";

export const claimStartSchema = z
  .object({ email: emailSchema })
  .strict();

export const claimOpenSchema = z
  .object({ oobCode: z.string().min(1), email: emailSchema.optional() })
  .strict();

export const claimCompleteSchema = z
  .object({ password: passwordSchema, sec: sectionSchema.optional() })
  .strict();

export type ClaimStartInput = z.infer<typeof claimStartSchema>;
export type ClaimOpenInput = z.infer<typeof claimOpenSchema>;
export type ClaimCompleteInput = z.infer<typeof claimCompleteSchema>;
