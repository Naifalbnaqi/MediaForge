'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type { AuthenticatedUser } from '@media/types';
import type { LoginInput, RegisterInput } from '@media/validation';
import {
  login as apiLogin,
  logout as apiLogout,
  refresh as apiRefresh,
  register as apiRegister,
} from './api-client';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Non-reactive accessor for the in-memory access token, for code (e.g. a
   * future authenticated fetch helper) that needs to attach it to a request
   * without subscribing to every token rotation via re-renders.
   */
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  // Intentionally NOT React state: the access token must never trigger a
  // localStorage/sessionStorage write, persist across reloads, or be
  // serializable into devtools/query caches. It lives only in this ref, for
  // the lifetime of the tab, and is recovered on mount via a silent refresh.
  const accessTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRefresh()
      .then((result) => {
        if (cancelled) return;
        accessTokenRef.current = result.accessToken;
        setUser(result.user);
        setStatus('authenticated');
      })
      .catch(() => {
        // No valid session to recover — this is the normal "logged out"
        // state on first visit or after the refresh token expires, not an
        // error to surface to the user.
        if (cancelled) return;
        accessTokenRef.current = null;
        setUser(null);
        setStatus('unauthenticated');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const result = await apiLogin(input);
    accessTokenRef.current = result.accessToken;
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await apiRegister(input);
    accessTokenRef.current = result.accessToken;
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      // Always clear local state, even if the network call failed (e.g. the
      // session was already gone) — the user's intent was to end up logged out.
      accessTokenRef.current = null;
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const getAccessToken = useCallback(() => accessTokenRef.current, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout, getAccessToken }),
    [status, user, login, register, logout, getAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
