import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serverEnvironmentSchema } from '@media/config';
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
import { authRoutes } from '../src/presentation/routes/auth.routes.js';
import { resolveCookieSecure } from '../src/utils/cookie-security.js';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
};

describe('serverEnvironmentSchema COOKIE_SECURE parsing', () => {
  it('parses "false" as boolean false, not a truthy coercion', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, COOKIE_SECURE: 'false' });
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it('parses "true" as boolean true', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, COOKIE_SECURE: 'true' });
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('leaves COOKIE_SECURE undefined when omitted', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV });
    expect(env.COOKIE_SECURE).toBeUndefined();
  });

  it('leaves COOKIE_SECURE undefined when set to an empty string', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, COOKIE_SECURE: '' });
    expect(env.COOKIE_SECURE).toBeUndefined();
  });

  it('rejects any value other than exactly "true" or "false"', () => {
    expect(() =>
      serverEnvironmentSchema.parse({ ...REQUIRED_ENV, COOKIE_SECURE: 'yes' }),
    ).toThrow();
    expect(() =>
      serverEnvironmentSchema.parse({ ...REQUIRED_ENV, COOKIE_SECURE: '1' }),
    ).toThrow();
  });
});

describe('resolveCookieSecure', () => {
  it('uses the explicit value when COOKIE_SECURE is true, even in development', () => {
    expect(resolveCookieSecure({ COOKIE_SECURE: true, NODE_ENV: 'development' })).toBe(true);
  });

  it('uses the explicit value when COOKIE_SECURE is false, even in production', () => {
    expect(resolveCookieSecure({ COOKIE_SECURE: false, NODE_ENV: 'production' })).toBe(false);
  });

  it('falls back to NODE_ENV === production when COOKIE_SECURE is omitted', () => {
    expect(resolveCookieSecure({ COOKIE_SECURE: undefined, NODE_ENV: 'production' })).toBe(true);
    expect(resolveCookieSecure({ COOKIE_SECURE: undefined, NODE_ENV: 'development' })).toBe(false);
    expect(resolveCookieSecure({ COOKIE_SECURE: undefined, NODE_ENV: 'test' })).toBe(false);
  });
});

describe('authRoutes cookie Secure attribute (real Set-Cookie headers via Fastify inject)', () => {
  class FakeAuthRepository implements AuthRepository {
    public async findUserByEmail(): Promise<UserRecord | null> {
      return null;
    }
    public async findUserById(): Promise<UserRecord | null> {
      return null;
    }
    public async createUser(data: CreateUserData): Promise<UserRecord> {
      return { id: 'user-1', email: data.email, role: 'USER', name: data.name, passwordHash: data.passwordHash };
    }
    public async createSession(data: CreateSessionData): Promise<SessionRecord> {
      return { id: data.id, userId: data.userId, tokenHash: data.tokenHash, expiresAt: data.expiresAt, revokedAt: null };
    }
    public async findSessionByTokenHash(): Promise<SessionRecord | null> {
      return null;
    }
    public async rotateSession(): Promise<void> {}
    public async revokeSession(): Promise<void> {}
    public async revokeAllUserSessions(): Promise<void> {}
  }

  class FakePasswordHasher implements PasswordHasher {
    public async hash(password: string): Promise<string> {
      return `hashed:${password}`;
    }
    public async verify(): Promise<boolean> {
      return true;
    }
  }

  async function buildTestApp(cookieSecure: boolean) {
    const tokenService = new TokenService('a'.repeat(32), 'b'.repeat(32), '15m', 30);
    const authService = new AuthService(new FakeAuthRepository(), new FakePasswordHasher(), tokenService);
    const app = Fastify();
    await app.register(cookie);
    await app.register(authRoutes, {
      prefix: '/api/v1/auth',
      authService,
      tokenService,
      cookieSecure,
    });
    return app;
  }

  // Generous timeout: this is the first real Fastify route-compilation + JWT
  // signing/verification work in the file, which is noticeably slower cold than on
  // a warmed-up worker (the structurally identical second test runs in a fraction
  // of the time) — not an indication of the cookie logic itself being slow.
  it(
    'sets cookies WITHOUT Secure when cookieSecure is false',
    async () => {
      const app = await buildTestApp(false);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'user@example.com', password: 'ValidPass123', name: 'Test User' },
      });
      expect(response.statusCode).toBe(201);
      const setCookieHeaders = response.headers['set-cookie'];
      expect(setCookieHeaders).toBeDefined();
      const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      expect(cookies.length).toBeGreaterThan(0);
      for (const header of cookies) {
        expect(header?.toLowerCase()).not.toContain('secure');
      }
      await app.close();
    },
    15_000,
  );

  it(
    'sets cookies WITH Secure when cookieSecure is true',
    async () => {
      const app = await buildTestApp(true);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'user2@example.com', password: 'ValidPass123', name: 'Test User' },
      });
      expect(response.statusCode).toBe(201);
      const setCookieHeaders = response.headers['set-cookie'];
      expect(setCookieHeaders).toBeDefined();
      const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      expect(cookies.length).toBeGreaterThan(0);
      for (const header of cookies) {
        expect(header?.toLowerCase()).toContain('secure');
      }
      await app.close();
    },
    15_000,
  );
});
