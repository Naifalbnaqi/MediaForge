import { describe, expect, it } from 'vitest';
import { processingOperationSchema, requestProcessingSchema } from '@media/validation';
import { ProcessingService } from '../src/application/jobs/processing.service.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { CreateJobInputData, JobInputRecord } from '../src/domain/job-inputs/job-inputs.types.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { CreateJobData, DeletedJob, JobRecord } from '../src/domain/jobs/jobs.types.js';
import type { JobQueue, MediaJobMessage } from '../src/workers/job-queue.js';

const DEFAULT_MAX_ACTIVE_JOBS = 3;

function makeJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    status: 'UPLOADED',
    sourceObjectKey: 'uploads/user-1/placeholder.mp4',
    sourceFileName: 'video.mp4',
    sourceMimeType: 'video/mp4',
    sourceSizeBytes: 100n,
    operation: null,
    options: {},
    progress: 0,
    processingAttempt: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Mirrors the real `PrismaJobsRepository`'s conditional-write semantics for
 * `markQueued`/`markRetried` (only applies if the row is still in the expected
 * status at write time, returns `null` otherwise) rather than a "dumb" fake that
 * always succeeds — this is what makes the race-losing/duplicate-retry tests below
 * meaningful, not just tautological. `countActiveByUser` is likewise a genuine
 * count over `jobs`, not a stub, so the active-job-limit tests below exercise real
 * behavior too.
 */
class FakeJobsRepository implements JobsRepository {
  public jobs = new Map<string, JobRecord>();
  public markQueuedCalls: Array<{ id: string; operation: string; options: Record<string, unknown> }> =
    [];
  public markRetriedCalls: string[] = [];
  private nextId = 1;

  public async create(data: CreateJobData): Promise<JobRecord> {
    // A unique id per call matters here specifically because the active-job-limit
    // tests create several jobs for the same user in one test — `CreateJobData`
    // has no `id` of its own, and `makeJob`'s hardcoded 'job-1' default would
    // otherwise silently collide (each `create()` overwriting the previous job in
    // the Map) the moment more than one job exists at once.
    const job = makeJob({ ...data, id: `job-${this.nextId++}`, status: 'PENDING' });
    this.jobs.set(job.id, job);
    return job;
  }

  public async markUploaded(id: string): Promise<JobRecord> {
    const job = this.get(id);
    const updated = { ...job, status: 'UPLOADED' as const };
    this.jobs.set(id, updated);
    return updated;
  }

  public async findById(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  public async findManyByUser(userId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.userId === userId);
  }

  public async markQueued(
    id: string,
    operation: string,
    options: Record<string, unknown>,
  ): Promise<JobRecord | null> {
    this.markQueuedCalls.push({ id, operation, options });
    const job = this.get(id);
    if (job.status !== 'UPLOADED') return null;
    const updated = {
      ...job,
      status: 'QUEUED' as const,
      operation,
      options,
      processingAttempt: job.processingAttempt + 1,
    };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markProcessing(id: string): Promise<JobRecord> {
    const job = this.get(id);
    const updated = { ...job, status: 'PROCESSING' as const, startedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markCompleted(id: string): Promise<JobRecord> {
    const job = this.get(id);
    const updated = { ...job, status: 'COMPLETED' as const, completedAt: new Date(), progress: 100 };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markFailed(id: string, errorCode: string, errorMessage: string): Promise<JobRecord> {
    const job = this.get(id);
    const updated = {
      ...job,
      status: 'FAILED' as const,
      errorCode,
      errorMessage,
      completedAt: new Date(),
    };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markRetried(id: string): Promise<JobRecord | null> {
    this.markRetriedCalls.push(id);
    const job = this.get(id);
    if (job.status !== 'FAILED') return null;
    const updated = {
      ...job,
      status: 'QUEUED' as const,
      errorCode: null,
      errorMessage: null,
      progress: 0,
      completedAt: null,
      processingAttempt: job.processingAttempt + 1,
    };
    this.jobs.set(id, updated);
    return updated;
  }

  public async findStalePending(): Promise<JobRecord[]> {
    return [];
  }

  public async markCancelled(id: string, errorCode: string, errorMessage: string): Promise<JobRecord | null> {
    const job = this.get(id);
    if (job.status !== 'PENDING') return null;
    const updated = { ...job, status: 'CANCELLED' as const, errorCode, errorMessage, completedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  public async findCancelledAwaitingStorageCleanup(): Promise<JobRecord[]> {
    return [];
  }

  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    return this.get(id);
  }

  public async countActiveByUser(userId: string): Promise<number> {
    return [...this.jobs.values()].filter(
      (job) => job.userId === userId && (job.status === 'QUEUED' || job.status === 'PROCESSING'),
    ).length;
  }

  public async deleteFinished(): Promise<DeletedJob | null> {
    throw new Error('deleteFinished is not exercised by this test file');
  }

  private get(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
    return job;
  }
}

class FakeJobQueue implements JobQueue {
  public enqueueCalls: MediaJobMessage[] = [];

  public async enqueue(message: MediaJobMessage): Promise<void> {
    this.enqueueCalls.push(message);
  }
}

/** Same shape as the fake used in media-processing.worker.test.ts: empty by
 * default, matching every single-input job in this file. */
class FakeJobInputsRepository implements JobInputsRepository {
  public rows = new Map<string, JobInputRecord[]>();

  public async create(data: CreateJobInputData): Promise<JobInputRecord> {
    const record: JobInputRecord = {
      id: `input-${(this.rows.get(data.jobId)?.length ?? 0) + 1}`,
      createdAt: new Date(),
      ...data,
    };
    this.rows.set(data.jobId, [...(this.rows.get(data.jobId) ?? []), record]);
    return record;
  }

  public async findByJobId(jobId: string): Promise<JobInputRecord[]> {
    return this.rows.get(jobId) ?? [];
  }
}

function buildService(maxActiveJobsPerUser: number = DEFAULT_MAX_ACTIVE_JOBS) {
  const repository = new FakeJobsRepository();
  const jobInputs = new FakeJobInputsRepository();
  const queue = new FakeJobQueue();
  const service = new ProcessingService(repository, jobInputs, queue, maxActiveJobsPerUser);
  return { repository, jobInputs, queue, service };
}

/** Creates and queues `count` jobs for `userId`, leaving each one QUEUED (i.e.
 * "active") — used to push a user right up to (or past) the active-job limit
 * before exercising the behavior under test. */
async function seedActiveJobs(repository: FakeJobsRepository, userId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const job = await repository.create({
      userId,
      sourceObjectKey: `uploads/${userId}/active-${i}.mp4`,
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    await repository.markQueued(job.id, 'convert-to-mp4', {});
  }
}

describe('ProcessingService.requestProcessing', () => {
  it("throws a 404-shaped error for another user's job, without calling markQueued or enqueue", async () => {
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'owner',
      sourceObjectKey: 'uploads/owner/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    await expect(
      service.requestProcessing('someone-else', job.id, 'convert-to-mp4', {}),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
    expect(repository.markQueuedCalls).toHaveLength(0);
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('throws a 404-shaped error for a job id that does not exist at all', async () => {
    const { service } = buildService();
    await expect(
      service.requestProcessing('user-1', 'nonexistent-job', 'convert-to-mp4', {}),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
  });

  it('rejects a job that is not in UPLOADED state, and never calls enqueue', async () => {
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    await repository.markQueued(job.id, 'convert-to-mp4', {});

    await expect(
      service.requestProcessing('user-1', job.id, 'convert-to-mp4', {}),
    ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_NOT_UPLOADED' });
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('rejects a PENDING (not-yet-uploaded) job the same way as any other non-UPLOADED state', async () => {
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });

    await expect(
      service.requestProcessing('user-1', job.id, 'convert-to-mp4', {}),
    ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_NOT_UPLOADED' });
    expect(repository.markQueuedCalls).toHaveLength(0);
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('rejects an invalid operation value at the Zod schema layer before it ever reaches the service', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'delete-everything' })).toThrow();
    expect(() => processingOperationSchema.parse('not-a-real-op')).toThrow();
    expect(requestProcessingSchema.parse({ operation: 'convert-to-mp4' })).toEqual({
      operation: 'convert-to-mp4',
    });
  });

  it('rejects an unrecognised key inside options at the Zod schema layer', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'convert-to-mp4', options: { quality: 'high' } }),
    ).toThrow();
  });

  it('on success, calls markQueued then enqueue (in that order), enqueueing with the job id and the new processingAttempt', async () => {
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const callOrder: string[] = [];
    const originalMarkQueued = repository.markQueued.bind(repository);
    repository.markQueued = async (...args) => {
      callOrder.push('markQueued');
      return originalMarkQueued(...args);
    };
    const originalEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (...args) => {
      callOrder.push('enqueue');
      return originalEnqueue(...args);
    };

    const result = await service.requestProcessing('user-1', job.id, 'convert-to-mp4', {});

    expect(callOrder).toEqual(['markQueued', 'enqueue']);
    expect(repository.markQueuedCalls).toEqual([{ id: job.id, operation: 'convert-to-mp4', options: {} }]);
    expect(queue.enqueueCalls).toEqual([{ jobId: job.id, userId: 'user-1', attempt: 1 }]);
    expect(result).toMatchObject({ id: job.id, status: 'QUEUED', progress: 0 });
  });

  it('two concurrent requests for the same job: only one succeeds, the other gets 409 and never enqueues', async () => {
    // Simulates the race directly at the repository boundary rather than trying to
    // fire genuinely simultaneous async calls (which wouldn't reliably interleave in
    // a single-threaded fake anyway) — the property under test is that the SERVICE
    // correctly turns a null markQueued return into a 409 and skips enqueueing,
    // which is exactly what two truly-concurrent Postgres UPDATE...WHERE statements
    // would produce (one row affected, one not).
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const [first, second] = await Promise.allSettled([
      service.requestProcessing('user-1', job.id, 'convert-to-mp4', {}),
      service.requestProcessing('user-1', job.id, 'convert-to-mp4', {}),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: 'JOB_NOT_UPLOADED',
    });
    // Only the winner's enqueue happened — never two.
    expect(queue.enqueueCalls).toHaveLength(1);
  });
});

describe('ProcessingService — active-job limit', () => {
  it('accepts a fresh submission when the caller is below the active-job limit', async () => {
    const { repository, queue, service } = buildService(3);
    await seedActiveJobs(repository, 'user-1', 2); // 2 active, limit is 3
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/new.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const result = await service.requestProcessing('user-1', job.id, 'convert-to-mp4', {});

    expect(result.status).toBe('QUEUED');
    expect(queue.enqueueCalls).toHaveLength(1);
  });

  it('rejects a fresh submission with a clear 429 once the caller is at the active-job limit', async () => {
    const { repository, queue, service } = buildService(3);
    await seedActiveJobs(repository, 'user-1', 3); // exactly at the limit
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/new.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    // seedActiveJobs itself calls markQueued 3 times to set up its fixture —
    // capture the count *after* setup so the assertion below only checks that
    // *this* request never reached markQueued, not that the array is empty.
    const markQueuedCallsBefore = repository.markQueuedCalls.length;

    await expect(service.requestProcessing('user-1', job.id, 'convert-to-mp4', {})).rejects.toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_ACTIVE_JOBS',
    });
    // Never even attempted to queue it.
    expect(repository.markQueuedCalls).toHaveLength(markQueuedCallsBefore);
    expect(queue.enqueueCalls).toHaveLength(0);
    expect((await repository.findById(job.id))?.status).toBe('UPLOADED');
  });

  it('does not let one user being at the limit affect another user', async () => {
    const { repository, queue, service } = buildService(3);
    await seedActiveJobs(repository, 'user-1', 3);
    const job = await repository.create({
      userId: 'user-2',
      sourceObjectKey: 'uploads/user-2/new.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const result = await service.requestProcessing('user-2', job.id, 'convert-to-mp4', {});

    expect(result.status).toBe('QUEUED');
    expect(queue.enqueueCalls).toHaveLength(1);
  });

  it('FAILED jobs do not count toward the active-job limit', async () => {
    const { repository, service } = buildService(3);
    // 3 FAILED jobs — none of them QUEUED/PROCESSING.
    for (let i = 0; i < 3; i += 1) {
      const failedJob = await repository.create({
        userId: 'user-1',
        sourceObjectKey: `uploads/user-1/failed-${i}.mp4`,
        sourceFileName: 'video.mp4',
        sourceMimeType: 'video/mp4',
        sourceSizeBytes: 100n,
      });
      await repository.markUploaded(failedJob.id);
      await repository.markQueued(failedJob.id, 'convert-to-mp4', {});
      await repository.markFailed(failedJob.id, 'CONVERSION_FAILED', 'nope');
    }
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/new.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const result = await service.requestProcessing('user-1', job.id, 'convert-to-mp4', {});

    expect(result.status).toBe('QUEUED');
  });

  it('COMPLETED jobs do not count toward the active-job limit', async () => {
    const { repository, service } = buildService(3);
    for (let i = 0; i < 3; i += 1) {
      const completedJob = await repository.create({
        userId: 'user-1',
        sourceObjectKey: `uploads/user-1/done-${i}.mp4`,
        sourceFileName: 'video.mp4',
        sourceMimeType: 'video/mp4',
        sourceSizeBytes: 100n,
      });
      await repository.markUploaded(completedJob.id);
      await repository.markQueued(completedJob.id, 'convert-to-mp4', {});
      await repository.markProcessing(completedJob.id);
      await repository.markCompleted(completedJob.id);
    }
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/new.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    const result = await service.requestProcessing('user-1', job.id, 'convert-to-mp4', {});

    expect(result.status).toBe('QUEUED');
  });

  it('retry is subject to the same active-job limit as a fresh submission', async () => {
    const { repository, service } = buildService(3);
    await seedActiveJobs(repository, 'user-1', 3);
    const failedJob = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/failed.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(failedJob.id);
    await repository.markQueued(failedJob.id, 'convert-to-mp4', {});
    await repository.markFailed(failedJob.id, 'CONVERSION_FAILED', 'nope');

    await expect(service.retryProcessing('user-1', failedJob.id)).rejects.toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_ACTIVE_JOBS',
    });
    expect((await repository.findById(failedJob.id))?.status).toBe('FAILED');
  });
});

describe('ProcessingService.retryProcessing', () => {
  async function buildFailedJob(repository: FakeJobsRepository, userId = 'user-1') {
    const job = await repository.create({
      userId,
      sourceObjectKey: `uploads/${userId}/x.mp4`,
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    await repository.markQueued(job.id, 'convert-to-mp4', {});
    await repository.markFailed(job.id, 'CONVERSION_FAILED', 'The uploaded file could not be converted.');
    return job;
  }

  it("denies retry to a user who does not own the upload (404, not ownership-revealing), and never enqueues", async () => {
    const { repository, queue, service } = buildService();
    const job = await buildFailedJob(repository, 'owner');

    await expect(service.retryProcessing('someone-else', job.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
    expect(repository.markRetriedCalls).toHaveLength(0);
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('throws a 404-shaped error for a job id that does not exist at all', async () => {
    const { service } = buildService();
    await expect(service.retryProcessing('user-1', 'nonexistent-job')).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
  });

  it.each(['UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PENDING'] as const)(
    'rejects a job in %s state (only FAILED is retryable), and never enqueues',
    async (status) => {
      const { repository, queue, service } = buildService();
      const job = await repository.create({
        userId: 'user-1',
        sourceObjectKey: 'uploads/user-1/x.mp4',
        sourceFileName: 'video.mp4',
        sourceMimeType: 'video/mp4',
        sourceSizeBytes: 100n,
      });
      repository.jobs.set(job.id, { ...job, status });

      await expect(service.retryProcessing('user-1', job.id)).rejects.toMatchObject({
        statusCode: 409,
        code: 'JOB_NOT_FAILED',
      });
      expect(queue.enqueueCalls).toHaveLength(0);
    },
  );

  it('resets errorCode/errorMessage/progress/completedAt, moves the job to QUEUED, and enqueues with the original operation', async () => {
    const { repository, queue, service } = buildService();
    const job = await buildFailedJob(repository);
    expect(repository.jobs.get(job.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'CONVERSION_FAILED',
    });

    const result = await service.retryProcessing('user-1', job.id);

    expect(result).toMatchObject({ id: job.id, status: 'QUEUED', progress: 0 });
    expect(result).not.toHaveProperty('errorMessage');
    const stored = repository.jobs.get(job.id);
    expect(stored).toMatchObject({
      status: 'QUEUED',
      errorCode: null,
      errorMessage: null,
      progress: 0,
      completedAt: null,
      operation: 'convert-to-mp4', // unchanged — the same requested operation, redone
    });
    expect(queue.enqueueCalls).toEqual([{ jobId: job.id, userId: 'user-1', attempt: 2 }]);
  });

  it('a successful retry can reach COMPLETED via the normal worker transitions', async () => {
    const { repository, service } = buildService();
    const job = await buildFailedJob(repository);

    await service.retryProcessing('user-1', job.id);
    expect(repository.jobs.get(job.id)?.status).toBe('QUEUED');

    // The rest of the lifecycle is the worker's responsibility (exercised directly in
    // media-processing.worker.test.ts) — this just confirms the retried job is a
    // completely normal QUEUED job as far as the state machine is concerned, not
    // stuck in some special "retried" state that the worker wouldn't recognize.
    await repository.markProcessing(job.id);
    const completed = await repository.markCompleted(job.id);
    expect(completed.status).toBe('COMPLETED');
  });

  it('a second concurrent retry click does not create duplicate queue work', async () => {
    const { repository, queue, service } = buildService();
    const job = await buildFailedJob(repository);

    const [first, second] = await Promise.allSettled([
      service.retryProcessing('user-1', job.id),
      service.retryProcessing('user-1', job.id),
    ]);

    const fulfilled = [first, second].filter((o) => o.status === 'fulfilled');
    const rejected = [first, second].filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: 'JOB_NOT_FAILED',
    });
    expect(queue.enqueueCalls).toHaveLength(1);
  });
});

describe('ProcessingService.processImageToPdf', () => {
  /** An UPLOADED job with `JobInput` rows already attached — exactly what
   * `UploadsService.initiateImageToPdf` + `complete()` produce. */
  async function buildUploadedImageToPdfJob(
    repository: FakeJobsRepository,
    jobInputs: FakeJobInputsRepository,
    userId = 'user-1',
    imageCount = 2,
  ) {
    const job = await repository.create({
      userId,
      sourceObjectKey: `uploads/${userId}/first.jpg`,
      sourceFileName: 'first.jpg',
      sourceMimeType: 'image/jpeg',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    for (let order = 0; order < imageCount; order += 1) {
      await jobInputs.create({
        jobId: job.id,
        objectKey: `uploads/${userId}/image-${order}.jpg`,
        fileName: `image-${order}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 100n,
        order,
      });
    }
    return job;
  }

  it("throws a 404-shaped error for another user's job, without calling markQueued or enqueue", async () => {
    const { repository, jobInputs, queue, service } = buildService();
    const job = await buildUploadedImageToPdfJob(repository, jobInputs, 'owner');

    await expect(
      service.processImageToPdf('someone-else', job.id),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
    expect(repository.markQueuedCalls).toHaveLength(0);
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('throws a 404-shaped error for a job id that does not exist at all', async () => {
    const { service } = buildService();
    await expect(
      service.processImageToPdf('user-1', 'nonexistent-job'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
  });

  it('rejects a job that is not UPLOADED, and never enqueues', async () => {
    const { repository, jobInputs, queue, service } = buildService();
    const job = await buildUploadedImageToPdfJob(repository, jobInputs);
    await repository.markQueued(job.id, 'image-to-pdf', {});

    await expect(
      service.processImageToPdf('user-1', job.id),
    ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_NOT_UPLOADED' });
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('rejects an UPLOADED job that has no JobInput rows (not an image-to-pdf job)', async () => {
    const { repository, queue, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/video.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    await expect(
      service.processImageToPdf('user-1', job.id),
    ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_NOT_IMAGE_TO_PDF' });
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  it('on success, calls markQueued with operation image-to-pdf and empty options, then enqueue', async () => {
    const { repository, jobInputs, queue, service } = buildService();
    const job = await buildUploadedImageToPdfJob(repository, jobInputs);

    const result = await service.processImageToPdf('user-1', job.id);

    expect(repository.markQueuedCalls).toEqual([{ id: job.id, operation: 'image-to-pdf', options: {} }]);
    expect(queue.enqueueCalls).toEqual([{ jobId: job.id, userId: 'user-1', attempt: 1 }]);
    expect(result).toMatchObject({ id: job.id, status: 'QUEUED', progress: 0 });
  });

  it('enforces the same active-job limit as requestProcessing', async () => {
    const { repository, jobInputs, queue, service } = buildService(1);
    await seedActiveJobs(repository, 'user-1', 1);
    const job = await buildUploadedImageToPdfJob(repository, jobInputs);

    await expect(service.processImageToPdf('user-1', job.id)).rejects.toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_ACTIVE_JOBS',
    });
    expect(queue.enqueueCalls).toHaveLength(0);
  });
});

describe('ProcessingService.getStatus', () => {
  it("throws a 404-shaped error for another user's job", async () => {
    const { repository, service } = buildService();
    const job = await repository.create({
      userId: 'owner',
      sourceObjectKey: 'uploads/owner/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });

    await expect(service.getStatus('someone-else', job.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
  });

  it('returns the expected safe shape for the owner, with no sourceObjectKey or queue/Redis details', async () => {
    const { repository, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);
    await repository.markQueued(job.id, 'convert-to-mp4', {});

    const status = await service.getStatus('user-1', job.id);

    expect(status).toEqual({
      id: job.id,
      status: 'QUEUED',
      progress: 0,
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      createdAt: job.createdAt.toISOString(),
    });
    expect(Object.keys(status)).not.toContain('sourceObjectKey');
    expect(Object.keys(status)).not.toContain('operation');
    expect(Object.keys(status)).not.toContain('options');
  });

  it('includes a safe errorMessage when the job has FAILED', async () => {
    const { repository, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markFailed(job.id, 'PROCESSING_FAILED', 'Processing could not be completed.');

    const status = await service.getStatus('user-1', job.id);

    expect(status).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Processing could not be completed.',
    });
  });

  it('includes a safe errorMessage when the job has been CANCELLED', async () => {
    const { repository, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markCancelled(job.id, 'UPLOAD_EXPIRED', 'This upload was not completed in time.');

    const status = await service.getStatus('user-1', job.id);

    expect(status).toMatchObject({
      status: 'CANCELLED',
      errorMessage: 'This upload was not completed in time.',
    });
  });
});
