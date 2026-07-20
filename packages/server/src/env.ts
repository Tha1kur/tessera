import { z } from "zod";

import { loadDotenv } from "./lib/dotenv.js";

/**
 * Environment configuration, validated once at startup.
 *
 * The alternative - reading `process.env.WHATEVER` wherever it happens to be
 * needed - fails at the worst possible moment. A missing JWT secret should stop
 * the process from starting, not silently sign tokens with `undefined` and be
 * discovered by whoever finds the forged session first.
 */

const DEFAULT_PORT = 4000;

/** Secrets short enough to brute-force are worse than useless. */
const secret = z
  .string()
  .min(32, "must be at least 32 characters - generate one with `openssl rand -base64 48`");

const durationSeconds = z.coerce.number().int().positive();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),

    DATABASE_URL: z.string().url("must be a Postgres connection string"),

    ACCESS_TOKEN_SECRET: secret,
    REFRESH_TOKEN_SECRET: secret,

    /** Deliberately short: a stolen access token stays useful for minutes. */
    ACCESS_TOKEN_TTL: durationSeconds.default(900), // 15 minutes
    /** Long, but rotated on every use and revocable, unlike the access token. */
    REFRESH_TOKEN_TTL: durationSeconds.default(60 * 60 * 24 * 30), // 30 days

    /** Comma-separated list of origins allowed to send credentialed requests. */
    CORS_ORIGINS: z.string().default("http://localhost:5173"),

    COOKIE_DOMAIN: z.string().optional(),

    /** Where bare repositories are stored on disk. */
    REPOSITORY_ROOT: z.string().default("./data/repositories"),
  })
  .superRefine((value, context) => {
    // Signing both token types with one secret means a refresh token would
    // verify as an access token, handing an attacker a permanent session.
    if (value.ACCESS_TOKEN_SECRET === value.REFRESH_TOKEN_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REFRESH_TOKEN_SECRET"],
        message: "must differ from ACCESS_TOKEN_SECRET",
      });
    }

    if (value.NODE_ENV === "production" && value.CORS_ORIGINS.includes("*")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message: "a wildcard origin is not allowed in production",
      });
    }
  });

export type Env = z.infer<typeof schema> & { corsOrigins: string[] };

export class EnvironmentError extends Error {
  constructor(issues: z.ZodIssue[]) {
    const details = issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvironmentError";
  }
}

/** Parse and validate configuration. Throws rather than starting misconfigured. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Only when reading the real environment. A caller passing an explicit object
  // - which is what the tests do - means exactly that object and nothing else.
  if (source === process.env) loadDotenv();

  const result = schema.safeParse(source);
  if (!result.success) throw new EnvironmentError(result.error.issues);

  return {
    ...result.data,
    corsOrigins: result.data.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}

let cached: Env | undefined;

/** The validated environment, parsed on first use. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Reset the cache. Tests use this to exercise different configurations. */
export function resetEnv(): void {
  cached = undefined;
}
