import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobQueue, MediaJobMessage } from '../../workers/job-queue.js';

export const MEDIA_PROCESSING_QUEUE_NAME = 'media-processing';

/**
 * Builds the BullMQ `jobId` for one processing attempt. Deterministic per
 * `(jobId, processingAttempt)` pair — the same pair always produces the same id, so a
 * redelivery of the *same* attempt (a stall, a worker crash-and-restart before it
 * stalls out) lands on the same underlying queue entry rather than creating a
 * duplicate — while a *different* `processingAttempt` (a retry) always produces a
 * different id, so a retry never reuses a prior attempt's Redis job hash (which can
 * carry stale bookkeeping: attempts made, stalled-count, a possible deferred-failure
 * marker).
 *
 * Deliberately built with "-" rather than ":": BullMQ uses ":" internally as its
 * Redis key separator (job keys are stored as `<prefix>:<queueName>:<jobId>`), so a
 * custom `jobId` containing ":" can corrupt that keyspace — BullMQ's own docs call
 * this out as forbidden. `jobId` here is always our own DB-generated UUID (no ":" in
 * a UUID) and `processingAttempt` is a plain integer, so this format never needs to
 * be parsed back apart — it only has to be deterministic and collision-free per pair,
 * which string concatenation of two unambiguous, already-":"-free parts guarantees.
 */
export function buildProcessingJobId(jobId: string, processingAttempt: number): string {
  return `processing-${jobId}-${processingAttempt}`;
}

/**
 * `JobQueue` port implemented on top of BullMQ. This class only ever *produces*
 * (`enqueue`) — the worker/consumer side (the BullMQ `Worker` that actually pulls
 * jobs off this queue and runs FFmpeg) is a separate task and lives in a separate
 * process; nothing here starts a worker.
 */
export class BullMqJobQueue implements JobQueue {
  private readonly queue: Queue<MediaJobMessage>;

  /**
   * @param connection A dedicated `ioredis` connection with
   *   `maxRetriesPerRequest: null` — a hard BullMQ requirement for the blocking
   *   commands it issues internally. Must NOT be the same connection instance used
   *   for `@fastify/rate-limit` (that one is configured with
   *   `maxRetriesPerRequest: 1`, which BullMQ will refuse to work with).
   * @param queueName Defaults to `MEDIA_PROCESSING_QUEUE_NAME`; overridable for tests.
   */
  public constructor(connection: Redis, queueName: string = MEDIA_PROCESSING_QUEUE_NAME) {
    this.queue = new Queue<MediaJobMessage>(queueName, { connection });
  }

  public async enqueue(message: MediaJobMessage): Promise<void> {
    await this.queue.add('convert-to-mp4', message, {
      // `buildProcessingJobId(jobId, attempt)` (not the bare Job id) as BullMQ's
      // `jobId` option is what makes submission idempotent for free at this layer:
      // BullMQ refuses to create a second queue entry for a `jobId` that's already
      // present and not yet removed, so two concurrent requests for the *same*
      // attempt (e.g. a flaky client double-submitting) can never enqueue duplicate
      // work — matched by the repository's own conditional markQueued/markRetried,
      // which is the primary guard; this is defense in depth, not the only thing
      // preventing a duplicate. See `buildProcessingJobId` above for why the attempt
      // number is included and why "-" is used instead of ":".
      jobId: buildProcessingJobId(message.jobId, message.attempt),
      // 3 attempts: one real attempt plus two retries absorbs transient failures
      // (a momentary S3/MinIO blip, the worker container restarting mid-job) without
      // masking a genuinely broken input/operation behind endless retries.
      attempts: 3,
      backoff: {
        type: 'exponential',
        // 5s base delay: retries land at ~5s/10s/20s after the prior attempt, enough
        // spacing for a transient dependency (storage, DB) to recover without making
        // the user wait minutes for a job that's simply going to fail again.
        delay: 5000,
      },
      // Bounded history in both directions: unbounded retention would grow the Redis
      // keyspace forever. Completed jobs need less post-hoc inspection than failures,
      // so failures get a larger, longer-lived window.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
  }

  /** Closes the underlying BullMQ queue client. Call on app shutdown alongside the
   * Redis connection it was built from. */
  public async close(): Promise<void> {
    await this.queue.close();
  }
}
