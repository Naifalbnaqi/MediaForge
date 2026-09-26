export type JobStatus =
  | 'PENDING'
  | 'UPLOADED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * `Job.errorCode` value written when the owner cancels their own still-PENDING
 * upload (`UploadsService.cancel`). Lives here (domain), not in the application
 * service that writes it, because `PrismaJobsRepository` (infrastructure) also
 * needs the exact same literal to query for it — both layers depend inward on
 * this module, so this is the one place that doesn't create a layering violation
 * either way.
 *
 * Deliberately distinct from `STALE_UPLOAD_ERROR_CODE` (the background sweep's own
 * reason for cancelling an abandoned upload, defined alongside the sweep in
 * `stale-upload-reconciliation.worker.ts`) even though both land on `CANCELLED`: a
 * *manual* cancel can happen at any moment, including while the presigned URL is
 * still genuinely valid and a PUT could be in flight, whereas the sweep only ever
 * acts on jobs already provably past their URL's TTL — see
 * `JobsRepository.findCancelledAwaitingStorageCleanup` for why that distinction
 * drives two different storage-cleanup strategies (immediate vs. deferred).
 */
export const USER_CANCELLED_ERROR_CODE = 'USER_CANCELLED';
export const USER_CANCELLED_ERROR_MESSAGE = 'Cancelled by you.';
/**
 * Written over `USER_CANCELLED_ERROR_CODE` once the deferred sweep has confirmed
 * (and, if needed, performed) storage cleanup for a manually-cancelled job — see
 * `JobsRepository.markCancelledStorageCleaned`. Purely an internal bookkeeping
 * marker: `errorCode` is never sent to the client (see `ProcessingService.
 * toStatusResponse`), so this transition is invisible to the user — the job stays
 * CANCELLED with the same user-facing `errorMessage` throughout.
 */
export const USER_CANCELLED_CLEANED_ERROR_CODE = 'USER_CANCELLED_CLEANED';

/**
 * The only statuses an owner may permanently delete: jobs that are finished and
 * hold no work anyone still depends on. Everything else is refused —
 * `PENDING`/`UPLOADED` are usable uploads, `QUEUED`/`PROCESSING` are being worked
 * on right now, and `COMPLETED` holds an output the user still wants.
 */
export const DELETABLE_JOB_STATUSES = ['FAILED', 'CANCELLED'] as const;
export type DeletableJobStatus = (typeof DELETABLE_JOB_STATUSES)[number];

export function isDeletableJobStatus(status: JobStatus): status is DeletableJobStatus {
  return (DELETABLE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/**
 * Domain view of a `Job` row. Widened in the Phase 5 processing-request slice to
 * include the processing-only fields (operation, options, progress, error*,
 * started/completedAt) that the processing service and the (future) worker need to
 * read and write, alongside the upload-phase fields the Phase 4 slice already used.
 */
export interface JobRecord {
  id: string;
  status: JobStatus;
  sourceObjectKey: string;
  sourceFileName: string;
  sourceMimeType: string;
  sourceSizeBytes: bigint;
  operation: string | null;
  options: Record<string, unknown>;
  progress: number;
  /** Number of times this job has been moved into QUEUED — first submission is 1,
   * each retry increments it again. Used to derive a versioned BullMQ job id so a
   * retry never reuses a prior attempt's Redis job hash. */
  processingAttempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  userId: string;
  createdAt: Date;
}

export interface CreateJobData {
  userId: string;
  sourceObjectKey: string;
  sourceFileName: string;
  sourceMimeType: string;
  sourceSizeBytes: bigint;
}

/**
 * What `JobsRepository.deleteFinished` hands back once a job row is gone: the
 * deleted job, plus every storage object key that belonged to it (its source
 * object and the objects behind its `ProcessedFile`/`JobInput` rows, which the
 * database cascades away with the job) — the caller needs them to clean up
 * storage, and they can no longer be read from the database afterwards.
 */
export interface DeletedJob {
  job: JobRecord;
  objectKeys: string[];
}
