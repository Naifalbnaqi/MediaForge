import type { CreateJobData, DeletedJob, JobRecord } from './jobs.types.js';

export interface JobsRepository {
  create(data: CreateJobData): Promise<JobRecord>;
  /**
   * Conditionally transitions a `PENDING` job to `UPLOADED`. Conditional on the row
   * still being `PENDING` at write time for the same reason `markQueued`/
   * `markRetried` are: `UploadsService.complete` checks `status === 'PENDING'` on an
   * earlier read, but an unconditional write here would leave a real gap between
   * that read and this write — long enough for a concurrent stale-upload
   * reconciliation pass to cancel the row first, which an unconditional update would
   * then blindly overwrite back to `UPLOADED`. Returns `null` when the condition
   * didn't hold; the caller reports the same "not pending" conflict it already does
   * for the up-front check.
   */
  markUploaded(id: string): Promise<JobRecord | null>;
  findById(id: string): Promise<JobRecord | null>;
  findManyByUser(userId: string): Promise<JobRecord[]>;

  /**
   * Conditionally transitions an `UPLOADED` job to `QUEUED`, recording the requested
   * operation/options and incrementing `processingAttempt`. Called by
   * `ProcessingService.requestProcessing`, immediately before the job is handed to
   * the queue — never call this without also enqueueing (or the job will be stuck
   * QUEUED with nothing consuming it).
   *
   * The update is conditional on the row still being `UPLOADED` at write time (not
   * just at the caller's earlier read) — two concurrent requests for the same job can
   * only ever have one of them actually apply. Returns `null`, not an error, when the
   * condition didn't hold (someone else already moved it, or it changed state
   * underneath the caller); the caller decides what that means.
   */
  markQueued(
    id: string,
    operation: string,
    options: Record<string, unknown>,
  ): Promise<JobRecord | null>;
  /**
   * Transitions a job to `PROCESSING` and stamps `startedAt` (freshly, even if the
   * job was already `PROCESSING` — a redelivered job being resumed after an
   * interruption gets a new start time for that resumed attempt). Called by the
   * worker when it picks up a job, whether that's a fresh `QUEUED` delivery or a
   * `PROCESSING` job being resumed after an apparent crash.
   */
  markProcessing(id: string): Promise<JobRecord>;
  /**
   * Transitions a job to `COMPLETED`, stamps `completedAt`, and sets `progress` to
   * 100. Called by the worker on success.
   */
  markCompleted(id: string): Promise<JobRecord>;
  /**
   * Transitions a job to `FAILED`, recording a safe `errorCode`/`errorMessage` and
   * stamping `completedAt`. Called by the worker on a permanent processing failure,
   * and by the queue's terminal-failure handler once retries are exhausted.
   */
  markFailed(id: string, errorCode: string, errorMessage: string): Promise<JobRecord>;
  /**
   * Conditionally transitions a `FAILED` job back to `QUEUED` for a retry: resets
   * `errorCode`/`errorMessage`/`completedAt` to null and `progress` to 0, increments
   * `processingAttempt`, and leaves `operation`/`options` untouched (the retry redoes
   * the same requested operation against the same source object — nothing about what
   * was requested has changed, only that it's being attempted again).
   *
   * Conditional the same way `markQueued` is: only applies if the row is still
   * `FAILED` at write time. Returns `null` if a concurrent retry (or anything else)
   * already moved it — this is what makes a double-click on "Retry" safe without
   * relying on the queue layer to catch it.
   */
  markRetried(id: string): Promise<JobRecord | null>;

  /**
   * Finds up to `limit` `PENDING` jobs created at or before `olderThan`, oldest
   * first. Used exclusively by the stale-upload reconciliation sweep to find
   * candidates safe to act on — `olderThan` is always `now -
   * (UPLOAD_URL_TTL_SECONDS + PENDING_UPLOAD_GRACE_SECONDS)`
   * (`stale-upload-reconciliation.worker.ts`'s `computeSafeCutoff`), never just the
   * raw TTL: a presigned PUT can be accepted a moment before the URL's TTL boundary
   * and still legitimately finish landing bytes afterward, so a job younger than
   * TTL+grace must never even be considered a candidate here. A job returned here
   * is still only a *candidate*: by the time the caller tries to act on it, it may
   * already have transitioned (the browser could have finished uploading and
   * called `/complete` a moment later) — `markCancelled`/`markUploaded` are what
   * actually make the transition race-safe, not this read.
   */
  findStalePending(olderThan: Date, limit: number): Promise<JobRecord[]>;
  /**
   * Conditionally transitions a `PENDING` job to `CANCELLED`, recording why
   * (`errorCode`/`errorMessage`, the same fields `markFailed` uses — reused here
   * rather than adding cancellation-specific columns) and stamping `completedAt`.
   * Shared by two callers with different reasons but the identical mechanics: the
   * owner explicitly cancelling their own still-PENDING upload (at any time — see
   * `UploadsService.cancel`), and the background stale-upload sweep cancelling one
   * that's past the safe TTL+grace cutoff (see `findStalePending`).
   *
   * Conditional the same way `markQueued`/`markRetried` are: only applies if the row
   * is still `PENDING` at write time, not just at the caller's earlier read. This is
   * what makes the sweep race-safe against a concurrent, legitimate `/complete` call
   * racing to transition the same row to `UPLOADED` — whichever write reaches
   * Postgres first wins, and the loser's conditional update simply affects zero rows.
   * Returns `null` when the condition didn't hold; the caller decides what that means
   * (for the sweep: skip storage cleanup entirely, since the job wasn't actually
   * cancelled).
   */
  markCancelled(id: string, errorCode: string, errorMessage: string): Promise<JobRecord | null>;

  /**
   * Finds up to `limit` `CANCELLED` jobs, still carrying `USER_CANCELLED_ERROR_CODE`
   * (i.e. cancelled by their owner, not by the sweep — see
   * `stale-upload-reconciliation.worker.ts`), created at or before `olderThan`,
   * oldest first. `olderThan` is the *same* safe cutoff `findStalePending` uses —
   * `now - (UPLOAD_URL_TTL_SECONDS + PENDING_UPLOAD_GRACE_SECONDS)`, always measured
   * from the job's original `createdAt`, never from when it was cancelled: a manual
   * cancel can happen at any moment, including while the presigned URL is still
   * genuinely valid, so its storage object can't be safely deleted until the exact
   * same margin has passed that rules out a still-in-flight PUT. Excludes jobs the
   * sweep itself cancelled (`STALE_UPLOAD_ERROR_CODE`) — those are always already
   * past the safe cutoff by construction (they can only be cancelled once
   * `findStalePending` returns them) and are cleaned up immediately, not deferred.
   * Excludes jobs already marked cleaned by `markCancelledStorageCleaned` — this is
   * what keeps the query from growing unbounded as more jobs are cancelled over the
   * platform's lifetime.
   */
  findCancelledAwaitingStorageCleanup(olderThan: Date, limit: number): Promise<JobRecord[]>;
  /**
   * Conditionally "claims" a manually-cancelled job for storage cleanup by
   * rewriting its `errorCode` from `USER_CANCELLED_ERROR_CODE` to
   * `USER_CANCELLED_CLEANED_ERROR_CODE` — purely an internal bookkeeping marker,
   * invisible to the client (`errorCode` is never part of any response shape) and
   * deliberately not a change to `errorMessage`, which stays "Cancelled by you."
   * throughout.
   *
   * Conditional on the row still being `CANCELLED` with `errorCode ===
   * USER_CANCELLED_ERROR_CODE` at write time — this is what makes two overlapping
   * sweep ticks (this worker's own concurrency, or two different replicas) safe
   * against each other: only one can ever win the claim for a given job, so only
   * one ever actually calls `deleteObject` for it. Returns `null` when the
   * condition didn't hold (already claimed by a concurrent sweep, or — this should
   * never happen given `CANCELLED` is a terminal sink in this state machine — the
   * row somehow isn't in the expected state); the caller skips storage cleanup
   * entirely in that case.
   */
  markCancelledStorageCleaned(id: string): Promise<JobRecord | null>;

  /**
   * Permanently deletes `userId`'s own job `id`, **only if** it is still `FAILED` or
   * `CANCELLED` at write time — the same conditional-write pattern as `markQueued`/
   * `markRetried`/`markCancelled`, and for the same reason: `UploadsService.delete`
   * checks the status on an earlier read, but a concurrent Retry could move the job
   * back to `QUEUED` in between, and an unconditional delete would then destroy a
   * job a worker is about to run. Ownership is part of the same `WHERE`, so a job
   * belonging to someone else is indistinguishable from a missing one.
   *
   * The job's `ProcessedFile` and `JobInput` rows go with it (database-level
   * `ON DELETE CASCADE`); their storage object keys, and the job's own source key,
   * are returned (de-duplicated) because nothing in the database can name them once
   * the row is gone. Returns `null` — not an error — when nothing was deleted (no
   * such job, someone else's, no longer in a deletable status, or already deleted
   * by a concurrent request); the caller decides what that means.
   */
  deleteFinished(id: string, userId: string): Promise<DeletedJob | null>;

  /**
   * Counts this user's jobs currently `QUEUED` or `PROCESSING` — the "actively
   * consuming worker capacity right now" set. `PENDING`/`UPLOADED` (not yet
   * submitted) and `COMPLETED`/`FAILED`/`CANCELLED` (already finished, one way
   * or another) never count. Used by `ProcessingService` to enforce
   * `MAX_ACTIVE_JOBS_PER_USER` before a job is queued, whether via a fresh
   * submission or a retry — see `ProcessingService.enforceActiveJobLimit`'s doc
   * for the accepted race window against this being a plain read, not part of
   * the same transaction as the write it gates.
   */
  countActiveByUser(userId: string): Promise<number>;
}
