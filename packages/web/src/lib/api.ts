/**
 * The API client.
 *
 * The access token lives in memory here and nowhere else. Not localStorage:
 * anything stored there is readable by any script on the page, so a single XSS
 * bug would hand over the token. Losing it on refresh is fine - the httpOnly
 * refresh cookie silently gets a new one, which is the point of having two.
 *
 * The interesting part is `refreshOnce`. See below.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field-level messages from a validation failure, keyed by field name. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};

    const fields: Record<string, string> = {};
    for (const detail of this.details as { path?: string; message?: string }[]) {
      if (detail.path && detail.message) fields[detail.path] = detail.message;
    }
    return fields;
  }
}

/* -------------------------------------------------------------------------- */
/* Token state                                                                */
/* -------------------------------------------------------------------------- */

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when the session is gone for good, so the app can show the login page. */
export function onSessionLost(handler: () => void): void {
  onSignedOut = handler;
}

/* -------------------------------------------------------------------------- */
/* Single-flight refresh                                                      */
/* -------------------------------------------------------------------------- */

let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Refresh the access token, but never more than once at a time.
 *
 * This is not an optimisation - it is a correctness requirement created by the
 * server's token rotation. Each refresh token may be redeemed exactly once, and
 * replaying a spent one is treated as theft: the server revokes the entire
 * session family.
 *
 * So if a page fires three requests at once and the access token has expired,
 * the naive client sends three refreshes with the same cookie. The first
 * succeeds; the second and third replay a token that is now spent; the server
 * correctly concludes the token was stolen and signs the user out.
 *
 * The security feature would attack its own users.
 *
 * The fix is to share one refresh between all callers: whoever arrives while a
 * refresh is running awaits the same promise instead of starting another.
 */
async function refreshOnce(): Promise<boolean> {
  inFlightRefresh ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        accessToken = null;
        return false;
      }

      const body = (await response.json()) as { accessToken?: string };
      if (!body.accessToken) return false;

      accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared no matter the outcome, so a failed refresh does not wedge the
      // client into never trying again.
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** Set for login/signup/refresh, which must not attempt to re-authenticate. */
  readonly skipAuthRetry?: boolean;
  readonly signal?: AbortSignal;
}

async function send<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    // Required for the refresh cookie to be sent at all.
    credentials: "include",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | null;

  if (response.ok) return payload as T;

  const code = payload?.error?.code ?? "UNKNOWN";
  const message = payload?.error?.message ?? `request failed (${response.status})`;

  /**
   * An expired access token is recoverable exactly once.
   *
   * `isRetry` is what stops an infinite loop: if the request fails again after
   * a successful refresh, the problem is not the token and retrying forever
   * would just hammer the server.
   */
  const expired = response.status === 401 && (code === "TOKEN_EXPIRED" || code === "UNAUTHENTICATED");

  if (expired && !isRetry && !options.skipAuthRetry) {
    if (await refreshOnce()) return send<T>(path, options, true);

    accessToken = null;
    onSignedOut?.();
  }

  throw new ApiError(response.status, code, message, payload?.error?.details);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => send<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown, options: Partial<RequestOptions> = {}) =>
    send<T>(path, { method: "POST", body, ...options }),
  patch: <T>(path: string, body?: unknown) => send<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => send<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => send<T>(path, { method: "DELETE" }),
  /** Restore a session on page load using only the refresh cookie. */
  restoreSession: refreshOnce,
};

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email?: string;
  createdAt: string;
}

export interface Repository {
  id: string;
  name: string;
  description: string | null;
  visibility: "PUBLIC" | "PRIVATE";
  ownerId: string;
  owner?: User;
  starCount?: number;
  issueCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: "OPEN" | "CLOSED";
  repositoryId: string;
  author?: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  pages: number;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}
