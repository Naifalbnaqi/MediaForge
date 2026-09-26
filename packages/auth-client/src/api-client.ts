import type { ApiErrorPayload, AuthenticatedUser, AuthResponse } from '@media/types';
import type { LoginInput, RegisterInput } from '@media/validation';

/**
 * The auth routes are registered on the API under the `/auth` prefix relative
 * to the versioned API base (see `apps/api/src/app.ts`:
 * `app.register(authRoutes, { prefix: '/api/v1/auth', ... })`), so every path
 * here is joined onto `NEXT_PUBLIC_API_URL` as `${base}/auth/...`.
 */
const AUTH_PATHS = {
  register: '/auth/register',
  login: '/auth/login',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  me: '/auth/me',
} as const;

const CSRF_COOKIE_NAME = 'media_csrf';

function getApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not configured. Set it in the environment before calling the API.',
    );
  }
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Typed error thrown for any non-2xx API response, carrying the parsed `ApiErrorPayload`. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId: string | undefined;

  public constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.error.code;
    this.requestId = payload.error.requestId;
  }
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  );
}

/**
 * Reads the non-HttpOnly `media_csrf` cookie so it can be echoed back as the
 * `x-csrf-token` header (double-submit CSRF check). The `media_refresh`
 * cookie is HttpOnly and must never be read here.
 */
export function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split('; ')) {
    if (!part) continue;
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex);
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(part.slice(separatorIndex + 1));
    }
  }
  return undefined;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  accessToken?: string;
  /** Attach the `x-csrf-token` header (required by `/refresh` and `/logout`). */
  csrf?: boolean;
}

/**
 * Generic authenticated fetch wrapper against `NEXT_PUBLIC_API_URL`, shared
 * by every consumer of this package (`apps/web`'s auth calls below, and
 * `apps/admin`'s `/admin/me` role check) so there is exactly one place that
 * knows how to attach the access token, the CSRF header, and parse
 * `ApiErrorPayload` error bodies. `path` is relative to the API base, e.g.
 * `/auth/login` or `/admin/me`.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.csrf) {
    const token = readCsrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    // Every auth call must carry the HttpOnly refresh cookie automatically.
    credentials: 'include',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const payload: ApiErrorPayload = isApiErrorPayload(data)
      ? data
      : {
          error: {
            code: 'UNKNOWN_ERROR',
            message: `Request failed with status ${response.status}`,
          },
        };
    throw new ApiError(response.status, payload);
  }

  return data as T;
}

export function register(input: RegisterInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(AUTH_PATHS.register, { method: 'POST', body: input });
}

export function login(input: LoginInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(AUTH_PATHS.login, { method: 'POST', body: input });
}

/** Silent session recovery: relies on the HttpOnly `media_refresh` cookie sent automatically. */
export function refresh(): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(AUTH_PATHS.refresh, { method: 'POST', csrf: true });
}

export function logout(): Promise<void> {
  return apiRequest<void>(AUTH_PATHS.logout, { method: 'POST', csrf: true });
}

export function me(accessToken: string): Promise<{ user: AuthenticatedUser }> {
  return apiRequest<{ user: AuthenticatedUser }>(AUTH_PATHS.me, { accessToken });
}
