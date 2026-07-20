import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import jwt from "jsonwebtoken";

import { env } from "../env.js";
import { unauthenticated } from "./errors.js";

/**
 * Token issuing and verification.
 *
 * Two token types, doing deliberately different jobs:
 *
 *   Access token   A signed JWT, short-lived, sent on every request. Verified
 *                  by signature alone - no database round trip - which is what
 *                  keeps ordinary requests fast. The cost of that speed is that
 *                  it cannot be revoked, so it is kept short-lived.
 *
 *   Refresh token  An opaque random string, long-lived, stored hashed in the
 *                  database and sent only to the refresh endpoint. Because it
 *                  is checked against a row, it *can* be revoked instantly.
 *
 * A JWT is not used for the refresh token on purpose. It carries no claims
 * anyone needs, and making it a database row is precisely what buys revocation
 * and theft detection.
 */

export interface AccessTokenClaims {
  /** The user this token authenticates. */
  readonly sub: string;
  /** The session it was issued under, so a revoked session can be traced. */
  readonly sid: string;
}

interface SignedClaims extends AccessTokenClaims {
  readonly iat: number;
  readonly exp: number;
}

const ISSUER = "tessera";

export function signAccessToken(claims: AccessTokenClaims): string {
  const { ACCESS_TOKEN_SECRET, ACCESS_TOKEN_TTL } = env();

  return jwt.sign({ sub: claims.sub, sid: claims.sid }, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    algorithm: "HS256",
  });
}

/**
 * Verify an access token.
 *
 * `algorithms` is pinned explicitly. Without it, a token whose header says
 * `alg: none` would be accepted as validly signed - the classic JWT forgery,
 * and one that libraries have historically allowed by default.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  const { ACCESS_TOKEN_SECRET } = env();

  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET, {
      issuer: ISSUER,
      algorithms: ["HS256"],
    }) as SignedClaims;

    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw unauthenticated("token is missing required claims", "TOKEN_INVALID");
    }

    return { sub: payload.sub, sid: payload.sid };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthenticated("access token has expired", "TOKEN_EXPIRED");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw unauthenticated("access token is not valid", "TOKEN_INVALID");
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                             */
/* -------------------------------------------------------------------------- */

const REFRESH_TOKEN_BYTES = 32;

/**
 * A fresh, unguessable refresh token.
 *
 * 32 bytes from the OS CSPRNG - 256 bits of entropy. Base64url so it survives
 * being put in a cookie without escaping.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/**
 * Hash a refresh token for storage.
 *
 * SHA-256 rather than argon2, and that is not an oversight. Argon2 is slow *on
 * purpose*, to make guessing low-entropy human passwords expensive. A refresh
 * token is 256 random bits: there is nothing to guess, so the only requirement
 * is that the stored value cannot be reversed. Using argon2 here would add
 * latency to every refresh and buy nothing.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compare two token hashes without leaking timing information.
 *
 * A naive `===` returns faster the earlier two strings differ, which over many
 * attempts reveals the value one character at a time.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a leak,
  // so unequal lengths are reported as a mismatch without calling it.
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/** When a refresh token issued now should stop being accepted. */
export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env().REFRESH_TOKEN_TTL * 1000);
}

/** A new session family id, grouping every token descended from one login. */
export function newFamilyId(): string {
  return randomBytes(16).toString("hex");
}
