import type { CreateJobInputData, JobInputRecord } from './job-inputs.types.js';

export interface JobInputsRepository {
  create(data: CreateJobInputData): Promise<JobInputRecord>;
  /** Returns this job's input rows ordered by `order` ascending, or an empty
   * array for a job that has none (every job today) — the empty case is exactly
   * what tells `resolveJobInputs` to fall back to the job's legacy source
   * fields instead. */
  findByJobId(jobId: string): Promise<JobInputRecord[]>;
}
