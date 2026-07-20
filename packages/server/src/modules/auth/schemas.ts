import { z } from "zod";

import { MAX_PASSWORD_LENGTH } from "../../lib/password.js";

/**
 * Input shapes for the auth endpoints.
 *
 * These are the contract. Anything not described here never reaches a handler.
 */

/**
 * Usernames appear in URLs, so the character set is deliberately narrow.
 * The reserved list stops someone registering `api` or `settings` and making a
 * future route ambiguous - a rename that is painful once accounts exist.
 */
const RESERVED_USERNAMES = new Set([
  "admin",
  "api",
  "auth",
  "login",
  "logout",
  "signup",
  "settings",
  "new",
  "explore",
  "about",
  "help",
  "static",
  "assets",
  "tessera",
]);

export const username = z
  .string()
  .trim()
  .min(2, "must be at least 2 characters")
  .max(39, "must be 39 characters or fewer")
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/,
    "may contain letters, numbers and single hyphens, and must start and end with a letter or number",
  )
  .refine((value) => !RESERVED_USERNAMES.has(value.toLowerCase()), "that username is reserved");

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("must be a valid email address")
  .max(254, "is too long");

/**
 * Password rules.
 *
 * Length is the requirement that actually matters. Composition rules - one
 * capital, one symbol - mostly produce `Password1!` and are no longer
 * recommended by NIST, so they are not imposed here. The upper bound exists to
 * cap hashing work, not to restrict users.
 */
export const password = z
  .string()
  .min(10, "must be at least 10 characters")
  .max(MAX_PASSWORD_LENGTH, `must be ${MAX_PASSWORD_LENGTH} characters or fewer`);

export const signupSchema = z.object({
  username,
  email,
  password,
  displayName: z.string().trim().max(100).optional(),
});

export const loginSchema = z.object({
  email,
  // Not validated against the password rules: an existing account may predate
  // them, and telling a caller their guess was "too short to be correct" is a
  // free hint.
  password: z.string().min(1, "is required").max(MAX_PASSWORD_LENGTH),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "is required").max(MAX_PASSWORD_LENGTH),
  newPassword: password,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
