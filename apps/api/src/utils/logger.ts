import pino, { type Logger } from 'pino';

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

function resolveLevel(): string {
  // Tests exercise the failure paths on purpose; their expected errors are noise.
  if (process.env.NODE_ENV === 'test') return 'silent';
  const level = process.env.LOG_LEVEL;
  return level !== undefined && LEVELS.has(level) ? level : 'info';
}

/**
 * JSON logger for the worker process, the same library and line format Fastify already
 * uses for the API, so one log pipeline can ingest both. `component` distinguishes the
 * emitting module; callers add per-event fields (`jobId`, `attempt`, `err`, ...) instead
 * of interpolating them into the message, so they stay searchable.
 */
export function createLogger(component: string): Logger {
  return pino({ level: resolveLevel(), base: { component } });
}
