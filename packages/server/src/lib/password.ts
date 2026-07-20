import argon2 from "argon2";

/**
 * Password hashing.
 *
 * Argon2id, not bcrypt. Bcrypt is memory-light, which is exactly what makes it
 * cheap to attack on a GPU - thousands of guesses can run in parallel. Argon2id
 * is deliberately *memory*-hard: each guess needs its configured memory, and
 * that is the resource an attacker cannot cheaply multiply.
 *
 * The parameters below follow the OWASP recommendation of 19 MiB and two
 * iterations. They are stated explicitly rather than left to defaults so that
 * a library upgrade cannot quietly weaken them.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * The maximum password length accepted.
 *
 * Not a security limit - a limit on work. Without it, a megabyte-long password
 * would make the server hash a megabyte, and a handful of such requests would
 * be a denial of service against itself.
 */
export const MAX_PASSWORD_LENGTH = 256;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * A malformed or truncated hash in the database makes argon2 throw. That is
 * caught and reported as "does not match" rather than a 500: a corrupt row for
 * one account should deny that login, not crash the request.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Spend roughly the same time as a real verification, then fail.
 *
 * Called when the email does not exist at all. Without it, a missing account
 * answers in a millisecond while a real one takes ~50ms, and that difference
 * lets anyone enumerate which email addresses are registered - useful for
 * targeted phishing, and a common finding in real security reviews.
 */
export async function fakeVerify(): Promise<false> {
  await argon2.hash("timing-equalisation-placeholder", OPTIONS);
  return false;
}
