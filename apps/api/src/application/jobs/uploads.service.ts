import { randomUUID } from 'node:crypto';
import type {
  CleanupUploadsResponse,
  InitiateImageToPdfResponse,
  UploadedFileSummary,
  UploadInitiateResponse,
  UploadStatus,
} from '@media/types';
import {
  documentMimeTypes,
  imageToPdfMimeTypeExtensions,
  mimeTypeExtensions,
  MAX_DOCUMENT_SIZE_BYTES,
  type InitiateImageToPdfInput,
  type InitiateUploadInput,
} from '@media/validation';
import type { JobInputsRepository } from '../../domain/job-inputs/job-inputs.repository.js';
import type { JobsRepository } from '../../domain/jobs/jobs.repository.js';
import {
  isDeletableJobStatus,
  USER_CANCELLED_ERROR_CODE,
  USER_CANCELLED_ERROR_MESSAGE,
  type DeletableJobStatus,
  type JobRecord,
} from '../../domain/jobs/jobs.types.js';
import type { ObjectStorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/app-error.js';
import { bestEffortDeleteIfPresent } from './upload-cancellation.js';

/**
 * The same two numbers the stale-upload sweep uses to decide when no PUT against a
 * presigned URL can still be in flight (`createdAt + uploadUrlTtlSeconds +
 * pendingUploadGraceSeconds`) — deleting a just-cancelled upload has to respect the
 * identical boundary, see `UploadsService.delete`.
 */
export interface UploadCleanupTiming {
  uploadUrlTtlSeconds: number;
  pendingUploadGraceSeconds: number;
}

/**
 * Upper bound on files one bulk-cleanup request will delete. Each file costs a
 * couple of storage round trips, so an unbounded loop over an arbitrarily long
 * history would make one request unboundedly slow; anything beyond this is
 * reported as `remaining` and cleared by calling again.
 */
export const CLEANUP_BATCH_LIMIT = 100;

type DeleteOutcome = 'deleted' | 'cleanup-pending' | 'not-deletable' | 'gone';

export class UploadsService {
  public constructor(
    private readonly repository: JobsRepository,
    private readonly jobInputs: JobInputsRepository,
    private readonly storage: ObjectStorageService,
    private readonly maxUploadSizeBytes: number,
    private readonly cleanupTiming: UploadCleanupTiming,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async initiate(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<UploadInitiateResponse> {
    // Office documents (document-to-pdf) get a tighter ceiling than the general
    // upload cap, which is sized for video — see MAX_DOCUMENT_SIZE_BYTES's own
    // doc comment.
    const isDocument = (documentMimeTypes as readonly string[]).includes(input.contentType);
    const maxBytes = isDocument ? MAX_DOCUMENT_SIZE_BYTES : this.maxUploadSizeBytes;
    if (input.contentLength > maxBytes) {
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `File exceeds the maximum allowed upload size of ${maxBytes} bytes`,
      );
    }

    // The storage key is derived only from server-controlled data (userId + a random
    // id + a fixed extension for the declared MIME type) — the client-supplied
    // fileName is display metadata only and never touches the storage path.
    const objectKey = `uploads/${userId}/${randomUUID()}${mimeTypeExtensions[input.contentType]}`;

    const job = await this.repository.create({
      userId,
      sourceObjectKey: objectKey,
      sourceFileName: input.fileName,
      sourceMimeType: input.contentType,
      sourceSizeBytes: BigInt(input.contentLength),
    });

    const upload = await this.storage.createUploadUrl({
      objectKey,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });

    return {
      id: job.id,
      uploadUrl: upload.url,
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  public async complete(userId: string, jobId: string): Promise<UploadedFileSummary> {
    const job = await this.repository.findById(jobId);
    // A missing job and a job owned by someone else both look like a 404 to this
    // caller — never reveal that a job ID belonging to another user exists.
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    if (job.status !== 'PENDING') {
      throw new AppError(
        409,
        'UPLOAD_NOT_PENDING',
        'This upload has already been confirmed or is no longer pending',
      );
    }

    // A multi-input job (image-to-pdf) has `JobInput` rows created at initiate
    // time, one per image; every other job today has none. The client claiming
    // any of them succeeded is never sufficient on its own — a presigned PUT URL
    // only constrains what *can* be uploaded (see the
    // Content-Length-is-signed/Content-Type-is-not note in s3-storage.service.ts),
    // it never proves a PUT actually happened. Verify every object this job
    // depends on genuinely exists in storage, with the size declared at
    // initiate() time, before ever trusting status: UPLOADED.
    const inputs = await this.jobInputs.findByJobId(jobId);
    if (inputs.length > 0) {
      for (const input of inputs) {
        await this.verifyUploadedObject(input.objectKey, input.sizeBytes);
      }
    } else {
      await this.verifyUploadedObject(job.sourceObjectKey, job.sourceSizeBytes);
    }

    const updated = await this.repository.markUploaded(jobId);
    if (!updated) {
      // Lost a race: most plausibly the stale-upload reconciliation sweep cancelled
      // this exact row between the status check above and this write (it was, in
      // fact, old enough to be a stale candidate by the time this request landed).
      // Same response as the up-front state check — the caller doesn't need to know
      // it was specifically a race.
      throw new AppError(
        409,
        'UPLOAD_NOT_PENDING',
        'This upload has already been confirmed or is no longer pending',
      );
    }
    return this.toSummary(updated);
  }

  /**
   * Shared by `complete`'s single-input and multi-input (`image-to-pdf`) paths:
   * confirms one storage object genuinely exists with the size declared when its
   * upload URL was issued. Throws the same two safe, key-free 409s either path
   * already threw before this was extracted.
   */
  private async verifyUploadedObject(objectKey: string, expectedSizeBytes: bigint): Promise<void> {
    const object = await this.storage.headObject(objectKey);
    if (!object) {
      // Deliberately generic: never leak the object key, bucket, or endpoint.
      throw new AppError(
        409,
        'UPLOAD_NOT_FOUND_IN_STORAGE',
        'The uploaded file could not be found. Please try uploading again.',
      );
    }
    if (BigInt(object.sizeBytes) !== expectedSizeBytes) {
      throw new AppError(
        409,
        'UPLOAD_SIZE_MISMATCH',
        `The uploaded file size (${object.sizeBytes} bytes) does not match the expected size (${expectedSizeBytes.toString()} bytes). Please try uploading again.`,
      );
    }
  }

  /**
   * Initiates a multi-image `image-to-pdf` job: one `Job` row plus one ordered
   * `JobInput` row per image (page order == array order == `JobInput.order`),
   * and one presigned upload URL per image, returned in the same order. This is
   * image-to-pdf's own upload-initiation path — deliberately separate from
   * `initiate()` above (single-file), never a variant of it — see the note on
   * `processingOperations` in `@media/validation`.
   *
   * The Job's legacy `source*` fields are set from the *first* image only,
   * exactly as `JobInput`'s own schema comment describes: display-only
   * metadata for a multi-input job, never read by the worker once `JobInput`
   * rows exist (`resolveJobInputs` prefers them unconditionally). The first
   * image's `JobInput` row reuses the same generated object key as
   * `Job.sourceObjectKey` — the same underlying upload, named once.
   *
   * `Job.operation` is deliberately left `null` here, same as a fresh
   * single-file upload — it is set only once processing actually starts, by
   * `ProcessingService.processImageToPdf` after `complete()`. There is no
   * separate "choose a tool" step for this job type (it can only ever become
   * one thing), but the state machine (PENDING -> UPLOADED -> QUEUED) stays
   * identical to every other job.
   */
  public async initiateImageToPdf(
    userId: string,
    input: InitiateImageToPdfInput,
  ): Promise<InitiateImageToPdfResponse> {
    const [firstImage] = input.images;
    // initiateImageToPdfSchema guarantees at least one image.
    if (!firstImage) {
      throw new AppError(400, 'NO_IMAGES', 'At least one image is required');
    }
    const firstObjectKey = `uploads/${userId}/${randomUUID()}${imageToPdfMimeTypeExtensions[firstImage.contentType]}`;

    const job = await this.repository.create({
      userId,
      sourceObjectKey: firstObjectKey,
      sourceFileName: firstImage.fileName,
      sourceMimeType: firstImage.contentType,
      sourceSizeBytes: BigInt(firstImage.contentLength),
    });

    const uploads: { uploadUrl: string; expiresAt: string }[] = [];
    for (const [order, image] of input.images.entries()) {
      const objectKey =
        order === 0
          ? firstObjectKey
          : `uploads/${userId}/${randomUUID()}${imageToPdfMimeTypeExtensions[image.contentType]}`;

      await this.jobInputs.create({
        jobId: job.id,
        objectKey,
        fileName: image.fileName,
        mimeType: image.contentType,
        sizeBytes: BigInt(image.contentLength),
        order,
      });

      const upload = await this.storage.createUploadUrl({
        objectKey,
        contentType: image.contentType,
        contentLength: image.contentLength,
      });
      uploads.push({ uploadUrl: upload.url, expiresAt: upload.expiresAt.toISOString() });
    }

    return { id: job.id, uploads };
  }

  /**
   * Cancels the caller's own `PENDING` upload — the manual counterpart to the
   * background stale-upload reconciliation sweep (`reconcileStaleUploads`).
   *
   * Deliberately does **not** delete the storage object here, even if one already
   * exists: a manual cancel can happen at any moment, including while the presigned
   * PUT URL is still genuinely valid — a browser tab the user believes they've
   * already closed can still have an in-flight PUT landing bytes seconds later.
   * Deleting immediately could race that PUT and either destroy a good upload or
   * leave a half-written orphan behind. Storage cleanup for a manual cancel is
   * always deferred to the background sweep, which only acts once
   * `UPLOAD_URL_TTL_SECONDS + PENDING_UPLOAD_GRACE_SECONDS` has elapsed since this
   * job was *created* (not since it was cancelled) — the exact same safe cutoff the
   * sweep's stale-PENDING pass itself uses (see `findCancelledAwaitingStorage
   * Cleanup` and `stale-upload-reconciliation.worker.ts`'s `computeSafeCutoff`). By
   * then no PUT against the presigned URL can possibly still be running.
   */
  public async cancel(userId: string, jobId: string): Promise<UploadedFileSummary> {
    const job = await this.repository.findById(jobId);
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    if (job.status !== 'PENDING') {
      throw new AppError(
        409,
        'UPLOAD_NOT_PENDING',
        'This upload has already been confirmed or is no longer pending',
      );
    }

    const cancelled = await this.repository.markCancelled(
      jobId,
      USER_CANCELLED_ERROR_CODE,
      USER_CANCELLED_ERROR_MESSAGE,
    );
    if (!cancelled) {
      // Lost a race (e.g. a double-click, or the browser's own upload finished and
      // /complete won concurrently) — same response as the up-front state check.
      throw new AppError(
        409,
        'UPLOAD_NOT_PENDING',
        'This upload has already been confirmed or is no longer pending',
      );
    }
    return this.toSummary(cancelled);
  }

  public async list(userId: string): Promise<UploadedFileSummary[]> {
    const jobs = await this.repository.findManyByUser(userId);
    return jobs.map((job) => this.toSummary(job));
  }

  /**
   * Permanently deletes the caller's own `FAILED` or `CANCELLED` job: the database
   * row (its `ProcessedFile`/`JobInput` rows cascade with it) and every storage
   * object those records named.
   *
   * - Ownership: a missing job and someone else's job are the same 404, exactly like
   *   `complete`/`cancel` — never confirm that another user's job id exists.
   * - Status: anything but FAILED/CANCELLED is a 409 — active jobs are being worked
   *   on, `PENDING`/`UPLOADED` are still-usable uploads, `COMPLETED` holds an output.
   * - The one deliberate refusal inside an otherwise deletable status: a job the
   *   *owner* cancelled whose presigned upload URL might still be live
   *   (`UPLOAD_CLEANUP_PENDING`). Its storage cleanup is deferred to the sweep for the
   *   reason documented on `cancel` — a PUT could still land after we deleted the
   *   object, orphaning it — and deleting the row now would strand whatever lands
   *   there with no record left for anyone to find it. Refusing for the (at most
   *   TTL + grace) window is safe; deleting early would not be.
   * - Order: the conditional database delete is the authority (see
   *   `JobsRepository.deleteFinished`); storage is cleaned afterwards, best-effort,
   *   only for keys that job's own records named and that sit under the owner's own
   *   prefixes. An object already missing is fine; a transient storage error is
   *   logged and never undoes (or fails) a delete that already happened.
   */
  public async delete(userId: string, jobId: string): Promise<void> {
    const job = await this.repository.findById(jobId);
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }

    const outcome = await this.deleteFinishedJob(job);
    if (outcome === 'deleted') return;
    if (outcome === 'cleanup-pending') {
      throw new AppError(
        409,
        'UPLOAD_CLEANUP_PENDING',
        'This upload was just cancelled and is still being cleaned up. Try deleting it again in a few minutes.',
      );
    }
    if (outcome === 'gone') {
      // A concurrent request deleted it between our read and our write.
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    throw new AppError(409, 'JOB_NOT_DELETABLE', 'Only failed or cancelled files can be deleted.');
  }

  /**
   * Bulk counterpart of `delete` for the caller's own files in the given finished
   * states — each file goes through exactly the same checks and the same
   * conditional delete, so bulk cleanup can never do anything a single delete
   * could not. Files that can't be deleted right now (still-live upload URL, or
   * changed state mid-request) are skipped, not errors; at most
   * `CLEANUP_BATCH_LIMIT` files are processed per call.
   */
  public async cleanup(
    userId: string,
    statuses: readonly DeletableJobStatus[],
  ): Promise<CleanupUploadsResponse> {
    const wanted = new Set<DeletableJobStatus>(statuses);
    const candidates = (await this.repository.findManyByUser(userId)).filter(
      (job) => isDeletableJobStatus(job.status) && wanted.has(job.status),
    );
    const batch = candidates.slice(0, CLEANUP_BATCH_LIMIT);

    let deleted = 0;
    let skipped = 0;
    for (const job of batch) {
      if ((await this.deleteFinishedJob(job)) === 'deleted') deleted += 1;
      else skipped += 1;
    }
    return { deleted, skipped, remaining: candidates.length - batch.length };
  }

  /**
   * Shared by `delete` and `cleanup`. `job` must already have been loaded for (and
   * belong to) the acting user — this never looks anything up by id alone.
   */
  private async deleteFinishedJob(job: JobRecord): Promise<DeleteOutcome> {
    if (!isDeletableJobStatus(job.status)) return 'not-deletable';
    if (this.isStorageCleanupPending(job)) return 'cleanup-pending';

    const deleted = await this.repository.deleteFinished(job.id, job.userId);
    if (!deleted) {
      // Nothing was deleted: either it changed state (e.g. a Retry won the race) or a
      // concurrent request already removed it.
      return (await this.repository.findById(job.id)) ? 'not-deletable' : 'gone';
    }

    // Belt and braces on top of the keys being server-generated from this user's id:
    // never delete an object outside the owner's own upload/output prefixes, whatever
    // a record says.
    const ownedPrefixes = [`uploads/${job.userId}/`, `processed/${job.userId}/`];
    for (const objectKey of deleted.objectKeys) {
      if (!ownedPrefixes.some((prefix) => objectKey.startsWith(prefix))) {
        console.error(
          `[uploads.service] refusing to delete an object outside the owner's prefixes for deleted job ${job.id}`,
        );
        continue;
      }
      await bestEffortDeleteIfPresent(this.storage, objectKey, `deleted job ${job.id}`);
    }
    return 'deleted';
  }

  /**
   * True for a job the owner cancelled (`USER_CANCELLED`, storage cleanup still
   * deferred) that is younger than the sweep's safe cutoff — i.e. whose presigned
   * upload URL could still be live. Jobs the sweep cancelled, and user-cancelled
   * jobs already marked cleaned, were handled past the cutoff and are always safe.
   */
  private isStorageCleanupPending(job: JobRecord): boolean {
    if (job.status !== 'CANCELLED' || job.errorCode !== USER_CANCELLED_ERROR_CODE) return false;
    const { uploadUrlTtlSeconds, pendingUploadGraceSeconds } = this.cleanupTiming;
    const safeCutoffMs =
      this.now().getTime() - (uploadUrlTtlSeconds + pendingUploadGraceSeconds) * 1000;
    return job.createdAt.getTime() > safeCutoffMs;
  }

  /**
   * Maps a domain `JobRecord` to the safe transport shape. Deliberately never
   * includes `sourceObjectKey` (or any other storage/bucket detail) — the object key
   * is an internal implementation detail, not something a client should see.
   */
  private toSummary(job: JobRecord): UploadedFileSummary {
    return {
      id: job.id,
      fileName: job.sourceFileName,
      mimeType: job.sourceMimeType,
      sizeBytes: job.sourceSizeBytes.toString(),
      // Phase 4 (upload-only) never produces any other status; QUEUED/PROCESSING/etc.
      // are out of scope until the media-processing slice starts writing to Job rows.
      status: job.status as UploadStatus,
      createdAt: job.createdAt.toISOString(),
    };
  }
}
