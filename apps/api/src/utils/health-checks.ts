import type { ReadinessCheckResult, ReadinessResponse } from '@media/types';

export interface HealthCheck {
  /** Stable, non-sensitive name reported to callers, e.g. `database`. */
  name: string;
  /** Resolves when the dependency is usable; rejects (or hangs) when it is not. */
  run(): Promise<unknown>;
}

export interface HealthCheckFailure {
  name: string;
  error: unknown;
}

export interface ReadinessReport {
  response: ReadinessResponse;
  /** Server-side only — for logging. Never send `error` to a client. */
  failures: HealthCheckFailure[];
}

export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

class HealthCheckTimeoutError extends Error {
  public constructor(name: string, timeoutMs: number) {
    super(`Health check "${name}" did not finish within ${timeoutMs} ms`);
  }
}

async function runOne(check: HealthCheck, timeoutMs: number): Promise<HealthCheckFailure | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HealthCheckTimeoutError(check.name, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
    return null;
  } catch (error) {
    return { name: check.name, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs every check concurrently, each bounded by `timeoutMs` so a hung dependency
 * (a black-holed TCP connection is the classic case) turns into a fast, explicit
 * failure instead of a probe that never returns. The response carries only names and
 * pass/fail; the underlying errors are returned separately for server-side logging.
 */
export async function runReadinessChecks(
  checks: readonly HealthCheck[],
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const outcomes = await Promise.all(checks.map((check) => runOne(check, timeoutMs)));
  const failures = outcomes.filter((outcome): outcome is HealthCheckFailure => outcome !== null);
  const results: Record<string, ReadinessCheckResult> = {};
  checks.forEach((check, index) => {
    results[check.name] = outcomes[index] === null ? 'ok' : 'failed';
  });
  return {
    response: {
      status: failures.length === 0 ? 'ok' : 'unavailable',
      timestamp: new Date().toISOString(),
      checks: results,
    },
    failures,
  };
}
