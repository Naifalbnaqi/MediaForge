import { describe, expect, it } from 'vitest';
import { resolveJobInputs } from '../src/domain/job-inputs/resolve-job-inputs.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { CreateJobInputData, JobInputRecord } from '../src/domain/job-inputs/job-inputs.types.js';
import type { JobRecord } from '../src/domain/jobs/jobs.types.js';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    status: 'QUEUED',
    sourceObjectKey: 'uploads/user-1/legacy.mov',
    sourceFileName: 'legacy.mov',
    sourceMimeType: 'video/quicktime',
    sourceSizeBytes: 100n,
    operation: 'convert-to-mp4',
    options: {},
    progress: 0,
    processingAttempt: 1,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeJobInput(overrides: Partial<JobInputRecord>): JobInputRecord {
  return {
    id: 'input-1',
    jobId: 'job-1',
    objectKey: 'uploads/user-1/input-1.jpg',
    fileName: 'input-1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100n,
    order: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

class FakeJobInputsRepository implements JobInputsRepository {
  public rows: JobInputRecord[] = [];

  public async create(data: CreateJobInputData): Promise<JobInputRecord> {
    const record = makeJobInput(data);
    this.rows.push(record);
    return record;
  }

  public async findByJobId(jobId: string): Promise<JobInputRecord[]> {
    return this.rows.filter((row) => row.jobId === jobId);
  }
}

describe('resolveJobInputs', () => {
  it('falls back to the job legacy source fields as a single order:0 input when no JobInput rows exist', async () => {
    const jobInputsRepository = new FakeJobInputsRepository();
    const job = makeJob({
      sourceObjectKey: 'uploads/user-1/legacy.mov',
      sourceFileName: 'legacy.mov',
      sourceMimeType: 'video/quicktime',
      sourceSizeBytes: 500n,
    });

    const inputs = await resolveJobInputs(jobInputsRepository, job);

    expect(inputs).toEqual([
      {
        objectKey: 'uploads/user-1/legacy.mov',
        fileName: 'legacy.mov',
        mimeType: 'video/quicktime',
        sizeBytes: 500n,
        order: 0,
      },
    ]);
  });

  it('uses JobInput rows, ordered by `order`, when present — never falling back to the legacy fields', async () => {
    const jobInputsRepository = new FakeJobInputsRepository();
    // Seeded out of order on purpose — resolveJobInputs must sort, not trust
    // insertion/repository order.
    await jobInputsRepository.create({
      jobId: 'job-1',
      objectKey: 'uploads/user-1/second.jpg',
      fileName: 'second.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 200n,
      order: 1,
    });
    await jobInputsRepository.create({
      jobId: 'job-1',
      objectKey: 'uploads/user-1/first.jpg',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
      order: 0,
    });
    const job = makeJob(); // legacy source fields present but must be ignored

    const inputs = await resolveJobInputs(jobInputsRepository, job);

    expect(inputs.map((input) => input.fileName)).toEqual(['first.jpg', 'second.jpg']);
    expect(inputs.map((input) => input.order)).toEqual([0, 1]);
    expect(inputs.every((input) => input.objectKey !== job.sourceObjectKey)).toBe(true);
  });

  it('only ever returns rows belonging to the given job, even if the repository holds others', async () => {
    const jobInputsRepository = new FakeJobInputsRepository();
    await jobInputsRepository.create({
      jobId: 'other-job',
      objectKey: 'uploads/user-1/not-mine.jpg',
      fileName: 'not-mine.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
      order: 0,
    });
    const job = makeJob({ id: 'job-1' });

    const inputs = await resolveJobInputs(jobInputsRepository, job);

    // No JobInput rows for 'job-1' specifically, so this still falls back to the
    // legacy fields rather than picking up another job's rows.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.objectKey).toBe(job.sourceObjectKey);
  });
});
