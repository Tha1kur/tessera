import { Router } from "express";
import type { Request, Response } from "express";

import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "../../http/cookies.js";
import { currentUser, requireAuth } from "../../http/middleware/auth.js";
import { asyncHandler } from "../../http/middleware/error.js";
import { authLimiter } from "../../http/middleware/rateLimit.js";
import { validate } from "../../http/validate.js";
import { prisma } from "../../lib/db.js";
import { conflict, unauthenticated } from "../../lib/errors.js";
import { fakeVerify, hashPassword, verifyPassword } from "../../lib/password.js";
import { publicUser } from "../users/serialise.js";
import { changePasswordSchema, loginSchema, signupSchema } from "./schemas.js";
import type { IssuedTokens, SessionContext } from "./sessions.js";
import {
  createSession,
  revokeAllSessions,
  revokeSessionByToken,
  rotateSession,
} from "./sessions.js";

export const authRouter: Router = Router();

/** Details recorded against a session, so a user can recognise their devices. */
function contextOf(request: Request): SessionContext {
  return {
    userAgent: request.get("user-agent")?.slice(0, 255),
    ipAddress: request.ip,
  };
}

/**
 * Send a freshly issued pair.
 *
 * The refresh token goes into an httpOnly cookie and is never in the body; the
 * access token is in the body and never in a cookie. See `http/cookies.ts` for
 * why that split is the point rather than an inconsistency.
 */
function respondWithTokens(response: Response, tokens: IssuedTokens, body: Record<string, unknown>): void {
  setRefreshCookie(response, tokens.refreshToken, tokens.expiresAt);
  response.json({ ...body, accessToken: tokens.accessToken });
}

/* -------------------------------------------------------------------------- */
/* POST /api/auth/signup                                                      */
/* -------------------------------------------------------------------------- */

authRouter.post(
  "/signup",
  authLimiter,
  validate({ body: signupSchema }),
  asyncHandler(async (request, response) => {
    const { username, email, password, displayName } = request.body;

    // Checked up front so the caller gets a clear message naming the field.
    // The database's unique constraints remain the real guarantee - between
    // this check and the insert, another request could take the name, and
    // that collision is handled as a 409 by the error handler.
    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
      select: { username: true, email: true },
    });

    if (existing) {
      throw conflict(
        existing.email === email ? "an account with that email already exists" : "that username is taken",
      );
    }

    const user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash: await hashPassword(password),
        displayName: displayName ?? null,
      },
    });

    const tokens = await createSession(prisma, user.id, contextOf(request));
    response.status(201);
    respondWithTokens(response, tokens, { user: publicUser(user) });
  }),
);

/* -------------------------------------------------------------------------- */
/* POST /api/auth/login                                                       */
/* -------------------------------------------------------------------------- */

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (request, response) => {
    const { email, password } = request.body;

    const user = await prisma.user.findUnique({ where: { email } });

    // Both branches answer with the same error and take about the same time.
    // A faster "no such account" would let anyone test which emails are
    // registered, and a different message would say it outright.
    const ok = user ? await verifyPassword(user.passwordHash, password) : await fakeVerify();

    if (!user || !ok) {
      throw unauthenticated("email or password is incorrect", "INVALID_CREDENTIALS");
    }

    const tokens = await createSession(prisma, user.id, contextOf(request));
    respondWithTokens(response, tokens, { user: publicUser(user) });
  }),
);

/* -------------------------------------------------------------------------- */
/* POST /api/auth/refresh                                                     */
/* -------------------------------------------------------------------------- */

authRouter.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (request, response) => {
    const presented = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];

    if (!presented) {
      throw unauthenticated("no refresh token was sent", "TOKEN_INVALID");
    }

    try {
      const tokens = await rotateSession(prisma, presented, contextOf(request));
      const user = await prisma.user.findUnique({ where: { id: tokens.userId } });
      respondWithTokens(response, tokens, user ? { user: publicUser(user) } : {});
    } catch (error) {
      // The cookie is useless now, whether it was expired, forged or revoked.
      // Leaving it in place would make the client retry forever.
      clearRefreshCookie(response);
      throw error;
    }
  }),
);

/* -------------------------------------------------------------------------- */
/* POST /api/auth/logout                                                      */
/* -------------------------------------------------------------------------- */

authRouter.post(
  "/logout",
  asyncHandler(async (request, response) => {
    const presented = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (presented) await revokeSessionByToken(prisma, presented);

    clearRefreshCookie(response);
    // Always 204, even with no token. Logging out is idempotent, and reporting
    // "you were not logged in" would tell a caller whether a token was live.
    response.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/auth/me                                                           */
/* -------------------------------------------------------------------------- */

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (request, response) => {
    const { id } = currentUser(request);
    const user = await prisma.user.findUnique({ where: { id } });

    // The token verified, but the account is gone - deleted while the
    // short-lived access token was still within its lifetime.
    if (!user) throw unauthenticated("this account no longer exists", "SESSION_REVOKED");

    response.json({ user: publicUser(user) });
  }),
);

/* -------------------------------------------------------------------------- */
/* POST /api/auth/change-password                                             */
/* -------------------------------------------------------------------------- */

authRouter.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (request, response) => {
    const { id } = currentUser(request);
    const { currentPassword, newPassword } = request.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw unauthenticated("this account no longer exists", "SESSION_REVOKED");

    // Re-authenticating here is what stops a borrowed unlocked laptop, or a
    // stolen access token, from being upgraded into permanent account takeover.
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw unauthenticated("current password is incorrect", "INVALID_CREDENTIALS");
    }

    await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    // Every existing session dies, including any an attacker holds. That is
    // the entire security value of changing a password.
    await revokeAllSessions(prisma, id);

    const tokens = await createSession(prisma, id, contextOf(request));
    respondWithTokens(response, tokens, { message: "password changed - other devices have been signed out" });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/auth/sessions                                                     */
/* -------------------------------------------------------------------------- */

authRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (request, response) => {
    const { id, sessionId } = currentUser(request);

    const sessions = await prisma.session.findMany({
      where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    response.json({
      // tokenHash is never selected, let alone returned - it is the credential.
      sessions: sessions.map((session) => ({ ...session, current: session.id === sessionId })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* DELETE /api/auth/sessions                                                  */
/* -------------------------------------------------------------------------- */

authRouter.delete(
  "/sessions",
  requireAuth,
  asyncHandler(async (request, response) => {
    const { id } = currentUser(request);
    const revoked = await revokeAllSessions(prisma, id);

    clearRefreshCookie(response);
    response.json({ message: `signed out of ${revoked} session(s)` });
  }),
);
