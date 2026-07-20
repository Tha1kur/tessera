import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { api, onSessionLost, setAccessToken } from "./api";
import type { AuthResponse, User } from "./api";

/**
 * Who is signed in.
 *
 * `status` is three states rather than a boolean, and the distinction matters
 * on the very first render: "we have not checked yet" is not the same as "not
 * signed in". Collapsing them makes the app flash the login page for a moment
 * before the session is restored - the single most obvious sign of an
 * amateur front end.
 */
export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: User | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { username: string; email: string; password: string; displayName?: string }): Promise<void>;
  signOut(): Promise<void>;
  refreshUser(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  const adopt = useCallback((response: AuthResponse) => {
    setAccessToken(response.accessToken);
    setUser(response.user);
    setStatus("authenticated");
  }, []);

  const forget = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  /**
   * Restore the session on first load.
   *
   * The access token was only ever in memory, so a page reload always starts
   * without one. The refresh cookie survives, so a single refresh call is
   * enough to work out whether anyone is signed in.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const restored = await api.restoreSession();
      if (cancelled) return;

      if (!restored) {
        forget();
        return;
      }

      try {
        const { user: me } = await api.get<{ user: User }>("/auth/me");
        if (!cancelled) {
          setUser(me);
          setStatus("authenticated");
        }
      } catch {
        if (!cancelled) forget();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [forget]);

  /** The client tells us when a session is unrecoverable - usually a revoked family. */
  useEffect(() => {
    onSessionLost(() => forget());
  }, [forget]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,

      async signIn(email, password) {
        // skipAuthRetry: a failed login is a wrong password, not an expired
        // token, and trying to refresh on the way out would be nonsense.
        adopt(await api.post<AuthResponse>("/auth/login", { email, password }, { skipAuthRetry: true }));
      },

      async signUp(input) {
        adopt(await api.post<AuthResponse>("/auth/signup", input, { skipAuthRetry: true }));
      },

      async signOut() {
        try {
          await api.post("/auth/logout");
        } finally {
          // Cleared even if the request fails: the user asked to be signed
          // out, and the local session must not survive a network error.
          forget();
        }
      },

      async refreshUser() {
        const { user: me } = await api.get<{ user: User }>("/auth/me");
        setUser(me);
      },
    }),
    [status, user, adopt, forget],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}
