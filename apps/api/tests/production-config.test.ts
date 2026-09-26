import { describe, expect, it } from 'vitest';
import { loadServerEnvironment } from '@media/config';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/app',
  REDIS_URL: 'redis://redis.internal:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY: 'AKIAREALLOOKINGKEY',
  S3_SECRET_KEY: 'real-looking-secret-value',
};

const PRODUCTION_ENV = {
  ...BASE_ENV,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://app.example.com',
  ADMIN_ORIGIN: 'https://app.example.com',
  COOKIE_SECURE: 'true',
  TRUST_PROXY_HOPS: '1',
};

describe('loadServerEnvironment — validation', () => {
  it('rejects identical access and refresh secrets in every environment', () => {
    expect(() =>
      loadServerEnvironment({ ...BASE_ENV, JWT_REFRESH_SECRET: BASE_ENV.JWT_ACCESS_SECRET }),
    ).toThrow(/must be different/);
  });

  it('does not echo secret values in the error', () => {
    try {
      loadServerEnvironment({ ...BASE_ENV, JWT_REFRESH_SECRET: BASE_ENV.JWT_ACCESS_SECRET });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(BASE_ENV.JWT_ACCESS_SECRET);
    }
  });

  it('requires explicit web and admin origins in production instead of defaulting to localhost', () => {
    const withoutOrigins: Record<string, string> = { ...PRODUCTION_ENV };
    delete withoutOrigins.WEB_ORIGIN;
    delete withoutOrigins.ADMIN_ORIGIN;
    expect(() => loadServerEnvironment(withoutOrigins)).toThrow(/WEB_ORIGIN, ADMIN_ORIGIN/);
    expect(() =>
      loadServerEnvironment({ ...withoutOrigins, WEB_ORIGIN: 'https://app.example.com' }),
    ).toThrow(/ADMIN_ORIGIN/);
  });

  it('treats an empty origin as missing in production', () => {
    expect(() => loadServerEnvironment({ ...PRODUCTION_ENV, WEB_ORIGIN: '' })).toThrow(
      /WEB_ORIGIN/,
    );
  });

  it('keeps the localhost origin defaults for development', () => {
    const environment = loadServerEnvironment({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(environment.WEB_ORIGIN).toBe('http://localhost:3000');
    expect(environment.ADMIN_ORIGIN).toBe('http://localhost:3001');
  });

  it('accepts a complete production configuration', () => {
    expect(loadServerEnvironment(PRODUCTION_ENV).NODE_ENV).toBe('production');
  });
});

describe('TRUST_PROXY_HOPS, WORKER_HEALTH_PORT and WORKER_CONCURRENCY', () => {
  it('default to trusting no proxy, port 4001 and two concurrent jobs', () => {
    const environment = loadServerEnvironment({ ...BASE_ENV });
    expect(environment.TRUST_PROXY_HOPS).toBe(0);
    expect(environment.WORKER_HEALTH_PORT).toBe(4001);
    expect(environment.WORKER_CONCURRENCY).toBe(2);
  });

  it('parse numeric strings', () => {
    const environment = loadServerEnvironment({
      ...BASE_ENV,
      TRUST_PROXY_HOPS: '2',
      WORKER_HEALTH_PORT: '0',
      WORKER_CONCURRENCY: '4',
    });
    expect(environment.TRUST_PROXY_HOPS).toBe(2);
    expect(environment.WORKER_HEALTH_PORT).toBe(0);
    expect(environment.WORKER_CONCURRENCY).toBe(4);
  });

  it('reject negative, fractional, oversized or non-numeric values', () => {
    for (const value of ['-1', '1.5', '11', 'many']) {
      expect(() => loadServerEnvironment({ ...BASE_ENV, TRUST_PROXY_HOPS: value })).toThrow();
    }
    expect(() => loadServerEnvironment({ ...BASE_ENV, WORKER_HEALTH_PORT: '70000' })).toThrow();
    for (const value of ['0', '-1', '17', '2.5', 'lots']) {
      expect(() => loadServerEnvironment({ ...BASE_ENV, WORKER_CONCURRENCY: value })).toThrow();
    }
  });
});
