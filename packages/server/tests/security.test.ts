import { beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";

import { EnvironmentError, loadEnv, resetEnv } from "../src/env.js";
import { AppError, forbidden, notFound } from "../src/lib/errors.js";
import { fakeVerify, hashPassword, verifyPassword } from "../src/lib/password.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
} from "../src/lib/tokens.js";
import { canRead, canWrite, visibleToViewer } from "../src/modules/repositories/access.js";
import { privateUser, publicUser } from "../src/modules/users/serialise.js";

/**
 * These tests deliberately need no database. Everything covered here is pure
 * logic - token signing, hashing, permission rules, serialisation - and it is
 * the part where a mistake becomes a vulnerability rather than a bug report.
 */

const VALID_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/tessera",
  ACCESS_TOKEN_SECRET: "a".repeat(48),
  REFRESH_TOKEN_SECRET: "b".repeat(48),
  NODE_ENV: "test",
};

beforeEach(() => {
  resetEnv();
  Object.assign(process.env, VALID_ENV);
});

describe("environment validation", () => {
  it("accepts a complete configuration", () => {
    const env = loadEnv(VALID_ENV as NodeJS.ProcessEnv);

    expect(env.ACCESS_TOKEN_TTL).toBe(900);
    expect(env.corsOrigins).toEqual(["http://localhost:5173"]);
  });

  it("refuses to start without a database url", () => {
    const { DATABASE_URL, ...rest } = VALID_ENV;
    void DATABASE_URL;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(EnvironmentError);
  });

  it("rejects a secret short enough to brute-force", () => {
    expect(() => loadEnv({ ...VALID_ENV, ACCESS_TOKEN_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(
      /at least 32 characters/,
    );
  });

  it("rejects reusing one secret for both token types", () => {
    // Sharing the secret would make a refresh token verify as an access token,
    // turning a 30-day credential into a permanent one.
    expect(() =>
      loadEnv({ ...VALID_ENV, REFRESH_TOKEN_SECRET: VALID_ENV.ACCESS_TOKEN_SECRET } as NodeJS.ProcessEnv),
    ).toThrow(/must differ/);
  });

  it("rejects a wildcard CORS origin in production", () => {
    expect(() =>
      loadEnv({ ...VALID_ENV, NODE_ENV: "production", CORS_ORIGINS: "*" } as NodeJS.ProcessEnv),
    ).toThrow(/wildcard/);
  });

  it("parses a comma-separated origin list", () => {
    const env = loadEnv({
      ...VALID_ENV,
      CORS_ORIGINS: "https://a.example, https://b.example",
    } as NodeJS.ProcessEnv);

    expect(env.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("access tokens", () => {
  it("round-trips its claims", () => {
    const token = signAccessToken({ sub: "user-1", sid: "session-1" });
    const claims = verifyAccessToken(token);

    expect(claims).toEqual({ sub: "user-1", sid: "session-1" });
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ sub: "user-1", sid: "s" }, "c".repeat(48), { issuer: "tessera" });
    expect(() => verifyAccessToken(forged)).toThrow(/not valid/);
  });

  it("rejects an unsigned token claiming alg: none", () => {
    // The classic JWT forgery: a header of {"alg":"none"} with no signature.
    // Pinning algorithms at verification time is what makes this fail.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "attacker", sid: "x", iss: "tessera" })).toString(
      "base64url",
    );

    expect(() => verifyAccessToken(`${header}.${payload}.`)).toThrow();
  });

  it("rejects a token from another issuer", () => {
    const foreign = jwt.sign({ sub: "u", sid: "s" }, VALID_ENV.ACCESS_TOKEN_SECRET, { issuer: "somewhere-else" });
    expect(() => verifyAccessToken(foreign)).toThrow();
  });

  it("reports an expired token distinctly, so clients know to refresh", () => {
    const expired = jwt.sign({ sub: "u", sid: "s" }, VALID_ENV.ACCESS_TOKEN_SECRET, {
      issuer: "tessera",
      expiresIn: -10,
    });

    try {
      verifyAccessToken(expired);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("TOKEN_EXPIRED");
    }
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken({ sub: "user-1", sid: "session-1" });
    const [header, , signature] = token.split(".");
    const swapped = Buffer.from(JSON.stringify({ sub: "admin", sid: "session-1" })).toString("base64url");

    expect(() => verifyAccessToken(`${header}.${swapped}.${signature}`)).toThrow();
  });
});

describe("refresh tokens", () => {
  it("generates unguessable, unique tokens", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateRefreshToken()));

    expect(tokens.size).toBe(500);
    // 32 bytes base64url-encoded.
    expect([...tokens][0]).toHaveLength(43);
  });

  it("hashes deterministically, so a stored hash can be looked up", () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it("never stores the token itself", () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);

    expect(hash).not.toBe(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("compares hashes without leaking length or content by timing", () => {
    const a = hashRefreshToken("one");
    const b = hashRefreshToken("two");

    expect(safeEqual(a, a)).toBe(true);
    expect(safeEqual(a, b)).toBe(false);
    // Unequal lengths must return false rather than throw, which would itself
    // be an observable difference.
    expect(safeEqual(a, "short")).toBe(false);
  });
});

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("uses argon2id with explicit parameters", async () => {
    const hash = await hashPassword("whatever-goes-here");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
  });

  it("salts, so identical passwords do not share a hash", async () => {
    const [first, second] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);

    // Without a per-hash salt these would match, and one leaked table would
    // reveal every account using a common password at a glance.
    expect(first).not.toBe(second);
  });

  it("treats a corrupt stored hash as a failed login, not a crash", async () => {
    expect(await verifyPassword("not-a-real-argon2-hash", "anything")).toBe(false);
  });

  it("spends real time when there is no account to check", async () => {
    // Guards against user enumeration: a missing email must not answer faster
    // than a wrong password.
    const started = Date.now();
    expect(await fakeVerify()).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(5);
  });
});

describe("serialisation", () => {
  const row = {
    id: "u1",
    username: "aditya",
    email: "aditya@example.com",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$SECRET",
    displayName: "Aditya",
    bio: null,
    avatarUrl: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  };

  it("never exposes the password hash", () => {
    // The bug this replaces: the original GET /allUsers returned raw documents,
    // password hashes included, with no authentication at all.
    expect(JSON.stringify(publicUser(row))).not.toContain("argon2");
    expect(JSON.stringify(privateUser(row))).not.toContain("argon2");
    expect(publicUser(row)).not.toHaveProperty("passwordHash");
    expect(privateUser(row)).not.toHaveProperty("passwordHash");
  });

  it("hides the email from other people but shows it to the owner", () => {
    expect(publicUser(row)).not.toHaveProperty("email");
    expect(privateUser(row).email).toBe("aditya@example.com");
  });

  it("ignores fields added to the row but not to the serialiser", () => {
    // The allow-list property: a column added later is invisible until
    // somebody deliberately exposes it.
    const withExtra = { ...row, secretInternalFlag: "should-not-leak" } as typeof row;
    expect(JSON.stringify(publicUser(withExtra))).not.toContain("should-not-leak");
  });
});

describe("repository access rules", () => {
  const publicRepo = { visibility: "PUBLIC" as const, ownerId: "owner" };
  const privateRepo = { visibility: "PRIVATE" as const, ownerId: "owner" };

  it("lets anyone read a public repository", () => {
    expect(canRead(publicRepo as never, undefined)).toBe(true);
    expect(canRead(publicRepo as never, "stranger")).toBe(true);
  });

  it("hides a private repository from everyone but its owner", () => {
    expect(canRead(privateRepo as never, undefined)).toBe(false);
    expect(canRead(privateRepo as never, "stranger")).toBe(false);
    expect(canRead(privateRepo as never, "owner")).toBe(true);
  });

  it("allows writes only from the owner", () => {
    expect(canWrite(publicRepo as never, "stranger")).toBe(false);
    expect(canWrite(publicRepo as never, undefined)).toBe(false);
    expect(canWrite(publicRepo as never, "owner")).toBe(true);
  });

  it("filters private rows inside the query, not afterwards", () => {
    // Anonymous visitors get a filter that cannot match a private row at all,
    // so private data never leaves the database - not even into a count.
    expect(visibleToViewer(undefined)).toEqual({ visibility: "PUBLIC" });
    expect(visibleToViewer("me")).toEqual({
      OR: [{ visibility: "PUBLIC" }, { ownerId: "me" }],
    });
  });
});

describe("error responses", () => {
  it("answers 404 rather than 403 for a hidden resource", () => {
    // A 403 would confirm the repository exists, which is exactly what its
    // owner marked private.
    expect(notFound("repository").status).toBe(404);
    expect(forbidden().status).toBe(403);
  });

  it("serialises to a stable machine-readable shape", () => {
    expect(notFound("issue").toJSON()).toEqual({
      error: { code: "NOT_FOUND", message: "issue not found" },
    });
  });
});
