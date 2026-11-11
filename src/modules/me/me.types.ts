import { z } from "zod";
import { passwordSchema, updateProfileSchema, updateContactSchema } from "../profile/profile.types";

export const deleteAccountSchema = z
  .object({
    password: z.string().min(1, "Password is required to delete account"),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordSchema,
  })
  .strict();

export { updateProfileSchema, updateContactSchema };
