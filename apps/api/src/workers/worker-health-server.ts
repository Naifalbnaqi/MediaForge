import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { type HealthCheck, runReadinessChecks } from '../utils/health-checks.js';

export interface WorkerHealthServerOptions {
  /** Dependency probes for `/health/ready`. */
  checks: readonly HealthCheck[];
  log: Logger;
  timeoutMs?: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * The worker has no public listener, so container/orchestrator probes need a tiny
 * side-channel of their own. Returns an unstarted `http.Server` (the caller decides
 * the port and lifecycle); it must never be published outside the private network.
 *
 * - `/health/live`: the event loop is answering — nothing else is checked.
 * - `/health/ready`: every injected check passes (database, Redis, both BullMQ workers
 *   running). 503 with per-check pass/fail otherwise.
 *
 * The health endpoint is auxiliary: if it cannot bind (`EADDRINUSE`, a denied port) the
 * failure is logged and the worker keeps processing jobs — an unhandled `error` event
 * here would otherwise crash it. Probes against that port then fail, which is the
 * correct signal.
 */
export function createWorkerHealthServer(options: WorkerHealthServerOptions): Server {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const path = (request.url ?? '').split('?')[0];
    if (path === '/health/live' || path === '/health') {
      sendJson(response, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }
    if (path === '/health/ready') {
      void runReadinessChecks(options.checks, options.timeoutMs).then(
        ({ response: report, failures }) => {
          for (const failure of failures) {
            options.log.warn({ check: failure.name, err: failure.error }, 'Readiness check failed');
          }
          sendJson(response, report.status === 'ok' ? 200 : 503, report);
        },
      );
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });
  server.on('error', (error) => {
    options.log.error({ err: error }, 'Worker health server error — health probes are unavailable');
  });
  return server;
}
