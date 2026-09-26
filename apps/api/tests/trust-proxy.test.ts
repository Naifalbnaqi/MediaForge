import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from '../src/utils/trust-proxy.js';

/** The nginx peer as the API sees it. */
const PROXY_ADDRESS = '172.18.0.9';

async function buildApp(hops: number, max = 3): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: resolveTrustProxy(hops) });
  // Same shape as buildApp() in src/app.ts: the per-IP limit is keyed on request.ip.
  await app.register(rateLimit, {
    global: true,
    max,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  return app;
}

function get(app: FastifyInstance, forwardedFor?: string) {
  return app.inject({
    method: 'GET',
    url: '/whoami',
    remoteAddress: PROXY_ADDRESS,
    ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
  });
}

describe('resolveTrustProxy', () => {
  it('trusts no proxy at all for 0 hops', () => {
    expect(resolveTrustProxy(0)).toBe(false);
  });

  it('trusts exactly the N nearest hops', () => {
    const trust = resolveTrustProxy(2);
    expect(trust).toBeTypeOf('function');
    if (typeof trust !== 'function') return;
    expect(trust('a', 0)).toBe(true);
    expect(trust('a', 1)).toBe(true);
    expect(trust('a', 2)).toBe(false);
  });
});

describe('request.ip behind one trusted reverse proxy', () => {
  it('uses the address the proxy appended, not a client-supplied leftmost entry', async () => {
    const app = await buildApp(1);
    // nginx appends the real peer to whatever the client sent: "<client claim>, <real>".
    const response = await get(app, '203.0.113.99, 198.51.100.7');
    expect(response.json()).toEqual({ ip: '198.51.100.7' });
  });

  it('cannot be used to dodge a per-IP rate limit by rotating X-Forwarded-For', async () => {
    const app = await buildApp(1, 3);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      // Same real attacker (198.51.100.7), a fresh fake address in front each time.
      const response = await get(app, `203.0.113.${i}, 198.51.100.7`);
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
  });

  it('still gives different real clients their own bucket', async () => {
    const app = await buildApp(1, 1);
    expect((await get(app, '198.51.100.1')).statusCode).toBe(200);
    expect((await get(app, '198.51.100.2')).statusCode).toBe(200);
    expect((await get(app, '198.51.100.1')).statusCode).toBe(429);
  });

  it('falls back to the socket peer when no forwarded header is present', async () => {
    const app = await buildApp(1);
    expect((await get(app)).json()).toEqual({ ip: PROXY_ADDRESS });
  });
});

describe('request.ip with proxy trust disabled (0 hops, the secure default)', () => {
  it('ignores X-Forwarded-For entirely', async () => {
    const app = await buildApp(0);
    const response = await get(app, '203.0.113.99, 198.51.100.7');
    expect(response.json()).toEqual({ ip: PROXY_ADDRESS });
  });
});

describe('request.ip behind two trusted proxies (load balancer, then nginx)', () => {
  it('skips the balancer hop and reports the client the balancer saw', async () => {
    const app = await buildApp(2);
    // client-claimed, real client (as the LB saw it), LB (as nginx saw it) is the socket peer.
    const response = await get(app, '203.0.113.99, 198.51.100.7, 10.0.0.2');
    expect(response.json()).toEqual({ ip: '198.51.100.7' });
  });
});
