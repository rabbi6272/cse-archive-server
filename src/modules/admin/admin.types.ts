import { z } from "zod";

export const broadcastSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required"),
  body: z.string().trim().min(1, "Body is required"),
});

export const setClaimsSchema = z.object({
  uid: z.string().min(1),
  claims: z.record(z.string(), z.any()),
});

export const rollActionSchema = z.object({
  roll: z.string().min(1),
  uid: z.string().min(1),
});
