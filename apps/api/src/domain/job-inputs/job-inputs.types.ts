/**
 * Domain view of a `JobInput` row — one ordered source file belonging to a job.
 * Phase 7A additive foundation only: nothing writes these rows yet (every job
 * today still uses `Job.sourceObjectKey`/`sourceFileName`/`sourceMimeType`/
 * `sourceSizeBytes` directly), but the type/port/repository exist now so the
 * worker's read side (`resolveJobInputs`) has a real, tested fallback path to
 * prefer once a future multi-input flow (image-to-pdf, Phase 7F) starts writing
 * to it — see `domain/job-inputs/resolve-job-inputs.ts`.
 */
export interface JobInputRecord {
  id: string;
  jobId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  /** Position among this job's inputs, zero-based. Unique per job
   * (`@@unique([jobId, order])`) — never two inputs claiming the same slot. */
  order: number;
  createdAt: Date;
}

export interface CreateJobInputData {
  jobId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  order: number;
}
