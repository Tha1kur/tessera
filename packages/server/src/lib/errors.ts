/**
 * Typed application errors.
 *
 * The original project answered every failure with `res.status(500).send("Server
 * error")`, which tells a client nothing and hides real bugs behind the same
 * response as a mistyped id. Here every failure carries a status, a stable
 * machine-readable code, and a message safe to show a user.
 *
 * The distinction that matters: `AppError` is *expected* - a missing record, a
 * bad password. Anything else reaching the handler is a bug, and is deliberately
 * flattened to a generic 500 so internals never leak to a client.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "SESSION_REVOKED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, "VALIDATION_FAILED", message, details);

/** No usable credentials were presented. */
export const unauthenticated = (message = "authentication required", code: ErrorCode = "UNAUTHENTICATED"): AppError =>
  new AppError(401, code, message);

/**
 * Credentials were valid, but this account may not do this.
 *
 * Note where 403 is *not* used: asking for a private repository you cannot see
 * returns 404, not 403. A 403 would confirm the repository exists, which leaks
 * private information to anyone willing to guess names.
 */
export const forbidden = (message = "you do not have access to this"): AppError =>
  new AppError(403, "FORBIDDEN", message);

export const notFound = (what = "resource"): AppError => new AppError(404, "NOT_FOUND", `${what} not found`);

export const conflict = (message: string): AppError => new AppError(409, "CONFLICT", message);

export const rateLimited = (message = "too many requests - try again shortly"): AppError =>
  new AppError(429, "RATE_LIMITED", message);

export const internal = (message = "something went wrong"): AppError =>
  new AppError(500, "INTERNAL", message);
