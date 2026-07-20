import type { CookieOptions, Response } from "express";

import { env } from "../env.js";

/**
 * The refresh token cookie.
 *
 * Why a cookie rather than a JSON field the client stores itself: `httpOnly`
 * means JavaScript cannot read it, so a cross-site scripting bug that would
 * otherwise hand an attacker a 30-day session cannot reach this value at all.
 *
 * The access token is the opposite - it is returned in the response body and
 * held in memory by the client. That is deliberate. It is short-lived, and
 * keeping it out of cookies keeps it out of CSRF's reach, since the browser
 * never attaches it automatically.
 *
 * The two halves cover each other's weakness: XSS cannot read the long-lived
 * credential, and CSRF cannot use the one the browser sends on its own.
 */

export const REFRESH_COOKIE = "tessera_refresh";

/** The refresh cookie is only ever sent to the endpoints that need it. */
const REFRESH_PATH = "/api/auth";

export function refreshCookieOptions(expiresAt: Date): CookieOptions {
  const { NODE_ENV, COOKIE_DOMAIN } = env();

  return {
    httpOnly: true,
    // Not sent on cross-site requests at all, which is what defeats CSRF
    // against the refresh endpoint without needing a separate token.
    sameSite: "strict",
    // Required over HTTPS in production; relaxed locally so http://localhost
    // still works during development.
    secure: NODE_ENV === "production",
    path: REFRESH_PATH,
    expires: expiresAt,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(response: Response, token: string, expiresAt: Date): void {
  response.cookie(REFRESH_COOKIE, token, refreshCookieOptions(expiresAt));
}

/**
 * Clear the cookie on logout.
 *
 * The options must match those it was set with - a browser will not remove a
 * cookie whose path or domain differs, and the session would appear to survive
 * signing out.
 */
export function clearRefreshCookie(response: Response): void {
  const options = refreshCookieOptions(new Date(0));
  response.clearCookie(REFRESH_COOKIE, { ...options, expires: undefined });
}
