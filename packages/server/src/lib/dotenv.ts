import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` into the process environment.
 *
 * Prisma reads `.env` by itself, which is a trap: `prisma migrate` sees the
 * configuration and the server does not, so the database URL appears to work
 * everywhere except in the application. Node does not read `.env` on its own,
 * so it has to be done explicitly - here, once, before anything reads config.
 *
 * `process.loadEnvFile` is built into Node 20.12+, so this needs no dependency.
 * Its precedence is the useful way round: a variable already set in the real
 * environment wins over the file, so a container or CI runner that injects
 * secrets is never overridden by a stray `.env` left in the image.
 */

/** Where to look, in order. */
function candidates(): string[] {
  // Resolved from this module rather than the working directory, so the server
  // finds its own .env whether it was started from the package, the repository
  // root, or anywhere else.
  const here = path.dirname(fileURLToPath(import.meta.url));

  return [
    path.resolve(process.cwd(), ".env"),
    // src/lib -> src -> package root, and dist/lib -> dist -> package root.
    path.resolve(here, "..", "..", ".env"),
    path.resolve(here, "..", "..", "..", ".env"),
  ];
}

let loaded = false;

/** Load the first `.env` found. Safe to call more than once. */
export function loadDotenv(): string | null {
  if (loaded) return null;
  loaded = true;

  for (const candidate of candidates()) {
    if (!existsSync(candidate)) continue;

    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch (error) {
      // A malformed .env should say so plainly. Failing silently here would
      // surface later as a confusing "DATABASE_URL: Required".
      console.error(`Could not read ${candidate}:`, (error as Error).message);
      return null;
    }
  }

  // Absent is not an error: in production the environment is usually injected
  // directly, and validation will report anything genuinely missing.
  return null;
}
