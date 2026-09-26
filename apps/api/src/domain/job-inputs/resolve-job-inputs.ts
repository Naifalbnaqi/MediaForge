import type { JobRecord } from '../jobs/jobs.types.js';
import type { JobInputsRepository } from './job-inputs.repository.js';

/** The one shape every operation handler consumes, regardless of whether it was
 * backed by real `JobInput` rows or the legacy `Job.source*` fields — see
 * `resolveJobInputs`'s doc. */
export interface NormalizedJobInput {
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  order: number;
}

/**
 * Resolves the ordered set of source files a job should be processed against,
 * hiding the legacy-vs-relational storage distinction from every caller (the
 * worker, and any future code that needs to know what a job's inputs are):
 *
 * - If the job has `JobInput` rows, they're the authoritative, ordered input
 *   list (re-sorted here defensively, even though the repository is already
 *   expected to return them in order — the same "don't trust a possibly-
 *   violated ordering contract" posture `OutputsService.pickLatestOutput`
 *   takes for `ProcessedFile`).
 * - Otherwise (every job today), the job's own legacy `sourceObjectKey`/
 *   `sourceFileName`/`sourceMimeType`/`sourceSizeBytes` fields are returned as a
 *   single-element, `order: 0` input — exactly what every existing single-input
 *   operation (`convert-to-mp4`, and everything planned through Phase 7E) has
 *   always processed, just now reached through one normalized read instead of
 *   handlers reaching into `Job` fields directly.
 *
 * Operation handlers must only ever consume this function's output, never
 * `Job.sourceObjectKey` etc. directly — that's what keeps a future multi-input
 * operation (image-to-pdf, Phase 7F) from requiring any change to this function's
 * callers, and what keeps this fallback branching contained to exactly one place
 * instead of scattered through the worker.
 */
export async function resolveJobInputs(
  jobInputsRepository: JobInputsRepository,
  job: JobRecord,
): Promise<NormalizedJobInput[]> {
  const rows = await jobInputsRepository.findByJobId(job.id);
  if (rows.length > 0) {
    return [...rows]
      .sort((a, b) => a.order - b.order)
      .map((row) => ({
        objectKey: row.objectKey,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        order: row.order,
      }));
  }

  return [
    {
      objectKey: job.sourceObjectKey,
      fileName: job.sourceFileName,
      mimeType: job.sourceMimeType,
      sizeBytes: job.sourceSizeBytes,
      order: 0,
    },
  ];
}
