import type { PrismaClient, Session } from "@prisma/client";

import { unauthenticated } from "../../lib/errors.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
  refreshTokenExpiry,
  signAccessToken,
} from "../../lib/tokens.js";

/**
 * Refresh token rotation, with reuse detection.
 *
 * The problem this solves: a long-lived refresh token is worth stealing, and a
 * thief's copy is indistinguishable from the real one. Rotation makes the theft
 * *detectable*.
 *
 * Every refresh swaps the presented token for a new one and marks the old one
 * used. A token can therefore be redeemed exactly once. If a token that has
 * already been redeemed shows up again, there are only two possibilities and
 * both mean the same thing: two parties hold the same token, so one of them
 * stole it.
 *
 * At that point there is no way to tell the thief from the victim, so the
 * entire family - every token descended from that login - is revoked and both
 * are forced to log in again. Annoying the real user briefly is a far better
 * outcome than leaving an attacker with a valid session indefinitely.
 */

export interface SessionContext {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/** Begin a new session. Called on login and on signup. */
export async function createSession(
  prisma: PrismaClient,
  userId: string,
  context: SessionContext = {},
): Promise<IssuedTokens> {
  const refreshToken = generateRefreshToken();
  const expiresAt = refreshTokenExpiry();

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      familyId: newFamilyId(),
      expiresAt,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    },
  });

  return {
    accessToken: signAccessToken({ sub: userId, sid: session.id }),
    refreshToken,
    sessionId: session.id,
    userId,
    expiresAt,
  };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The whole exchange runs in a transaction. Without one, two refreshes racing
 * with the same token could both read it as unused and both succeed, which is
 * precisely the situation rotation exists to make impossible.
 */
export async function rotateSession(
  prisma: PrismaClient,
  presentedToken: string,
  context: SessionContext = {},
): Promise<IssuedTokens> {
  const presentedHash = hashRefreshToken(presentedToken);

  /**
   * Revocation cannot happen inside the transaction below.
   *
   * Detecting reuse means rejecting the request, and rejecting it means
   * throwing - which rolls the transaction back, taking any revocation with
   * it. The theft would be detected and then silently un-detected, leaving
   * every stolen token live. So the family is recorded here and revoked
   * afterwards, on the outer client, where the write survives the rollback.
   */
  let compromisedFamily: string | null = null;

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.session.findUnique({ where: { tokenHash: presentedHash } });

      // An unknown token proves nothing - it may be forged, or from a session
      // already cleaned up. There is no family to revoke, so simply refuse.
      if (!existing) {
        throw unauthenticated("refresh token is not valid", "TOKEN_INVALID");
      }

      if (existing.revokedAt !== null || existing.replacedById !== null) {
        // Reuse. Someone is holding a copy of a token that was already spent.
        compromisedFamily = existing.familyId;
        throw unauthenticated(
          "this session was reused and has been revoked for your security - please sign in again",
          "SESSION_REVOKED",
        );
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        await tx.session.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });
        throw unauthenticated("session has expired - please sign in again", "TOKEN_EXPIRED");
      }

      const refreshToken = generateRefreshToken();
      const expiresAt = refreshTokenExpiry();

      const replacement = await tx.session.create({
        data: {
          userId: existing.userId,
          tokenHash: hashRefreshToken(refreshToken),
          // Same family: the new token is a descendant of the original login,
          // which is what lets one reuse revoke the entire chain.
          familyId: existing.familyId,
          expiresAt,
          userAgent: context.userAgent ?? existing.userAgent,
          ipAddress: context.ipAddress ?? existing.ipAddress,
        },
      });

      await tx.session.update({
        where: { id: existing.id },
        data: { replacedById: replacement.id, revokedAt: new Date() },
      });

      return {
        accessToken: signAccessToken({ sub: existing.userId, sid: replacement.id }),
        refreshToken,
        sessionId: replacement.id,
        userId: existing.userId,
        expiresAt,
      };
    });
  } finally {
    // Runs after the rollback, on the real client, so the revocation commits.
    if (compromisedFamily) await revokeFamily(prisma, compromisedFamily);
  }
}

/** Revoke every live token in a family. */
export async function revokeFamily(prisma: PrismaClient, familyId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** End one session, as an ordinary logout does. */
export async function revokeSessionByToken(prisma: PrismaClient, presentedToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Sign out everywhere - after a password change, for instance. */
export async function revokeAllSessions(prisma: PrismaClient, userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Confirm a session is still live, for endpoints that must not trust the JWT alone. */
export async function requireLiveSession(prisma: PrismaClient, sessionId: string): Promise<Session> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });

  if (!session || session.revokedAt !== null) {
    throw unauthenticated("this session is no longer valid", "SESSION_REVOKED");
  }

  return session;
}

/**
 * Delete sessions that expired long ago.
 *
 * Revoked rows are kept for a grace period rather than deleted immediately: a
 * reused token can only be *detected* while the row it points at still exists.
 * Deleting on revocation would turn every theft into an "unknown token" and
 * throw away the signal.
 */
export async function pruneExpiredSessions(prisma: PrismaClient, graceDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
}
