import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { MEDIA_PROCESSING_QUEUE_NAME } from '../infrastructure/queue/bullmq-job-queue.js';
import { resolveJobInputs } from '../domain/job-inputs/resolve-job-inputs.js';
import type { JobInputsRepository } from '../domain/job-inputs/job-inputs.repository.js';
import type { JobsRepository } from '../domain/jobs/jobs.repository.js';
import type { ProcessedFilesRepository } from '../domain/processed-files/processed-files.repository.js';
import { InvalidDocumentError, type DocumentConversionService } from '../services/document-conversion.service.js';
import {
  InvalidImageError,
  InvalidMediaError,
  MediaConversionError,
  NoAudioStreamError,
  TrimRangeError,
  type MediaService,
} from '../services/media.service.js';
import type { ObjectStorageService } from '../services/storage.service.js';
import type { MediaJobMessage } from './job-queue.js';
import type { OperationInput, OperationOutput } from './operations/operation-handler.js';
import { lookupOperationHandler } from './operations/registry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('media-processing-worker');

/**
 * A reasonable default for a single worker process: FFmpeg conversion is CPU-bound
 * (libx264 encoding), so concurrency beyond a small multiple of available cores just
 * causes jobs to contend for the same CPU with no real throughput gain — 2 lets one
 * job's I/O-bound phases (download/upload/probe) overlap with another job's CPU-bound
 * encode without oversubscribing a typical small container's CPU allocation. Deployments
 * that provision more CPU can run more `worker` replicas (see docker-compose.yml)
 * rather than raising this per-process value arbitrarily.
 */
export const DEFAULT_WORKER_CONCURRENCY = 2;

export interface MediaProcessingWorkerDeps {
  jobsRepository: JobsRepository;
  jobInputsRepository: JobInputsRepository;
  processedFilesRepository: ProcessedFilesRepository;
  storage: ObjectStorageService;
  mediaService: MediaService;
  documentConversionService: DocumentConversionService;
}

const INVALID_MEDIA_ERROR_CODE = 'INVALID_MEDIA';
const INVALID_MEDIA_ERROR_MESSAGE = 'The uploaded file could not be processed as a valid video.';
/** A valid video that has no audio track, for an operation that needs one
 * (`extract-mp3`) — permanent, like `INVALID_MEDIA`, but worded accurately:
 * the generic message above would wrongly tell the user their (valid) video
 * isn't one. */
const NO_AUDIO_STREAM_ERROR_CODE = 'NO_AUDIO_STREAM';
const NO_AUDIO_STREAM_ERROR_MESSAGE = 'This video has no audio track, so there is no audio to extract.';
/** A valid video whose length doesn't include the requested trim window
 * (`trim-video`: start at/after the end, or a window that yielded no video) —
 * permanent, like `INVALID_MEDIA`, but worded accurately for the same reason as
 * `NO_AUDIO_STREAM` above. */
const TRIM_RANGE_ERROR_CODE = 'TRIM_RANGE_INVALID';
const TRIM_RANGE_ERROR_MESSAGE =
  'The selected time range does not contain any video. Choose a start time within the video.';
/** One of an `image-to-pdf` job's input files could not be decoded as an image
 * (corrupt, or its bytes don't match its declared type) — permanent, like
 * `INVALID_MEDIA`, but worded for images rather than video. */
const INVALID_IMAGE_ERROR_CODE = 'INVALID_IMAGE';
const INVALID_IMAGE_ERROR_MESSAGE =
  'One of the images could not be used. Remove or replace it and try again.';
/** A `document-to-pdf` job's input could not be converted to a usable PDF —
 * permanent, like `INVALID_MEDIA`, but worded for documents. */
const INVALID_DOCUMENT_ERROR_CODE = 'INVALID_DOCUMENT';
const INVALID_DOCUMENT_ERROR_MESSAGE =
  'This document could not be converted to PDF. Check that it opens correctly and try again.';
const CONVERSION_FAILED_ERROR_CODE = 'CONVERSION_FAILED';
const CONVERSION_FAILED_ERROR_MESSAGE = 'The uploaded file could not be converted.';
/** Written when a job's `operation` doesn't resolve to any entry in
 * `OPERATION_HANDLERS` — either genuinely corrupt/foreign data, or (Phase 7B+) a
 * name that's real in `processingOperations` but has no handler wired up yet.
 * Always permanent: no redelivery or retry will ever make an unregistered
 * operation executable. */
const UNSUPPORTED_OPERATION_ERROR_CODE = 'UNSUPPORTED_OPERATION';
const UNSUPPORTED_OPERATION_ERROR_MESSAGE = 'This processing operation is not supported.';
/** Written when a job's persisted `options` fail the handler's own re-validation
 * — see `OperationHandler.parseOptions`'s doc for why this is a type-safety
 * recovery step, not a second security boundary, and is still always a
 * permanent failure (the same bad JSON will fail identically on any retry). */
const INVALID_OPTIONS_ERROR_CODE = 'INVALID_OPTIONS';
const INVALID_OPTIONS_ERROR_MESSAGE = 'The requested processing options are invalid.';
/** Written only by `handleWorkerJobFailed`, once BullMQ has genuinely given up on a
 * job — either a transient-class failure (network/storage/DB blip) exhausted its
 * exception-retry budget, or repeated worker crashes/stalls exhausted the
 * stalled-job redelivery limit — never by `processMediaJob` itself, which only ever
 * writes the permanent, content-based codes above. The message is deliberately
 * generic across both causes: from the user's side, both are "please try again",
 * which is exactly what the retry action offers. */
const TRANSIENT_FAILURE_ERROR_CODE = 'PROCESSING_FAILED';
const TRANSIENT_FAILURE_ERROR_MESSAGE =
  'Processing could not be completed due to a temporary system error. Please try again.';

/**
 * Processes a single `{jobId, userId, attempt}` queue message end to end: load →
 * validate operation/options → resolve inputs → download → run the operation's own
 * handler → upload → record → complete.
 *
 * This function itself is entirely operation-agnostic — it never mentions FFmpeg,
 * MP4, or any specific operation by name. `lookupOperationHandler` (a registry
 * lookup, never an `if (operation === ...)` chain) is the only place that maps a
 * job's `operation` string to the code that actually processes it; see
 * `workers/operations/registry.ts`. Adding a real Phase 7B+ operation never touches
 * this function.
 *
 * Failure handling follows a strict permanent-vs-transient split, since this function
 * is BullMQ's processor and its return/throw behavior directly drives BullMQ's retry
 * mechanism:
 *  - An unresolved operation, invalid options, or a handler-thrown
 *    `InvalidMediaError`/`MediaConversionError` are permanent — this same job run
 *    again would fail identically. These are caught here, written to the Job row via
 *    `markFailed`, and this function returns normally (does not re-throw) so BullMQ
 *    considers the job resolved and never retries it.
 *  - Storage (`downloadToFile`/`uploadFromFile`), repository-write failures, and any
 *    other error a handler doesn't recognize as one of the two types above are left
 *    to propagate uncaught. BullMQ's own `attempts`/`backoff` (configured on the
 *    producer side, see `bullmq-job-queue.ts`) retries those automatically; only once
 *    retries — or, separately, stalled-job redeliveries (see below) — are exhausted
 *    does `handleWorkerJobFailed` (the Worker's `'failed'` event handler, wired in
 *    `createMediaProcessingWorker` below) write a `FAILED` status — never this
 *    function.
 *
 * Worker crash recovery: if this process dies mid-job (killed, OOM, container
 * restart) after having called `markProcessing` but before finishing, the Job row is
 * left at `PROCESSING` with no one working on it. BullMQ's own stalled-job detection
 * (any live `Worker` instance, including a freshly restarted one, checks for expired
 * locks on an interval) redelivers that same underlying queue job once
 * (`maxStalledCount` defaults to 1) — which invokes this function again, this time
 * seeing `status: 'PROCESSING'` rather than `'QUEUED'`. That is treated as "resume":
 * the whole pipeline below is re-run from scratch, which is safe because every step
 * is either idempotent or writes to a fresh location — a re-download overwrites
 * nothing (fresh temp dir), a re-upload writes a brand-new randomly-named object key,
 * and the only way this could ever produce two ProcessedFile rows for one job is if
 * an earlier attempt's *entire* pipeline secretly succeeded but crashed before
 * `markCompleted` could persist — a real but harmless case, already handled on the
 * read side by `OutputsService` picking the newest output. If the job stalls a
 * *second* time, BullMQ gives up on redelivering it at all and instead fails it
 * directly (see `handleWorkerJobFailed`) without ever invoking this function again —
 * so a job can be silently dropped only if this function is never called, which
 * cannot happen for either exhaustion path.
 */
export async function processMediaJob(
  deps: MediaProcessingWorkerDeps,
  message: MediaJobMessage,
): Promise<void> {
  // The queue message's userId is never trusted for anything beyond this log line —
  // the authoritative owner is job.userId, read fresh from Postgres below.
  const job = await deps.jobsRepository.findById(message.jobId);
  if (!job) {
    log.warn(
      { jobId: message.jobId, queuedByUserId: message.userId },
      'Job not found — nothing to process',
    );
    return;
  }

  const isResuming = job.status === 'PROCESSING';
  if (job.status !== 'QUEUED' && !isResuming) {
    // A stale/duplicate delivery: this job has already reached a terminal state
    // (COMPLETED/FAILED/CANCELLED) or hasn't been queued at all from this worker's
    // perspective (UPLOADED/PENDING). Do not throw, do not process, do not mark
    // anything — there is nothing for this delivery to do.
    log.info(
      { jobId: job.id, status: job.status },
      'Job is not QUEUED/PROCESSING — skipping stale delivery',
    );
    return;
  }
  if (isResuming) {
    log.warn(
      { jobId: job.id, userId: job.userId, attempt: message.attempt },
      'Job was already PROCESSING — resuming after an apparent interruption',
    );
  }

  // Validate operation/options *before* ever stamping PROCESSING or touching
  // storage — an unsupported operation or corrupted options is a permanent,
  // pre-flight failure, not a real processing attempt, so the job goes straight
  // to FAILED rather than flickering through PROCESSING first.
  const handler = lookupOperationHandler(job.operation);
  if (!handler) {
    log.error(
      { jobId: job.id, userId: job.userId, operation: job.operation },
      'Job has an unsupported operation — marking FAILED',
    );
    await deps.jobsRepository.markFailed(
      job.id,
      UNSUPPORTED_OPERATION_ERROR_CODE,
      UNSUPPORTED_OPERATION_ERROR_MESSAGE,
    );
    return;
  }
  let parsedOptions: unknown;
  try {
    parsedOptions = handler.parseOptions(job.options);
  } catch (error) {
    log.error(
      { jobId: job.id, userId: job.userId, operation: job.operation, err: error },
      'Job has invalid persisted options — marking FAILED',
    );
    await deps.jobsRepository.markFailed(job.id, INVALID_OPTIONS_ERROR_CODE, INVALID_OPTIONS_ERROR_MESSAGE);
    return;
  }

  // Re-stamps startedAt even when resuming — this run is a fresh attempt at the
  // pipeline, whatever happened before it did not finish.
  await deps.jobsRepository.markProcessing(job.id);

  // A securely random, per-job temp directory — never derived from jobId/userId/
  // fileName, so it can't collide or be guessed/traversed. Cleaned up on every path.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mediaforge-'));
  try {
    const normalizedInputs = await resolveJobInputs(deps.jobInputsRepository, job);

    const downloadedInputs: OperationInput[] = [];
    for (const [index, input] of normalizedInputs.entries()) {
      const destinationPath = path.join(tempDir, `input-${index}`);
      // Transient-class: a storage/network failure here is allowed to propagate so
      // BullMQ retries the whole job.
      await deps.storage.downloadToFile(input.objectKey, destinationPath);
      downloadedInputs.push({
        path: destinationPath,
        mimeType: input.mimeType,
        fileName: input.fileName,
      });
    }

    let output: OperationOutput;
    try {
      output = await handler.run({
        inputs: downloadedInputs,
        options: parsedOptions,
        outputDir: tempDir,
        mediaService: deps.mediaService,
        documentConversionService: deps.documentConversionService,
      });
    } catch (error) {
      // Must precede the InvalidMediaError branch: NoAudioStreamError and
      // TrimRangeError are subclasses of it, so the more general check below
      // would otherwise swallow them and persist the misleading generic message.
      if (error instanceof NoAudioStreamError) {
        await deps.jobsRepository.markFailed(job.id, NO_AUDIO_STREAM_ERROR_CODE, NO_AUDIO_STREAM_ERROR_MESSAGE);
        return;
      }
      if (error instanceof TrimRangeError) {
        await deps.jobsRepository.markFailed(job.id, TRIM_RANGE_ERROR_CODE, TRIM_RANGE_ERROR_MESSAGE);
        return;
      }
      if (error instanceof InvalidImageError) {
        await deps.jobsRepository.markFailed(job.id, INVALID_IMAGE_ERROR_CODE, INVALID_IMAGE_ERROR_MESSAGE);
        return;
      }
      if (error instanceof InvalidDocumentError) {
        await deps.jobsRepository.markFailed(job.id, INVALID_DOCUMENT_ERROR_CODE, INVALID_DOCUMENT_ERROR_MESSAGE);
        return;
      }
      if (error instanceof InvalidMediaError) {
        // Permanent, content-based failure (corrupt file, no video stream, etc.) —
        // the raw ffprobe error/stderr is deliberately not read or forwarded here,
        // only the fixed, safe message below is ever persisted.
        await deps.jobsRepository.markFailed(job.id, INVALID_MEDIA_ERROR_CODE, INVALID_MEDIA_ERROR_MESSAGE);
        return;
      }
      if (error instanceof MediaConversionError) {
        // Permanent failure — the fixed FFmpeg command will fail identically on retry.
        await deps.jobsRepository.markFailed(
          job.id,
          CONVERSION_FAILED_ERROR_CODE,
          CONVERSION_FAILED_ERROR_MESSAGE,
        );
        return;
      }
      // Anything else (a bug, an unexpected local I/O failure) is treated as
      // transient — propagate so BullMQ retries rather than silently mis-filing it
      // as a permanent, safe failure.
      throw error;
    }

    // Server-generated object key — same safe-key-generation pattern as
    // UploadsService.initiate, never derived from the original file name. Extension
    // comes from the handler's own output file name, not a hardcoded '.mp4' — this
    // is the one line that would otherwise need to change per future operation.
    const processedObjectKey = `processed/${job.userId}/${randomUUID()}${path.extname(output.fileName)}`;
    // Transient-class: allowed to propagate so BullMQ retries.
    await deps.storage.uploadFromFile(processedObjectKey, output.outputPath, output.mimeType);

    const { size: sizeBytes } = await stat(output.outputPath);

    await deps.processedFilesRepository.create({
      jobId: job.id,
      objectKey: processedObjectKey,
      fileName: output.fileName,
      mimeType: output.mimeType,
      sizeBytes: BigInt(sizeBytes),
    });

    await deps.jobsRepository.markCompleted(job.id);
  } finally {
    // Runs on every path above — success, permanent-failure return, or a propagating
    // transient error — so a failed job never leaks a temp directory.
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * The Worker's `'failed'` event fires after *every* failed attempt where a
 * processor-thrown exception is involved, not only the final one — but it is
 * genuinely terminal (no further redelivery of any kind is coming) in exactly two
 * cases, and this handler only ever writes to the Job row in those two:
 *
 *  1. `job.attemptsMade >= job.opts.attempts` — the normal exception-retry budget
 *     (`attempts`/`backoff`, configured in `bullmq-job-queue.ts`) is exhausted.
 *  2. `error instanceof UnrecoverableError` — BullMQ's signal that a job exceeded
 *     `maxStalledCount` (the worker crashed/stalled processing it more than once).
 *     This is a *distinct* mechanism from (1): once a job has stalled past the
 *     limit, BullMQ intercepts its *next* delivery before the processor ever runs
 *     and fails it directly with this error — meaning `processMediaJob`'s own
 *     resume-after-interruption logic never gets a chance to run again for that
 *     delivery, so the Job row is still sitting at `PROCESSING` when this fires.
 *     (Verified directly against the installed `bullmq` package's source —
 *     `Worker.getUnrecoverableErrorMessage`/`moveStalledJobsToWait-*.lua` — rather
 *     than assumed, since getting this wrong either marks a job FAILED while BullMQ
 *     still intends to retry it, or leaves a truly-exhausted job stuck forever.)
 *
 * In neither case does `processMediaJob` itself ever write FAILED for this class of
 * failure — only this handler does, and only once one of the two conditions holds.
 * Any other `'failed'` firing (more exception-retries remain, or a normal stall
 * within the allowed limit — which doesn't even reach this handler at all, since it
 * only ever emits `'stalled'`, not `'failed'`) is left alone; BullMQ will redeliver
 * on its own, and `processMediaJob`'s `QUEUED`/`PROCESSING` eligibility check picks it
 * back up.
 *
 * `job` can be `undefined` per BullMQ's own typing (e.g. a stalled job removed by
 * `removeOnFail` before this fires) — nothing useful to record in that case.
 */
export async function handleWorkerJobFailed(
  jobsRepository: JobsRepository,
  job: Job<MediaJobMessage> | undefined,
  error: Error,
): Promise<void> {
  if (!job) {
    log.error({ err: error }, 'A job failed with no job data attached');
    return;
  }

  const attemptsAllowed = job.opts.attempts ?? 1;
  const isUnrecoverable = error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
  const attemptsExhausted = job.attemptsMade >= attemptsAllowed;
  if (!isUnrecoverable && !attemptsExhausted) {
    log.warn(
      {
        jobId: job.data.jobId,
        attempt: job.attemptsMade,
        attemptsAllowed,
        err: error,
      },
      'Job attempt failed — BullMQ will retry',
    );
    return;
  }

  const reason = isUnrecoverable ? 'exceeded the stalled-job limit' : `exhausted all ${attemptsAllowed} attempts`;
  log.error({ jobId: job.data.jobId, reason, err: error }, 'Job failed permanently — marking FAILED');

  try {
    const current = await jobsRepository.findById(job.data.jobId);
    if (!current) {
      log.warn({ jobId: job.data.jobId }, 'Job no longer exists — nothing to record');
      return;
    }
    if (current.status === 'COMPLETED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
      // Already resolved — most plausibly, the interrupted attempt this stalled-job
      // failure refers to actually finished successfully just before its lock
      // expired, and a redelivery already ran the (idempotent) pipeline and
      // completed it. Overwriting that with FAILED would be strictly wrong.
      log.info(
        { jobId: job.data.jobId, status: current.status },
        'Job is already resolved — not overwriting with FAILED',
      );
      return;
    }
    await jobsRepository.markFailed(job.data.jobId, TRANSIENT_FAILURE_ERROR_CODE, TRANSIENT_FAILURE_ERROR_MESSAGE);
  } catch (markFailedError) {
    // Best-effort: if this DB write itself fails, there is nothing further this
    // handler can safely do. The Job row is left PROCESSING, which is a visible,
    // operator-recoverable stuck state rather than a silently-lost failure.
    log.error(
      { jobId: job.data.jobId, err: markFailedError },
      'Failed to record terminal failure for job',
    );
  }
}

/**
 * Builds (but does not start any out-of-band work beyond what BullMQ's `Worker`
 * constructor itself does) a BullMQ `Worker` wired to `processMediaJob` as its
 * processor and `handleWorkerJobFailed` as its terminal-failure recorder.
 * Dependency-injected so `processMediaJob`/`handleWorkerJobFailed` stay unit-testable
 * with fakes, independent of a real Redis connection.
 */
export function createMediaProcessingWorker(
  deps: MediaProcessingWorkerDeps,
  connection: Redis,
  concurrency: number = DEFAULT_WORKER_CONCURRENCY,
): Worker<MediaJobMessage> {
  const worker = new Worker<MediaJobMessage>(
    MEDIA_PROCESSING_QUEUE_NAME,
    async (job) => {
      await processMediaJob(deps, job.data);
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, error) => {
    void handleWorkerJobFailed(deps.jobsRepository, job, error);
  });

  return worker;
}
