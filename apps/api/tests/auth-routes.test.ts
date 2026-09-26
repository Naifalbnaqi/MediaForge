import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthRepository } from '../src/domain/auth/auth.repository.js';
import type {
  CreateSessionData,
  CreateUserData,
  SessionRecord,
  UserRecord,
} from '../src/domain/auth/auth.types.js';
import { AuthService } from '../src/application/auth/auth.service.js';
import type { PasswordHasher } from '../src/infrastructure/security/password-hasher.js';
import { TokenService } from '../src/infrastructure/security/token-service.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { authRoutes } from '../src/presentation/routes/auth.routes.js';

/**
 * Regression coverage for the verifyCsrf preHandler hang: Fastify's per-request
 * hook runner only advances past a non-callback-style preHandler if it returns a
 * thenable (see node_modules/fastify/lib/hooks.js's hookRunnerGenerator). A plain
 * synchronous verifyCsrf that neither returned a promise nor called `done` stalled
 * every valid-CSRF request to /refresh and /logout forever — invisible to any test
 * that calls verifyCsrf directly or exercises AuthService without going through the
 * real Fastify route pipeline. These tests use app.inject specifically so the
 * preHandler lifecycle itself is exercised, the way the bug actually manifested.
 */

class FakeAuthRepository implements AuthRepository {
  public users = new Map<string, UserRecord>();
  public sessions = new Map<string, SessionRecord>();
  private nextUserId = 1;

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  public async createUser(data: CreateUserData): Promise<UserRecord> {
    const user: UserRecord = {
      id: `user-${this.nextUserId++}`,
      email: data.email,
      role: data.role ?? 'USER',
      name: data.name,
      passwordHash: data.passwordHash,
    };
    this.users.set(user.id, user);
    return user;
  }

  public async createSession(data: CreateSessionData): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: data.id,
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null;
  }

  public async rotateSession(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.tokenHash = tokenHash;
      session.expiresAt = expiresAt;
    }
  }

  public async revokeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.revokedAt = new Date();
  }

  public async revokeAllUserSessions(userId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) session.revokedAt = new Date();
    }
  }
}

/** Fast, deterministic stand-in for bcrypt — this suite isn't testing hashing. */
class FakePasswordHasher implements PasswordHasher {
  public async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }
  public async verify(password: string, hash: string): Promise<boolean> {
    return hash === `hashed:${password}`;
  }
}

async function buildTestApp(): Promise<{ app: FastifyInstance; repository: FakeAuthRepository }> {
  const repository = new FakeAuthRepository();
  const tokenService = new TokenService('a'.repeat(32), 'b'.repeat(32), '15m', 30);
  const authService = new AuthService(repository, new FakePasswordHasher(), tokenService);
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(cookie);
  await app.register(authRoutes, {
    prefix: '/api/v1/auth',
    authService,
    tokenService,
    cookieSecure: false,
  });
  return { app, repository };
}

/**
 * The whole point of this suite: prove a valid-CSRF request completes instead of
 * hanging forever. A bare `app.inject(...)` would, on a regression, simply never
 * resolve and eventually fail via Vitest's global test timeout — technically
 * catching it, but with a confusing "test timed out" failure far from the cause.
 * Racing a short, explicit timeout makes the failure mode unambiguous.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${ms}ms — verifyCsrf preHandler regression`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function extractCookie(setCookieHeaders: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`^${name}=([^;]*)`));
    if (match?.[1]) return match[1];
  }
  throw new Error(`Cookie ${name} not found in Set-Cookie headers: ${JSON.stringify(headers)}`);
}

async function registerUser(app: FastifyInstance, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'ValidPass123', name: 'Test User' },
  });
  expect(response.statusCode).toBe(201);
  const setCookie = response.headers['set-cookie'];
  return {
    accessToken: response.json().accessToken as string,
    refreshToken: extractCookie(setCookie, 'media_refresh'),
    csrfToken: extractCookie(setCookie, 'media_csrf'),
  };
}

describe('POST /api/v1/auth/refresh and /logout — verifyCsrf preHandler lifecycle', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('completes a valid-CSRF refresh without hanging, and rotates the session', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'refresh-ok@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
        headers: { 'x-csrf-token': csrfToken },
      }),
      2000,
      'POST /auth/refresh',
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken).not.toBe('');

    // Rotation: the refresh cookie issued by this response must differ from the
    // one presented, and the OLD refresh token must no longer be usable.
    const rotatedRefreshToken = extractCookie(response.headers['set-cookie'], 'media_refresh');
    const rotatedCsrfToken = extractCookie(response.headers['set-cookie'], 'media_csrf');
    expect(rotatedRefreshToken).not.toBe(refreshToken);

    const reuseOldToken = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { media_refresh: refreshToken, media_csrf: rotatedCsrfToken },
      headers: { 'x-csrf-token': rotatedCsrfToken },
    });
    expect(reuseOldToken.statusCode).toBe(401);
    expect(reuseOldToken.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('completes a valid-CSRF logout without hanging, and revokes the session', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'logout-ok@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
        headers: { 'x-csrf-token': csrfToken },
      }),
      2000,
      'POST /auth/logout',
    );

    expect(response.statusCode).toBe(204);

    // Cookies must be cleared (Fastify clearCookie sets Max-Age=0 / epoch expiry).
    const setCookie = response.headers['set-cookie'];
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const refreshCookieHeader = headers.find((h) => h.startsWith('media_refresh='));
    expect(refreshCookieHeader?.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/);

    // The session itself must be revoked — a subsequent refresh with the same
    // (still cookie-valid-shaped) token must now fail, not merely "cookie gone".
    const refreshAfterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
    expect(refreshAfterLogout.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects /refresh with a missing CSRF header', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'refresh-missing-csrf@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
      }),
      2000,
      'POST /auth/refresh (missing CSRF)',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('rejects /refresh with a CSRF header that does not match the cookie', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'refresh-mismatch-csrf@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
        headers: { 'x-csrf-token': 'not-the-right-token-but-same-length-ish' },
      }),
      2000,
      'POST /auth/refresh (mismatched CSRF)',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('rejects /logout with a missing CSRF header', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'logout-missing-csrf@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
      }),
      2000,
      'POST /auth/logout (missing CSRF)',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('rejects /logout with a CSRF header that does not match the cookie', async () => {
    const { refreshToken, csrfToken } = await registerUser(app, 'logout-mismatch-csrf@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { media_refresh: refreshToken, media_csrf: csrfToken },
        headers: { 'x-csrf-token': 'not-the-right-token-but-same-length-ish' },
      }),
      2000,
      'POST /auth/logout (mismatched CSRF)',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('leaves /register unaffected (no preHandler, no CSRF required)', async () => {
    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'register-still-works@example.test', password: 'ValidPass123', name: 'Test User' },
      }),
      2000,
      'POST /auth/register',
    );

    expect(response.statusCode).toBe(201);
    expect(typeof response.json().accessToken).toBe('string');
  });

  it('leaves /login unaffected (no preHandler, no CSRF required)', async () => {
    await registerUser(app, 'login-still-works@example.test');

    const response = await withTimeout(
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'login-still-works@example.test', password: 'ValidPass123' },
      }),
      2000,
      'POST /auth/login',
    );

    expect(response.statusCode).toBe(200);
    expect(typeof response.json().accessToken).toBe('string');
  });
});
