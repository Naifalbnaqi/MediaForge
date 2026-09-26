import type { AddressInfo } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthRoutes } from '../src/presentation/routes/health.routes.js';
import { type HealthCheck, runReadinessChecks } from '../src/utils/health-checks.js';
import { createLogger } from '../src/utils/logger.js';
import { createWorkerHealthServer } from '../src/workers/worker-health-server.js';

const ok = (name: string): HealthCheck => ({ name, run: async () => undefined });
const failing = (name: string, message: string): HealthCheck => ({
  name,
  run: async () => {
    throw new Error(message);
  },
});
const hanging = (name: string): HealthCheck => ({ name, run: () => new Promise(() => undefined) });

describe('runReadinessChecks', () => {
  it('reports ok when every check passes', async () => {
    const { response, failures } = await runReadinessChecks([ok('database'), ok('redis')]);
    expect(response.status).toBe('ok');
    expect(response.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(failures).toEqual([]);
  });

  it('reports unavailable and names only the failing dependency', async () => {
    const { response, failures } = await runReadinessChecks([
      ok('database'),
      failing('redis', 'connect ECONNREFUSED 10.1.2.3:6379'),
    ]);
    expect(response.status).toBe('unavailable');
    expect(response.checks).toEqual({ database: 'ok', redis: 'failed' });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe('redis');
  });

  it('never puts error text in the client-facing response', async () => {
    const { response } = await runReadinessChecks([
      failing('database', 'password authentication failed for user "media" at db.internal:5432'),
    ]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('db.internal');
  });

  it('turns a hung dependency into a fast failure instead of never returning', async () => {
    const started = Date.now();
    const { response, failures } = await runReadinessChecks(
      [ok('database'), hanging('storage')],
      30,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.checks).toEqual({ database: 'ok', storage: 'failed' });
    expect((failures[0]?.error as Error).message).toContain('did not finish');
  });

  it('is ready when there are no checks to fail', async () => {
    const { response } = await runReadinessChecks([]);
    expect(response.status).toBe('ok');
    expect(response.checks).toEqual({});
  });
});

async function buildHealthApp(checks: readonly HealthCheck[]) {
  const app = Fastify();
  await app.register(healthRoutes, { prefix: '/health', readinessChecks: checks });
  return app;
}

describe('health routes', () => {
  it('keeps GET /health as a liveness alias with the original response shape', async () => {
    const app = await buildHealthApp([failing('database', 'down')]);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('liveness never touches a dependency, so an outage cannot get a healthy process restarted', async () => {
    const run = vi.fn().mockRejectedValue(new Error('database is down'));
    const app = await buildHealthApp([{ name: 'database', run }]);
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });

  it('readiness returns 200 when every dependency is reachable', async () => {
    const app = await buildHealthApp([ok('database'), ok('redis'), ok('storage')]);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok', storage: 'ok' },
    });
  });

  it('readiness returns 503 naming the dependency that failed, without leaking why', async () => {
    const app = await buildHealthApp([
      ok('database'),
      failing('redis', 'connect ECONNREFUSED redis.internal:6379'),
      ok('storage'),
    ]);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: 'ok', redis: 'failed', storage: 'ok' },
    });
    expect(response.body).not.toContain('redis.internal');
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it('is exempt from the global rate limit that throttles ordinary routes', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 2, timeWindow: '1 minute' });
    await app.register(healthRoutes, { prefix: '/health', readinessChecks: [ok('database')] });
    app.get('/ordinary', async () => ({ ok: true }));

    const ordinary = [];
    for (let i = 0; i < 4; i += 1) {
      ordinary.push((await app.inject({ method: 'GET', url: '/ordinary' })).statusCode);
    }
    expect(ordinary).toEqual([200, 200, 429, 429]);

    for (let i = 0; i < 10; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    }
  });
});

describe('worker health server', () => {
  const servers: Array<ReturnType<typeof createWorkerHealthServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(checks: readonly HealthCheck[]): Promise<string> {
    const server = createWorkerHealthServer({ checks, log: createLogger('test'), timeoutMs: 50 });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers liveness without running any check', async () => {
    const run = vi.fn().mockRejectedValue(new Error('down'));
    const base = await start([{ name: 'database', run }]);
    const response = await fetch(`${base}/health/live`);
    expect(response.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers readiness 200 when every check passes', async () => {
    const base = await start([ok('database'), ok('redis'), ok('workers')]);
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok', workers: 'ok' },
    });
  });

  it('answers readiness 503 when a dependency fails or hangs, without leaking why', async () => {
    const base = await start([failing('database', 'secret-host:5432 refused'), hanging('redis')]);
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ checks: { database: 'failed', redis: 'failed' } });
    expect(text).not.toContain('secret-host');
  });

  it('returns 404 for unknown paths and 405 for non-GET methods', async () => {
    const base = await start([ok('database')]);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health/ready`, { method: 'POST' })).status).toBe(405);
  });

  it('logs a bind failure (EADDRINUSE) instead of crashing the worker', async () => {
    const base = await start([ok('database')]);
    const port = Number(new URL(base).port);
    const log = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const second = createWorkerHealthServer({ checks: [ok('database')], log });
    servers.push(second);

    // No 'error' listener is attached here: without the factory's own listener this
    // would surface as an uncaught exception and fail the run.
    second.listen(port, '127.0.0.1');
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code: 'EADDRINUSE' }) }),
      expect.stringContaining('health probes are unavailable'),
    );
    expect(second.listening).toBe(false);
    // The first server, which did bind, is unaffected.
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });
});
