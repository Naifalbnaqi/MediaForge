import type { JobStatusResponse } from '@media/types';
import type { ProcessingOperation } from '@media/validation';
import type { JobInputsRepository } from '../../domain/job-inputs/job-inputs.repository.js';
import type { JobsRepository } from '../../domain/jobs/jobs.repository.js';
import type { JobRecord } from '../../domain/jobs/jobs.types.js';
import type { JobQueue } from '../../workers/job-queue.js';
import { AppError } from '../../utils/app-error.js';

/**
 * Requests one specific processing operation for an already-`UPLOADED` job, and
 * reports back on a job's processing status. Kept separate from `UploadsService`
 * (which owns the PENDING → UPLOADED phase) — different responsibility, matching the
 * single-responsibility split already established between upload and processing.
 *
 * This service only enqueues work and reads status; it never runs FFmpeg/FFprobe or
 * touches storage bytes directly — that's the (separate) worker task's job.
 */
export class ProcessingService {
  public constructor(
    private readonly repository: JobsRepository,
    private readonly jobInputs: JobInputsRepository,
    private readonly queue: JobQueue,
    /** `ServerEnvironment.MAX_ACTIVE_JOBS_PER_USER` — the most jobs a single user
     * may have QUEUED+PROCESSING at once. Required (no in-code default), matching
     * `UploadsService.maxUploadSizeBytes`'s pattern: every config-driven limit's
     * *default value* lives only in `packages/config`, never duplicated here. */
    private readonly maxActiveJobsPerUser: number,
  ) {}

  public async requestProcessing(
    userId: string,
    jobId: string,
    operation: ProcessingOperation,
    options: Record<string, unknown>,
  ): Promise<JobStatusResponse> {
    const job = await this.repository.findById(jobId);
    // A missing job and a job owned by someone else both look like a 404 to this
    // caller — same pattern as UploadsService.complete — never reveal that a job ID
    // belonging to another user exists.
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    // Only an UPLOADED job may be submitted for processing. This is the entire
    // state-machine guard: PENDING (never finished uploading) is rejected because
    // there's nothing to process yet; QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED
    // are all rejected because the job has already been (or is already being)
    // submitted — re-submitting from any of those states would either double-enqueue
    // work or silently resurrect a finished/failed job. A caller who wants to retry a
    // FAILED job needs an explicit "retry" affordance (not built in this phase), not
    // an implicit one via re-POSTing /process.
    if (job.status !== 'UPLOADED') {
      throw new AppError(
        409,
        'JOB_NOT_UPLOADED',
        'This job cannot be submitted for processing from its current status',
      );
    }

    await this.enforceActiveJobLimit(userId);

    const queued = await this.repository.markQueued(jobId, operation, options);
    if (!queued) {
      // Lost a race: something else (most plausibly a concurrent duplicate request)
      // already moved this job out of UPLOADED between our read above and the
      // repository's conditional write. Same response as the upfront state check —
      // the caller doesn't need to know it was specifically a race.
      throw new AppError(
        409,
        'JOB_NOT_UPLOADED',
        'This job cannot be submitted for processing from its current status',
      );
    }
    // The DB write (markQueued) happens before the enqueue call: if the process
    // crashes between the two, the job is left QUEUED-but-never-enqueued rather than
    // enqueued-but-DB-still-UPLOADED, which is the safer failure mode (a stuck QUEUED
    // row is visible/recoverable by an operator; a queue message referencing a job
    // the DB still thinks is UPLOADED risks the worker and a retried client request
    // racing each other).
    await this.queue.enqueue({ jobId: queued.id, userId, attempt: queued.processingAttempt });

    return this.toStatusResponse(queued);
  }

  /**
   * Starts processing an `UPLOADED` `image-to-pdf` job — image-to-pdf's own,
   * separate counterpart to `requestProcessing`, taking no `operation`/`options`
   * from the caller (there is exactly one thing this job type can become,
   * fixed at `initiateImageToPdf` time by which endpoint was called, not
   * chosen here). Never accepts client-supplied options for the same reason
   * `requestProcessing` never accepts an `image-to-pdf` variant in the first
   * place — see the note on `processingOperations` in `@media/validation`.
   *
   * Requires the job to actually have `JobInput` rows — the one signal that it
   * was created through `initiateImageToPdf`, not an ordinary single-file
   * upload. A job with none is refused with the same `JOB_NOT_UPLOADED`-style
   * 409 `requestProcessing` uses for any other state mismatch, rather than
   * silently succeeding as a one-page PDF of an unrelated upload.
   */
  public async processImageToPdf(userId: string, jobId: string): Promise<JobStatusResponse> {
    const job = await this.repository.findById(jobId);
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    if (job.status !== 'UPLOADED') {
      throw new AppError(
        409,
        'JOB_NOT_UPLOADED',
        'This job cannot be submitted for processing from its current status',
      );
    }
    const inputs = await this.jobInputs.findByJobId(jobId);
    if (inputs.length === 0) {
      throw new AppError(
        409,
        'JOB_NOT_IMAGE_TO_PDF',
        'This job was not created as an image-to-PDF conversion',
      );
    }

    await this.enforceActiveJobLimit(userId);

    const queued = await this.repository.markQueued(jobId, 'image-to-pdf', {});
    if (!queued) {
      throw new AppError(
        409,
        'JOB_NOT_UPLOADED',
        'This job cannot be submitted for processing from its current status',
      );
    }
    await this.queue.enqueue({ jobId: queued.id, userId, attempt: queued.processingAttempt });

    return this.toStatusResponse(queued);
  }

  /**
   * Retries a `FAILED` job using the same already-stored source object and the same
   * `operation` it was originally submitted with — the owner isn't asked to resupply
   * anything. See `JobsRepository.markRetried` for the exact state reset (error
   * fields cleared, `processingAttempt` incremented) and its own concurrency guard.
   *
   * Subject to the same active-job limit as a fresh `requestProcessing` call: a
   * retry moves the job from FAILED (uncounted) to QUEUED (counted), so it
   * consumes a slot exactly like any other submission — a user already at the cap
   * from *other* jobs cannot bypass it by retrying instead of submitting fresh.
   */
  public async retryProcessing(userId: string, jobId: string): Promise<JobStatusResponse> {
    const job = await this.repository.findById(jobId);
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    if (job.status !== 'FAILED') {
      throw new AppError(
        409,
        'JOB_NOT_FAILED',
        'This job cannot be retried from its current status',
      );
    }

    await this.enforceActiveJobLimit(userId);

    const retried = await this.repository.markRetried(jobId);
    if (!retried) {
      // Lost a race (e.g. a double-click on Retry) — same response as the upfront
      // state check.
      throw new AppError(
        409,
        'JOB_NOT_FAILED',
        'This job cannot be retried from its current status',
      );
    }
    await this.queue.enqueue({ jobId: retried.id, userId, attempt: retried.processingAttempt });

    return this.toStatusResponse(retried);
  }

  /**
   * Rejects the request with a clear, safe 429 once the caller already has
   * `maxActiveJobsPerUser` jobs QUEUED+PROCESSING — a server-side abuse/fairness
   * guard against one user flooding the shared worker pool, not a per-job
   * correctness invariant. Reads Postgres (`JobsRepository.countActiveByUser`),
   * never any in-memory/per-replica state, so it's consistent across every API
   * replica.
   *
   * Known, accepted race window: the count-check and the subsequent conditional
   * `markQueued`/`markRetried` write are two separate statements, not one atomic
   * transaction — two requests from the same user racing at the exact limit
   * boundary could both pass this check and both succeed, momentarily exceeding
   * the cap by a small margin. This is deliberately not hardened further (e.g. via
   * a `SERIALIZABLE` transaction or a Postgres advisory lock): it's a soft,
   * UX-facing throttle, not a security or data-integrity boundary — unlike, say,
   * `markQueued`'s own conditional write, which *is* fully atomic and is what
   * actually prevents the same job from being double-queued.
   */
  private async enforceActiveJobLimit(userId: string): Promise<void> {
    const activeCount = await this.repository.countActiveByUser(userId);
    if (activeCount >= this.maxActiveJobsPerUser) {
      throw new AppError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        `You can have at most ${this.maxActiveJobsPerUser} files processing at once. Please wait for one to finish before starting another.`,
      );
    }
  }

  public async getStatus(userId: string, jobId: string): Promise<JobStatusResponse> {
    const job = await this.repository.findById(jobId);
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    return this.toStatusResponse(job);
  }

  /**
   * Maps a domain `JobRecord` to the safe transport shape. Deliberately never
   * includes `sourceObjectKey`, `operation`/`options` internals, or `errorCode` — a
   * client gets a human-readable `errorMessage` (when FAILED or CANCELLED) and
   * nothing else. CANCELLED reuses the same field so the frontend's existing
   * "fetch the reason for a terminal status" mechanism works unchanged for both —
   * see `errorMessage` handling in `apps/web/components/file-row.tsx`.
   */
  private toStatusResponse(job: JobRecord): JobStatusResponse {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      fileName: job.sourceFileName,
      mimeType: job.sourceMimeType,
      createdAt: job.createdAt.toISOString(),
      ...((job.status === 'FAILED' || job.status === 'CANCELLED') && job.errorMessage
        ? { errorMessage: job.errorMessage }
        : {}),
    };
  }
}
