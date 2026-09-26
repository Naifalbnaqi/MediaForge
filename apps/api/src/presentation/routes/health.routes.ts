import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@media/types';
import { type HealthCheck, runReadinessChecks } from '../../utils/health-checks.js';

interface HealthRoutesOptions {
  /** Dependency probes for `/ready`. Empty means "ready as soon as the process is up". */
  readinessChecks?: readonly HealthCheck[];
  readinessTimeoutMs?: number;
}

/**
 * Two distinct questions, deliberately not conflated:
 * - `GET /health/live` (and the `GET /health` alias): is this process up and able to
 *   answer? Touches no dependency, so a database or Redis outage never gets an
 *   otherwise-healthy process restarted.
 * - `GET /health/ready`: can it currently do useful work — database, Redis and object
 *   storage reachable? 200 when yes, 503 (with per-dependency pass/fail only) when
 *   not. This is what a load balancer or `docker compose` healthcheck should gate on.
 *
 * All of these routes are exempt from rate limiting: probes come from one address at
 * a high frequency and must never be throttled into a false "unhealthy".
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions = {},
): Promise<void> {
  const readinessChecks = options.readinessChecks ?? [];
  const live = async (): Promise<HealthResponse> => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
  const exempt = { config: { rateLimit: false as const } };

  app.get('/', exempt, live);
  app.get('/live', exempt, live);
  app.get('/ready', exempt, async (request, reply) => {
    const { response, failures } = await runReadinessChecks(
      readinessChecks,
      options.readinessTimeoutMs,
    );
    for (const failure of failures) {
      request.log.warn({ check: failure.name, err: failure.error }, 'Readiness check failed');
    }
    return reply.status(response.status === 'ok' ? 200 : 503).send(response);
  });
}
