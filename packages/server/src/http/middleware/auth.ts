import type { NextFunction, Request, Response } from "express";

import { forbidden, unauthenticated } from "../../lib/errors.js";
import { verifyAccessToken } from "../../lib/tokens.js";

/**
 * Authentication.
 *
 * The project this replaces shipped `authMiddleware.js` and
 * `authorizeMiddleware.js` as *empty files*, which meant every route was public:
 * anyone could delete any repository or read every user record. That is the gap
 * this module closes, and the distinction the empty files were reaching for is
 * worth stating plainly:
 *
 *   Authentication  - who are you?          (requireAuth)
 *   Authorisation   - may you do this?      (requireOwnership)
 *
 * They are separate because being logged in says nothing about whether this
 * particular repository is yours.
 */

export interface AuthenticatedUser {
  readonly id: string;
  readonly sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth / optionalAuth. Undefined when not signed in. */
      auth?: AuthenticatedUser;
    }
  }
}

/** Pull a bearer token out of the Authorization header. */
function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  // Compared case-insensitively: RFC 7235 defines the scheme that way, and
  // some clients send "bearer".
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;

  return token.trim() || null;
}

/** Reject the request unless it carries a valid access token. */
export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  const token = bearerToken(request);
  if (!token) {
    next(unauthenticated("this endpoint requires a bearer token"));
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    request.auth = { id: claims.sub, sessionId: claims.sid };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attach the user when a token is present, but allow anonymous requests.
 *
 * Used by endpoints whose *response* depends on who is asking - listing
 * repositories returns public ones to a stranger and also private ones to their
 * owner. An invalid token is ignored rather than rejected here, because the
 * endpoint is legitimately available without one.
 */
export function optionalAuth(request: Request, _response: Response, next: NextFunction): void {
  const token = bearerToken(request);
  if (!token) {
    next();
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    request.auth = { id: claims.sub, sessionId: claims.sid };
  } catch {
    // Deliberately ignored - see above.
  }

  next();
}

/** The authenticated user, or an error. Removes `auth?` checks from handlers. */
export function currentUser(request: Request): AuthenticatedUser {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Require that the signed-in user owns the resource.
 *
 * Takes the owner id rather than fetching anything, so the caller - which has
 * already loaded the record - does not pay for a second query.
 */
export function requireOwnership(request: Request, ownerId: string): void {
  const user = currentUser(request);
  if (user.id !== ownerId) throw forbidden("only the owner can do this");
}
