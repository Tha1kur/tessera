import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

import { rateLimited } from "../../lib/errors.js";

/**
 * Rate limiting.
 *
 * Without it, a login endpoint is an offline password-cracking oracle that
 * happens to be online: an attacker can try passwords as fast as the server
 * will answer. Argon2 makes each guess expensive, but expensive-per-guess is
 * not the same as few-guesses-allowed.
 *
 * Limits are strictest where the cost of being wrong is highest.
 */

const handler: RequestHandler = (_request, _response, next) => {
  // Routed through the normal error path so a 429 looks like every other error.
  next(rateLimited());
};

const shared = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  handler,
};

/** Ordinary API traffic. Generous - this only stops runaway clients. */
export const generalLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
});

/**
 * Credential endpoints: login, signup, refresh.
 *
 * Keyed by IP *and* by the email being tried, so that spraying one password
 * across many accounts from one address is limited, and so is hammering one
 * account from many addresses.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: 10,
  // Only failures count. Someone legitimately signing in on several devices
  // should not be locked out for succeeding.
  skipSuccessfulRequests: true,
  keyGenerator: (request) => {
    const body = request.body as { email?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.toLowerCase() : "";
    return `${request.ip ?? "unknown"}:${email}`;
  },
});

/** Creating things is cheap for the client and expensive for us. */
export const writeLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 30,
});
