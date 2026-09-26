import type { JobsRepository } from '../../domain/jobs/jobs.repository.js';
import type { JobRecord } from '../../domain/jobs/jobs.types.js';
import type { ObjectStorageService } from '../../services/storage.service.js';

/**
 * Deletes `objectKey` from storage if (and only if) it genuinely exists there.
 * Best-effort and never throws: a transient S3/MinIO error must not undo, or fail
 * to report, a DB transition that already succeeded — the database remains the
 * final authority on the job's state either way. `context` is only for the log
 * line. Shared by every storage-cleanup call site in this module and in
 * `stale-upload-reconciliation.worker.ts`'s immediate-cleanup path.
 */
export async function bestEffortDeleteIfPresent(
  storage: ObjectStorageService,
  objectKey: string,
  context: string,
): Promise<void> {
  try {
    // Only ever deletes an object that genuinely exists — an abandoned upload that
    // never reached storage (the common case: the browser closed before the PUT
    // even started) has nothing to clean up, and calling deleteObject blindly would
    // make that the untested default rather than an explicit, verified choice.
    const object = await storage.headObject(objectKey);
    if (object) {
      await storage.deleteObject(objectKey);
    }
  } catch (storageError) {
    console.error(`[upload-cancellation] failed to clean up storage for ${context}`, storageError);
  }
}

/**
 * Conditionally cancels a `PENDING` job and immediately, best-effort cleans up its
 * storage object, if one exists. Only ever safe to call for a job already provably
 * past its presigned URL's TTL — that's the only thing that rules out a
 * still-in-flight PUT racing the deletion and leaving a "successful" upload
 * orphaned or, worse, the delete happening just before the PUT lands, silently
 * losing it. The background sweep's stale-PENDING pass is the sole caller today
 * (see `reconcileStaleUploads`); a *manual* cancel (`UploadsService.cancel`) must
 * NOT use this — it defers storage cleanup instead (see `USER_CANCELLED_ERROR_CODE`
 * and `JobsRepository.findCancelledAwaitingStorageCleanup`).
 *
 * The DB transition is the sole authority: `JobsRepository.markCancelled` is
 * conditional on the row still being `PENDING` at write time. When it returns
 * `null`, something else already moved the job — most plausibly the browser's own
 * upload finished and a concurrent `/complete` call won the race — and this
 * function does nothing further: storage is never touched for a job this call
 * didn't itself just win the transition on.
 */
export async function cancelPendingUpload(
  repository: JobsRepository,
  storage: ObjectStorageService,
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<JobRecord | null> {
  const cancelled = await repository.markCancelled(jobId, errorCode, errorMessage);
  if (!cancelled) return null;

  await bestEffortDeleteIfPresent(storage, cancelled.sourceObjectKey, `cancelled job ${cancelled.id}`);

  return cancelled;
}
