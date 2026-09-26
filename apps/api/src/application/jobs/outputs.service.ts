import type { ProcessedOutputResponse } from '@media/types';
import type { OutputDisposition } from '@media/validation';
import type { JobsRepository } from '../../domain/jobs/jobs.repository.js';
import type { ProcessedFilesRepository } from '../../domain/processed-files/processed-files.repository.js';
import type { ProcessedFileRecord } from '../../domain/processed-files/processed-files.types.js';
import type { ObjectStorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/app-error.js';

/**
 * Grants access to a completed job's processed artifact. Kept separate from
 * `UploadsService` (PENDING → UPLOADED) and `ProcessingService` (queueing + status)
 * because it owns a distinct concern with distinct dependencies: resolving the output
 * record and signing a short-lived URL for it.
 *
 * The authorization rule that matters here: the object key is always resolved from
 * server-side records reached *through* an ownership-checked job. No client-supplied
 * key is ever accepted, and nothing is signed until ownership and job state have been
 * verified.
 */
export class OutputsService {
  public constructor(
    private readonly jobs: JobsRepository,
    private readonly processedFiles: ProcessedFilesRepository,
    private readonly storage: ObjectStorageService,
  ) {}

  public async getProcessedOutput(
    userId: string,
    jobId: string,
    disposition: OutputDisposition,
  ): Promise<ProcessedOutputResponse> {
    const job = await this.jobs.findById(jobId);
    // Missing and not-yours collapse to the same 404 — the same non-enumerable
    // pattern used by UploadsService.complete and ProcessingService.
    if (!job || job.userId !== userId) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Upload not found');
    }
    if (job.status !== 'COMPLETED') {
      throw new AppError(409, 'JOB_NOT_COMPLETED', 'This upload has no processed output yet');
    }

    const output = pickLatestOutput(await this.processedFiles.findByJobId(jobId));
    if (!output) {
      // A COMPLETED job with no output row is an internal inconsistency, but from the
      // caller's side it is simply unavailable — and it deliberately shares a code
      // with the missing-object case below, since which of the two occurred is not
      // something a client needs (or should be told) to distinguish.
      throw new AppError(404, 'OUTPUT_NOT_AVAILABLE', 'The processed file is not available');
    }

    // The job row can say COMPLETED while the object itself is gone (a retention
    // sweep, a manual bucket change, a storage-side failure after the row was
    // written). Verifying first turns a confusing broken download into a clear error.
    // A genuine storage fault (network, credentials) throws from here and surfaces as
    // a 500 through the global error handler rather than being mistaken for "missing".
    const stored = await this.storage.headObject(output.objectKey);
    if (!stored) {
      throw new AppError(404, 'OUTPUT_NOT_AVAILABLE', 'The processed file is not available');
    }

    const { url, expiresAt } = await this.storage.createDownloadUrl({
      objectKey: output.objectKey,
      disposition,
      fileName: output.fileName,
      contentType: output.mimeType,
    });

    // Note the deliberate asymmetry with JobStatusResponse: fileName/mimeType/
    // sizeBytes here describe the *processed output*, not the original upload.
    return {
      jobId: job.id,
      fileName: output.fileName,
      mimeType: output.mimeType,
      sizeBytes: output.sizeBytes.toString(),
      url,
      expiresAt: expiresAt.toISOString(),
      disposition,
    };
  }
}

/**
 * Today a successful job produces exactly one output, but the schema models it as a
 * one-to-many. Picking the newest explicitly avoids depending on repository ordering
 * and stays correct if a retry ever writes a second row.
 */
function pickLatestOutput(outputs: ProcessedFileRecord[]): ProcessedFileRecord | undefined {
  return [...outputs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}
