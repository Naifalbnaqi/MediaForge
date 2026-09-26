import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { bestEffortDeleteIfPresent, cancelPendingUpload } from '../application/jobs/upload-cancellation.js';
import type { JobsRepository } from '../domain/jobs/jobs.repository.js';
import type { ObjectStorageService } from '../services/storage.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('stale-upload-reconciliation');

export const STALE_UPLOAD_QUEUE_NAME = 'stale-upload-reconciliation';
/** Fixed id for both the repeatable scheduler and its job name — `upsertJobScheduler`
 * is keyed by this id, so every API/worker replica that calls
 * `scheduleStaleUploadReconciliation` at startup converges on the same single
 * scheduler entry in Redis rather than creating duplicates (see its own doc). */
const RECONCILE_JOB_ID = 'reconcile-stale-uploads';
/**
 * How often the sweep runs. Deliberately much shorter than the upload URL TTL (15m
 * default) so an abandoned upload is caught within a reasonable time of actually
 * becoming eligible, not left sitting for a full TTL+grace window — but a single
 * tick only processes up to `RECONCILE_BATCH_SIZE` candidates per query, so
 * convergence across a backlog happens over a few ticks, not necessarily the first
 * one.
 */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 100;

export const STALE_UPLOAD_ERROR_CODE = 'UPLOAD_EXPIRED';
export const STALE_UPLOAD_ERROR_MESSAGE =
  'This upload was not completed before the upload link expired.';

export interface StaleUploadReconciliationDeps {
  jobsRepository: JobsRepository;
  storage: ObjectStorageService;
}

/**
 * The two duration knobs that together define when a `PENDING` (or manually-
 * cancelled) upload is genuinely safe to act on. Bundled into one object rather
 * than two adjacent `number` parameters specifically to rule out a transposition
 * bug at call sites (`ServerEnvironment.UPLOAD_URL_TTL_SECONDS` and
 * `PENDING_UPLOAD_GRACE_SECONDS` are both plain seconds counts, so a swapped
 * argument order would type-check silently).
 */
export interface StaleUploadTimingConfig {
  /** How long a presigned upload URL is valid for — `ServerEnvironment.
   * UPLOAD_URL_TTL_SECONDS`. Must match what `S3StorageService` actually signed. */
  uploadUrlTtlSeconds: number;
  /**
   * Extra buffer *on top of* `uploadUrlTtlSeconds` before a `PENDING` (or
   * manually-cancelled) upload is safe to act on — `ServerEnvironment.
   * PENDING_UPLOAD_GRACE_SECONDS`. S3/MinIO validates a presigned PUT's signature
   * only when the request is first *accepted*, not continuously through the body
   * transfer — a PUT that started a moment before the URL's own TTL boundary can
   * still legitimately finish landing bytes afterward. Without this margin, a
   * sweep acting the instant the raw TTL elapses could race a genuinely in-flight
   * upload: delete an object moments before it finishes writing, or cancel a job
   * whose PUT is about to succeed. The effective safe cutoff used everywhere in
   * this module is always `createdAt + uploadUrlTtlSeconds + pendingUploadGraceSeconds`
   * — see `computeSafeCutoff`.
   */
  pendingUploadGraceSeconds: number;
}

/**
 * The one, shared "definitely no PUT against this job's presigned URL can still be
 * in flight" boundary — every query and decision in this module is gated on it.
 * Deliberately a single function so the stale-PENDING pass and the manually-
 * cancelled-storage-cleanup pass can never drift apart on what "safe" means.
 */
function computeSafeCutoff(timing: StaleUploadTimingConfig, now: Date): Date {
  return new Date(now.getTime() - (timing.uploadUrlTtlSeconds + timing.pendingUploadGraceSeconds) * 1000);
}

export interface ReconcileStaleUploadsResult {
  /** Jobs past the safe cutoff whose storage object matched what was declared at
   * initiate() time — self-healed straight to UPLOADED, the same outcome
   * `/complete` would have produced, rather than being cancelled. */
  completedCount: number;
  /** Jobs past the safe cutoff with no matching object in storage — genuinely
   * abandoned, cancelled and (if anything partial was left behind) cleaned up. */
  cancelledCount: number;
  /** Manually-cancelled jobs whose storage cleanup had been deferred past the
   * safe cutoff and was completed this tick. */
  cleanedCount: number;
  candidateCount: number;
}

/**
 * Reconciles two independent kinds of abandoned upload state in one sweep tick,
 * both gated on the exact same safe cutoff (`computeSafeCutoff`, always measured
 * from the job's original `createdAt` — i.e. when its presigned URL was issued —
 * never from when it was cancelled or from "now"):
 *
 * 1. `PENDING` jobs created at or before the safe cutoff. Before that cutoff a
 *    `PENDING` job is left completely untouched — not queried as a candidate at
 *    all, no storage access, no write of any kind — since a PUT against its
 *    presigned URL could still genuinely be in flight. Once past it, each
 *    candidate's storage is checked *before* deciding what to do with it: if a
 *    matching object already exists (the browser's PUT actually succeeded, but
 *    the `/complete` confirmation call never arrived — a closed tab, a dropped
 *    connection right after the PUT), the job is reconciled straight to
 *    `UPLOADED` via the *same* conditional `markUploaded` transition
 *    `UploadsService.complete` uses — never destroying a good upload just because
 *    its confirmation step didn't fire. Only a genuinely unmatched candidate (no
 *    object, or one whose size doesn't match what was declared — a partial/corrupt
 *    upload) is cancelled, with an immediate best-effort storage cleanup: safe
 *    here specifically because the candidate is already past the *full* safe
 *    cutoff, not just the raw TTL.
 *
 * 2. `CANCELLED` jobs the *owner* manually cancelled (`UploadsService.cancel`).
 *    A manual cancel moves the DB row to `CANCELLED` immediately — the owner's
 *    intent is acted on right away — but must NOT delete the storage object until
 *    the same safe cutoff has passed, for the identical reason (1) can't act
 *    early: the presigned URL might still be genuinely valid at cancel-time, with
 *    a PUT possibly in flight. See `findCancelledAwaitingStorageCleanup`'s doc.
 *
 * Pure and deps-injected so it's testable without a real Redis/BullMQ —
 * `createStaleUploadReconciliationWorker` below is the thin BullMQ wrapper that
 * actually schedules and invokes it in production.
 *
 * Safe to call repeatedly and concurrently (from multiple worker replicas, or a
 * redelivered/retried BullMQ occurrence of the same tick): both queries only ever
 * read current candidates, and the three conditional writes (`markUploaded`/
 * `markCancelled` for (1), `markCancelledStorageCleaned` for (2)) are the sole
 * places that mutate state — each conditional on the row still being in the exact
 * expected state at write time. Two overlapping calls racing on the same candidate
 * can therefore only ever have one of them actually act on it; the other sees its
 * conditional update affect zero rows and does nothing further, including no
 * storage access.
 */
export async function reconcileStaleUploads(
  deps: StaleUploadReconciliationDeps,
  timing: StaleUploadTimingConfig,
  now: Date = new Date(),
  batchSize: number = RECONCILE_BATCH_SIZE,
): Promise<ReconcileStaleUploadsResult> {
  const safeCutoff = computeSafeCutoff(timing, now);

  const candidates = await deps.jobsRepository.findStalePending(safeCutoff, batchSize);

  let completedCount = 0;
  let cancelledCount = 0;
  for (const candidate of candidates) {
    // Check storage *before* deciding: only once we know nothing valid is sitting
    // there do we treat this as abandoned. A size mismatch is treated the same as
    // "nothing there" — it's not a completable upload either way, just a
    // partial/corrupt one, and cancelling+cleaning it up is correct.
    const object = await deps.storage.headObject(candidate.sourceObjectKey);
    if (object && BigInt(object.sizeBytes) === candidate.sourceSizeBytes) {
      const completed = await deps.jobsRepository.markUploaded(candidate.id);
      if (completed) completedCount += 1;
      continue;
    }

    const cancelled = await cancelPendingUpload(
      deps.jobsRepository,
      deps.storage,
      candidate.id,
      STALE_UPLOAD_ERROR_CODE,
      STALE_UPLOAD_ERROR_MESSAGE,
    );
    if (cancelled) cancelledCount += 1;
  }

  // Same safeCutoff, same job.createdAt basis — a manual cancel's storage is never
  // safe to touch any earlier than a stale-PENDING job's would be.
  const awaitingCleanup = await deps.jobsRepository.findCancelledAwaitingStorageCleanup(
    safeCutoff,
    batchSize,
  );

  let cleanedCount = 0;
  for (const candidate of awaitingCleanup) {
    // Claim it first — this is what keeps two overlapping sweeps from both trying
    // to delete the same object (harmless on its own, since delete is idempotent,
    // but the claim is what makes exactly one of them respond to the *next* sweep
    // seeing this as "already handled" rather than a candidate forever).
    const claimed = await deps.jobsRepository.markCancelledStorageCleaned(candidate.id);
    if (!claimed) continue;
    await bestEffortDeleteIfPresent(deps.storage, claimed.sourceObjectKey, `cancelled job ${claimed.id}`);
    cleanedCount += 1;
  }

  return {
    completedCount,
    cancelledCount,
    cleanedCount,
    candidateCount: candidates.length + awaitingCleanup.length,
  };
}

/**
 * Registers (or re-confirms) the repeatable schedule that drives the sweep above.
 * `upsertJobScheduler` is idempotent by `RECONCILE_JOB_ID` — every API/worker
 * replica can call this on its own startup with no coordination and no risk of
 * scheduling duplicate recurring jobs, which is what makes this safe under multiple
 * replicas without a separate always-on scheduler service. Uses the same Redis
 * connection the caller's `Worker` already holds (BullMQ's own recommended pattern
 * for keeping connection count down), and closes its own short-lived `Queue` client
 * once the upsert completes — nothing needs to stay open past that single call.
 */
export async function scheduleStaleUploadReconciliation(
  connection: Redis,
  intervalMs: number = RECONCILE_INTERVAL_MS,
): Promise<void> {
  const queue = new Queue(STALE_UPLOAD_QUEUE_NAME, { connection });
  try {
    await queue.upsertJobScheduler(RECONCILE_JOB_ID, { every: intervalMs }, { name: RECONCILE_JOB_ID });
  } finally {
    await queue.close();
  }
}

/**
 * Builds the BullMQ `Worker` that consumes the repeatable job scheduled above.
 * `concurrency: 1` — a single sweep tick is a short, bounded DB scan, and there is
 * no benefit to running more than one at a time on the same process; cross-replica
 * overlap (a different worker process picking up a different tick) is still
 * possible and is exactly what the conditional DB transitions in
 * `reconcileStaleUploads` already make safe.
 */
export function createStaleUploadReconciliationWorker(
  deps: StaleUploadReconciliationDeps,
  connection: Redis,
  timing: StaleUploadTimingConfig,
): Worker {
  const worker = new Worker(
    STALE_UPLOAD_QUEUE_NAME,
    async () => {
      const result = await reconcileStaleUploads(deps, timing);
      if (result.candidateCount > 0) {
        log.info(
          {
            completed: result.completedCount,
            cancelled: result.cancelledCount,
            storageCleaned: result.cleanedCount,
            candidates: result.candidateCount,
          },
          'Stale-upload sweep finished',
        );
      }
      return result;
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    log.error({ sweepJobId: job?.id, err: error }, 'Stale-upload sweep tick failed');
  });

  return worker;
}
