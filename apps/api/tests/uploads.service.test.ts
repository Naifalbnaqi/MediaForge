import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_BATCH_LIMIT, UploadsService } from '../src/application/jobs/uploads.service.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { CreateJobInputData, JobInputRecord } from '../src/domain/job-inputs/job-inputs.types.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { CreateJobData, DeletedJob, JobRecord } from '../src/domain/jobs/jobs.types.js';
import type {
  DownloadRequest,
  ObjectStorageService,
  UploadRequest,
} from '../src/services/storage.service.js';

function makeJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    status: 'PENDING',
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

class FakeJobsRepository implements JobsRepository {
  public jobs = new Map<string, JobRecord>();
  public createCalls: CreateJobData[] = [];
  private nextId = 1;

  public async create(data: CreateJobData): Promise<JobRecord> {
    this.createCalls.push(data);
    const job = makeJob({
      id: `job-${this.nextId++}`,
      userId: data.userId,
      sourceObjectKey: data.sourceObjectKey,
      sourceFileName: data.sourceFileName,
      sourceMimeType: data.sourceMimeType,
      sourceSizeBytes: data.sourceSizeBytes,
      status: 'PENDING',
    });
    this.jobs.set(job.id, job);
    return job;
  }

  public async markUploaded(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    // Mirrors PrismaJobsRepository.markUploaded's conditional WHERE status: 'PENDING'
    // — a job that raced to CANCELLED (or anything else) underneath this call must
    // not be silently overwritten back to UPLOADED.
    if (!job || job.status !== 'PENDING') return null;
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
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
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
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
    const updated = { ...job, status: 'PROCESSING' as const, startedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markCompleted(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
    const updated = {
      ...job,
      status: 'COMPLETED' as const,
      completedAt: new Date(),
      progress: 100,
    };
    this.jobs.set(id, updated);
    return updated;
  }

  public async markFailed(id: string, errorCode: string, errorMessage: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
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
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
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

  public async findStalePending(olderThan: Date, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'PENDING' && job.createdAt.getTime() <= olderThan.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  public async markCancelled(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    // Mirrors the real conditional-write semantics: only a PENDING row can be
    // cancelled this way — anything else (already raced away, or simply never
    // PENDING) is a no-op, matching PrismaJobsRepository.markCancelled's WHERE clause.
    if (!job || job.status !== 'PENDING') return null;
    const updated = { ...job, status: 'CANCELLED' as const, errorCode, errorMessage, completedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  public async findCancelledAwaitingStorageCleanup(olderThan: Date, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === 'CANCELLED' &&
          job.errorCode === 'USER_CANCELLED' &&
          job.createdAt.getTime() <= olderThan.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'CANCELLED' || job.errorCode !== 'USER_CANCELLED') return null;
    const updated = { ...job, errorCode: 'USER_CANCELLED_CLEANED' };
    this.jobs.set(id, updated);
    return updated;
  }

  public async countActiveByUser(userId: string): Promise<number> {
    return [...this.jobs.values()].filter(
      (job) => job.userId === userId && (job.status === 'QUEUED' || job.status === 'PROCESSING'),
    ).length;
  }

  public deleteFinishedCalls: Array<{ id: string; userId: string }> = [];
  /** Extra storage keys a job's cascaded `ProcessedFile`/`JobInput` rows would name. */
  public childObjectKeys = new Map<string, string[]>();
  /** Runs right before the conditional delete — lets a test simulate a concurrent
   * request changing (or deleting) the row between the service's read and write. */
  public beforeDeleteFinished: ((id: string) => void) | undefined;

  public async deleteFinished(id: string, userId: string): Promise<DeletedJob | null> {
    this.deleteFinishedCalls.push({ id, userId });
    this.beforeDeleteFinished?.(id);
    const job = this.jobs.get(id);
    // Mirrors PrismaJobsRepository.deleteFinished's WHERE: id + owner + FAILED/CANCELLED
    // at write time, nothing else.
    if (!job || job.userId !== userId || !['FAILED', 'CANCELLED'].includes(job.status)) return null;
    this.jobs.delete(id);
    return {
      job,
      objectKeys: [...new Set([job.sourceObjectKey, ...(this.childObjectKeys.get(id) ?? [])])],
    };
  }
}

class FakeStorageService implements ObjectStorageService {
  public createUploadUrlCalls: UploadRequest[] = [];
  public headObjectCalls: string[] = [];
  public deleteObjectCalls: string[] = [];
  /** Keyed by objectKey. Defaults to "object exists with the size the test set up
   * via `create()`'s `sourceSizeBytes`" unless a test overrides it here. */
  public headObjectResults = new Map<string, { sizeBytes: number } | null>();

  public async createUploadUrl(request: UploadRequest): Promise<{ url: string; expiresAt: Date }> {
    this.createUploadUrlCalls.push(request);
    return {
      url: `https://storage.example.test/${request.objectKey}`,
      expiresAt: new Date('2026-01-01T00:15:00.000Z'),
    };
  }

  public async createDownloadUrl(
    request: DownloadRequest,
  ): Promise<{ url: string; expiresAt: Date }> {
    return { url: `https://storage.example.test/${request.objectKey}`, expiresAt: new Date() };
  }

  public async deleteObject(objectKey: string): Promise<void> {
    this.deleteObjectCalls.push(objectKey);
  }

  public async headObject(objectKey: string): Promise<{ sizeBytes: number } | null> {
    this.headObjectCalls.push(objectKey);
    if (!this.headObjectResults.has(objectKey)) {
      throw new Error(`FakeStorageService.headObject: no result configured for ${objectKey}`);
    }
    return this.headObjectResults.get(objectKey) ?? null;
  }

  public async downloadToFile(): Promise<void> {
    throw new Error('FakeStorageService.downloadToFile: not used by UploadsService');
  }

  public async uploadFromFile(): Promise<void> {
    throw new Error('FakeStorageService.uploadFromFile: not used by UploadsService');
  }

  public async checkAccessible(): Promise<void> {}
}

/** Same shape as the fake used in media-processing.worker.test.ts and
 * processing.service.test.ts: empty by default, matching every single-input
 * job — `complete()` then falls back to verifying `job.sourceObjectKey` alone. */
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

const MAX_SIZE = 1000;

/** TTL 900 s + grace 300 s: a presigned upload URL can be live for up to 20 minutes
 * after a job is created (same numbers the stale-upload sweep tests use). */
const CLEANUP_TIMING = { uploadUrlTtlSeconds: 900, pendingUploadGraceSeconds: 300 };
const NOW = new Date('2026-01-01T12:00:00.000Z');

function buildService() {
  const repository = new FakeJobsRepository();
  const jobInputs = new FakeJobInputsRepository();
  const storage = new FakeStorageService();
  const service = new UploadsService(repository, jobInputs, storage, MAX_SIZE, CLEANUP_TIMING, () => NOW);
  return { repository, jobInputs, storage, service };
}

describe('UploadsService.initiate', () => {
  it('rejects an oversized contentLength before touching the repository or storage', async () => {
    const { repository, storage, service } = buildService();

    await expect(
      service.initiate('user-1', {
        fileName: 'big.mp4',
        contentType: 'video/mp4',
        contentLength: MAX_SIZE + 1,
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });

    expect(repository.createCalls).toHaveLength(0);
    expect(storage.createUploadUrlCalls).toHaveLength(0);
  });

  it('applies the tighter MAX_DOCUMENT_SIZE_BYTES ceiling to a document upload rather than the general (video-sized) cap', async () => {
    const { MAX_DOCUMENT_SIZE_BYTES } = await import('@media/validation');
    const { repository, service } = buildService(); // maxUploadSizeBytes = MAX_SIZE = 1000, far smaller

    // Well over the test's general cap (1000 bytes) but under the document cap —
    // proves documents are judged against MAX_DOCUMENT_SIZE_BYTES, not
    // maxUploadSizeBytes.
    await service.initiate('user-1', {
      fileName: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentLength: MAX_SIZE + 1,
    });
    expect(repository.createCalls).toHaveLength(1);

    await expect(
      service.initiate('user-1', {
        fileName: 'huge.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentLength: MAX_DOCUMENT_SIZE_BYTES + 1,
      }),
    ).rejects.toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
    expect(repository.createCalls).toHaveLength(1); // unchanged — the oversized one never reached create()
  });

  it('generates a safe storage key that never contains the raw fileName', async () => {
    const { repository, service } = buildService();
    const dangerousFileName = '../../etc/passwd.mp4';

    await service.initiate('user-1', {
      fileName: dangerousFileName,
      contentType: 'video/mp4',
      contentLength: 500,
    });

    expect(repository.createCalls).toHaveLength(1);
    const objectKey = repository.createCalls[0]!.sourceObjectKey;
    expect(objectKey).toMatch(/^uploads\/user-1\/[0-9a-f-]+\.mp4$/);
    expect(objectKey).not.toContain(dangerousFileName);
    expect(objectKey).not.toContain('etc/passwd');
    expect(objectKey).not.toContain('..');
  });
});

describe('UploadsService.complete', () => {
  it("throws a 404-shaped error (not 403) for another user's job, without ever checking storage", async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'owner',
      sourceObjectKey: 'uploads/owner/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });

    await expect(service.complete('someone-else', job.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
    // Ownership must be checked before storage is ever consulted.
    expect(storage.headObjectCalls).toHaveLength(0);
  });

  it('throws a 404-shaped error for a job id that does not exist at all', async () => {
    const { service } = buildService();
    await expect(service.complete('user-1', 'nonexistent-job')).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
  });

  it('throws a conflict error when the job is already UPLOADED', async () => {
    const { repository, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.markUploaded(job.id);

    await expect(service.complete('user-1', job.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'UPLOAD_NOT_PENDING',
    });
  });

  it('transitions a PENDING job owned by the caller to UPLOADED when the object exists in storage with the expected size', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await service.complete('user-1', job.id);
    expect(result.status).toBe('UPLOADED');
    expect((await repository.findById(job.id))?.status).toBe('UPLOADED');
    expect(storage.headObjectCalls).toEqual([job.sourceObjectKey]);
  });

  it('rejects with a generic, key-free error when the object does not exist in storage, and never marks the job UPLOADED', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    storage.headObjectResults.set(job.sourceObjectKey, null);

    const error = await service.complete('user-1', job.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 409, code: 'UPLOAD_NOT_FOUND_IN_STORAGE' });
    expect((error as Error).message).not.toContain(job.sourceObjectKey);
    expect((error as Error).message).not.toContain('uploads/');
    expect((await repository.findById(job.id))?.status).toBe('PENDING');
  });

  it('rejects when the stored object size does not match the size declared at initiate(), and never marks the job UPLOADED', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 999 });

    const error = await service.complete('user-1', job.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 409, code: 'UPLOAD_SIZE_MISMATCH' });
    expect((error as Error).message).not.toContain(job.sourceObjectKey);
    expect((error as Error).message).not.toContain('uploads/');
    expect((await repository.findById(job.id))?.status).toBe('PENDING');
  });

  it('for a multi-input (image-to-pdf) job, verifies every JobInput object rather than just the legacy source field', async () => {
    const { repository, jobInputs, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/first.jpg',
      sourceFileName: 'first.jpg',
      sourceMimeType: 'image/jpeg',
      sourceSizeBytes: 100n,
    });
    await jobInputs.create({
      jobId: job.id,
      objectKey: 'uploads/user-1/first.jpg',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
      order: 0,
    });
    await jobInputs.create({
      jobId: job.id,
      objectKey: 'uploads/user-1/second.png',
      fileName: 'second.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
      order: 1,
    });
    storage.headObjectResults.set('uploads/user-1/first.jpg', { sizeBytes: 100 });
    storage.headObjectResults.set('uploads/user-1/second.png', { sizeBytes: 200 });

    const result = await service.complete('user-1', job.id);

    expect(result.status).toBe('UPLOADED');
    expect(storage.headObjectCalls).toEqual(['uploads/user-1/first.jpg', 'uploads/user-1/second.png']);
  });

  it('for a multi-input job, rejects and never marks UPLOADED if any one image is missing from storage', async () => {
    const { repository, jobInputs, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/first.jpg',
      sourceFileName: 'first.jpg',
      sourceMimeType: 'image/jpeg',
      sourceSizeBytes: 100n,
    });
    await jobInputs.create({
      jobId: job.id,
      objectKey: 'uploads/user-1/first.jpg',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
      order: 0,
    });
    await jobInputs.create({
      jobId: job.id,
      objectKey: 'uploads/user-1/second.png',
      fileName: 'second.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
      order: 1,
    });
    storage.headObjectResults.set('uploads/user-1/first.jpg', { sizeBytes: 100 });
    storage.headObjectResults.set('uploads/user-1/second.png', null);

    const error = await service.complete('user-1', job.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 409, code: 'UPLOAD_NOT_FOUND_IN_STORAGE' });
    expect((await repository.findById(job.id))?.status).toBe('PENDING');
  });

  it('for a multi-input job, rejects when one image size does not match what was declared', async () => {
    const { repository, jobInputs, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/first.jpg',
      sourceFileName: 'first.jpg',
      sourceMimeType: 'image/jpeg',
      sourceSizeBytes: 100n,
    });
    await jobInputs.create({
      jobId: job.id,
      objectKey: 'uploads/user-1/first.jpg',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
      order: 0,
    });
    storage.headObjectResults.set('uploads/user-1/first.jpg', { sizeBytes: 999 });

    const error = await service.complete('user-1', job.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 409, code: 'UPLOAD_SIZE_MISMATCH' });
    expect((await repository.findById(job.id))?.status).toBe('PENDING');
  });
});

describe('UploadsService.initiateImageToPdf', () => {
  function images(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      fileName: `image-${i}.jpg`,
      contentType: 'image/jpeg' as const,
      contentLength: 100 + i,
    }));
  }

  it('creates one Job plus one ordered JobInput row per image, and one presigned URL per image in the same order', async () => {
    const { repository, jobInputs, storage, service } = buildService();

    const result = await service.initiateImageToPdf('user-1', { images: images(3) });

    expect(repository.createCalls).toHaveLength(1);
    expect(repository.createCalls[0]).toMatchObject({
      userId: 'user-1',
      sourceFileName: 'image-0.jpg',
      sourceMimeType: 'image/jpeg',
      sourceSizeBytes: 100n,
    });

    const rows = await jobInputs.findByJobId(result.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.fileName)).toEqual(['image-0.jpg', 'image-1.jpg', 'image-2.jpg']);
    expect(rows.map((r) => r.sizeBytes)).toEqual([100n, 101n, 102n]);

    expect(result.uploads).toHaveLength(3);
    expect(storage.createUploadUrlCalls).toHaveLength(3);
  });

  it("reuses the Job's own sourceObjectKey as the first image's JobInput objectKey", async () => {
    const { repository, jobInputs, service } = buildService();

    const result = await service.initiateImageToPdf('user-1', { images: images(2) });

    const job = await repository.findById(result.id);
    const rows = await jobInputs.findByJobId(result.id);
    expect(rows[0]?.objectKey).toBe(job?.sourceObjectKey);
    // Every image gets its own distinct object key.
    expect(new Set(rows.map((r) => r.objectKey)).size).toBe(2);
  });

  it('generates safe storage keys that never contain the raw fileName', async () => {
    const { jobInputs, service } = buildService();
    const dangerousFileName = '../../etc/passwd.jpg';

    const result = await service.initiateImageToPdf('user-1', {
      images: [{ fileName: dangerousFileName, contentType: 'image/jpeg', contentLength: 100 }],
    });

    const [row] = await jobInputs.findByJobId(result.id);
    expect(row?.objectKey).toMatch(/^uploads\/user-1\/[0-9a-f-]+\.jpg$/);
    expect(row?.objectKey).not.toContain(dangerousFileName);
    expect(row?.objectKey).not.toContain('..');
  });

  it('creates a fresh Job in PENDING with a null operation — the same starting state as a single-file upload', async () => {
    const { repository, service } = buildService();

    const result = await service.initiateImageToPdf('user-1', { images: images(1) });

    // complete()/processImageToPdf rely on this: a multi-input job starts
    // identically to a single-file one, and only diverges once JobInput rows
    // are consulted — operation is set only once processing actually starts.
    const job = await repository.findById(result.id);
    expect(job).toMatchObject({ status: 'PENDING', operation: null });
  });
});

describe('UploadsService.cancel', () => {
  it("throws a 404-shaped error (not 403) for another user's job, without touching storage or the job", async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'owner',
      sourceObjectKey: 'uploads/owner/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });

    await expect(service.cancel('someone-else', job.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
    expect((await repository.findById(job.id))?.status).toBe('PENDING');
  });

  it('throws a 404-shaped error for a job id that does not exist at all', async () => {
    const { service } = buildService();
    await expect(service.cancel('user-1', 'nonexistent-job')).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
    });
  });

  it.each(['UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'refuses to cancel a job that is already %s, and never touches storage',
    async (status) => {
      const { repository, storage, service } = buildService();
      const job = await repository.create({
        userId: 'user-1',
        sourceObjectKey: 'uploads/user-1/x.mp4',
        sourceFileName: 'video.mp4',
        sourceMimeType: 'video/mp4',
        sourceSizeBytes: 100n,
      });
      repository.jobs.set(job.id, { ...job, status });

      await expect(service.cancel('user-1', job.id)).rejects.toMatchObject({
        statusCode: 409,
        code: 'UPLOAD_NOT_PENDING',
      });
      expect(storage.headObjectCalls).toHaveLength(0);
      expect(storage.deleteObjectCalls).toHaveLength(0);
      expect((await repository.findById(job.id))?.status).toBe(status);
    },
  );

  it('cancels a fresh PENDING job owned by the caller WITHOUT touching storage, even when an object already exists', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    // The upload actually reached storage (the browser finished the PUT) but the
    // user cancelled before the /complete confirmation call. A manual cancel can
    // happen while the presigned URL is still genuinely valid — deleting here could
    // race an in-flight PUT, so cleanup must be deferred to the background sweep
    // rather than acted on immediately (see reconcileStaleUploads and
    // findCancelledAwaitingStorageCleanup).
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const result = await service.cancel('user-1', job.id);

    expect(result.status).toBe('CANCELLED');
    const updated = await repository.findById(job.id);
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.errorCode).toBe('USER_CANCELLED');
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('cancels a PENDING job with nothing in storage yet, also without touching storage', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    // The browser never even started the PUT (closed the tab immediately).
    storage.headObjectResults.set(job.sourceObjectKey, null);

    const result = await service.cancel('user-1', job.id);

    expect(result.status).toBe('CANCELLED');
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('two concurrent cancel requests for the same job: only one succeeds, storage is never touched by either', async () => {
    const { repository, storage, service } = buildService();
    const job = await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/x.mp4',
      sourceFileName: 'video.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });

    const results = await Promise.allSettled([
      service.cancel('user-1', job.id),
      service.cancel('user-1', job.id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: 'UPLOAD_NOT_PENDING',
    });
    expect((await repository.findById(job.id))?.status).toBe('CANCELLED');
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });
});

describe('UploadsService.list', () => {
  it("only returns the requesting user's jobs and never includes sourceObjectKey", async () => {
    const { repository, service } = buildService();
    await repository.create({
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-1/mine.mp4',
      sourceFileName: 'mine.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 100n,
    });
    await repository.create({
      userId: 'user-2',
      sourceObjectKey: 'uploads/user-2/theirs.mp4',
      sourceFileName: 'theirs.mp4',
      sourceMimeType: 'video/mp4',
      sourceSizeBytes: 200n,
    });

    const files = await service.list('user-1');

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      fileName: 'mine.mp4',
      mimeType: 'video/mp4',
      sizeBytes: '100',
      status: 'PENDING',
    });
    expect(Object.keys(files[0]!)).not.toContain('sourceObjectKey');
  });
});

describe('UploadsService.delete', () => {
  const SAFE_CREATED_AT = new Date('2026-01-01T10:00:00.000Z'); // 2 h old: long past the 20 min window
  const RECENT_CREATED_AT = new Date('2026-01-01T11:55:00.000Z'); // 5 min old: presigned URL may be live

  function seed(
    repository: FakeJobsRepository,
    storage: FakeStorageService,
    overrides: Partial<JobRecord>,
    objectExists = true,
  ): JobRecord {
    const job = makeJob({ createdAt: SAFE_CREATED_AT, ...overrides });
    repository.jobs.set(job.id, job);
    storage.headObjectResults.set(job.sourceObjectKey, objectExists ? { sizeBytes: 100 } : null);
    return job;
  }

  it("deletes the owner's FAILED job: the row is gone and its source object is deleted", async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED', sourceObjectKey: 'uploads/user-1/f.mp4' });

    await expect(service.delete('user-1', 'job-f')).resolves.toBeUndefined();

    expect(repository.jobs.has('job-f')).toBe(false);
    expect(storage.deleteObjectCalls).toEqual(['uploads/user-1/f.mp4']);
  });

  it("deletes every object the job's cascaded records named (source, processed output, job inputs), each once", async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED', sourceObjectKey: 'uploads/user-1/f.mp4' });
    // The legacy source key also appears as the first JobInput's key (multi-input shape).
    repository.childObjectKeys.set('job-f', [
      'uploads/user-1/f.mp4',
      'uploads/user-1/second-input.png',
      'processed/user-1/out.mp4',
    ]);
    storage.headObjectResults.set('uploads/user-1/second-input.png', { sizeBytes: 1 });
    storage.headObjectResults.set('processed/user-1/out.mp4', { sizeBytes: 1 });

    await service.delete('user-1', 'job-f');

    expect([...storage.deleteObjectCalls].sort()).toEqual([
      'processed/user-1/out.mp4',
      'uploads/user-1/f.mp4',
      'uploads/user-1/second-input.png',
    ]);
  });

  it('deletes a CANCELLED job that the sweep cancelled (already cleaned), even though it is recent', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'job-c',
      status: 'CANCELLED',
      errorCode: 'UPLOAD_EXPIRED',
      createdAt: RECENT_CREATED_AT,
    });

    await expect(service.delete('user-1', 'job-c')).resolves.toBeUndefined();
    expect(repository.jobs.has('job-c')).toBe(false);
  });

  it('deletes a user-cancelled job whose storage cleanup the sweep already completed', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'job-c',
      status: 'CANCELLED',
      errorCode: 'USER_CANCELLED_CLEANED',
      createdAt: RECENT_CREATED_AT,
    });

    await expect(service.delete('user-1', 'job-c')).resolves.toBeUndefined();
    expect(repository.jobs.has('job-c')).toBe(false);
  });

  it('deletes a user-cancelled job once it is past the safe cutoff, cleaning its storage itself', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'job-c',
      status: 'CANCELLED',
      errorCode: 'USER_CANCELLED',
      sourceObjectKey: 'uploads/user-1/c.mp4',
    });

    await service.delete('user-1', 'job-c');

    expect(repository.jobs.has('job-c')).toBe(false);
    expect(storage.deleteObjectCalls).toEqual(['uploads/user-1/c.mp4']);
  });

  it('refuses (409 UPLOAD_CLEANUP_PENDING) a user-cancelled job inside the presigned-URL window, touching nothing', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'job-c',
      status: 'CANCELLED',
      errorCode: 'USER_CANCELLED',
      createdAt: RECENT_CREATED_AT,
    });

    await expect(service.delete('user-1', 'job-c')).rejects.toMatchObject({
      statusCode: 409,
      code: 'UPLOAD_CLEANUP_PENDING',
    });

    expect(repository.deleteFinishedCalls).toHaveLength(0);
    expect(repository.jobs.has('job-c')).toBe(true);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('uses the same boundary as the sweep: a job exactly at the cutoff is safe, one second younger is still pending', async () => {
    const { repository, storage, service } = buildService();
    // NOW is 12:00:00, so the cutoff is 11:40:00. The stale-upload sweep treats
    // createdAt <= cutoff as safe (see findStalePending), and delete must agree.
    seed(repository, storage, {
      id: 'at-cutoff',
      status: 'CANCELLED',
      errorCode: 'USER_CANCELLED',
      createdAt: new Date('2026-01-01T11:40:00.000Z'),
    });
    seed(repository, storage, {
      id: 'just-inside-window',
      status: 'CANCELLED',
      errorCode: 'USER_CANCELLED',
      createdAt: new Date('2026-01-01T11:40:01.000Z'),
    });

    await expect(service.delete('user-1', 'at-cutoff')).resolves.toBeUndefined();
    await expect(service.delete('user-1', 'just-inside-window')).rejects.toMatchObject({
      code: 'UPLOAD_CLEANUP_PENDING',
    });
  });

  it("returns the same 404 for a missing job and for another user's job, and never touches the other user's job or storage", async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'theirs',
      userId: 'user-2',
      status: 'FAILED',
      sourceObjectKey: 'uploads/user-2/theirs.mp4',
    });

    const missing = await service.delete('user-1', 'no-such-job').catch((error: unknown) => error);
    const foreign = await service.delete('user-1', 'theirs').catch((error: unknown) => error);

    expect(missing).toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND', message: 'Upload not found' });
    expect(foreign).toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND', message: 'Upload not found' });
    expect(repository.jobs.has('theirs')).toBe(true);
    expect(repository.deleteFinishedCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it.each(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED'] as const)(
    'refuses (409 JOB_NOT_DELETABLE) a %s job and deletes nothing',
    async (status) => {
      const { repository, storage, service } = buildService();
      seed(repository, storage, { id: 'job-x', status });

      await expect(service.delete('user-1', 'job-x')).rejects.toMatchObject({
        statusCode: 409,
        code: 'JOB_NOT_DELETABLE',
      });

      expect(repository.deleteFinishedCalls).toHaveLength(0);
      expect(repository.jobs.has('job-x')).toBe(true);
      expect(storage.deleteObjectCalls).toHaveLength(0);
    },
  );

  it('does not delete a job a concurrent Retry moved back to QUEUED between the read and the write (409, storage untouched)', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED' });
    repository.beforeDeleteFinished = (id) => {
      repository.jobs.set(id, { ...repository.jobs.get(id)!, status: 'QUEUED' });
    };

    await expect(service.delete('user-1', 'job-f')).rejects.toMatchObject({
      statusCode: 409,
      code: 'JOB_NOT_DELETABLE',
    });

    expect(repository.jobs.get('job-f')?.status).toBe('QUEUED');
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('answers 404 when a concurrent request already deleted the job, and a second delete is also 404', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED' });
    repository.beforeDeleteFinished = (id) => {
      repository.jobs.delete(id);
    };
    await expect(service.delete('user-1', 'job-f')).rejects.toMatchObject({ statusCode: 404 });

    repository.beforeDeleteFinished = undefined;
    await expect(service.delete('user-1', 'job-f')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('succeeds without calling deleteObject when the object is already missing from storage', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED' }, false);

    await expect(service.delete('user-1', 'job-f')).resolves.toBeUndefined();

    expect(repository.jobs.has('job-f')).toBe(false);
    expect(storage.headObjectCalls).toHaveLength(1);
    expect(storage.deleteObjectCalls).toHaveLength(0);
  });

  it('still succeeds, logging instead of throwing, when storage fails after the row was deleted', async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, { id: 'job-f', status: 'FAILED' });
    storage.headObject = async () => {
      throw new Error('storage unavailable');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(service.delete('user-1', 'job-f')).resolves.toBeUndefined();

    expect(repository.jobs.has('job-f')).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("never deletes an object outside the owner's own prefixes, whatever a record says", async () => {
    const { repository, storage, service } = buildService();
    seed(repository, storage, {
      id: 'job-f',
      status: 'FAILED',
      userId: 'user-1',
      sourceObjectKey: 'uploads/user-2/someone-elses.mp4',
    });
    repository.childObjectKeys.set('job-f', ['processed/user-2/theirs.mp4', 'uploads/user-1x/lookalike.mp4']);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await service.delete('user-1', 'job-f');

    expect(storage.deleteObjectCalls).toHaveLength(0);
    expect(storage.headObjectCalls).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(3);
    logged.mockRestore();
  });
});

describe('UploadsService.cleanup', () => {
  const SAFE_CREATED_AT = new Date('2026-01-01T10:00:00.000Z');
  const RECENT_CREATED_AT = new Date('2026-01-01T11:55:00.000Z');

  function seedMany(
    repository: FakeJobsRepository,
    storage: FakeStorageService,
    jobs: Array<Partial<JobRecord>>,
  ): void {
    for (const overrides of jobs) {
      const job = makeJob({ createdAt: SAFE_CREATED_AT, ...overrides });
      repository.jobs.set(job.id, job);
      storage.headObjectResults.set(job.sourceObjectKey, { sizeBytes: 100 });
    }
  }

  function everyStatusFixture() {
    const ctx = buildService();
    seedMany(ctx.repository, ctx.storage, [
      { id: 'failed-1', status: 'FAILED', sourceObjectKey: 'uploads/user-1/failed-1.mp4' },
      { id: 'failed-2', status: 'FAILED', sourceObjectKey: 'uploads/user-1/failed-2.mp4' },
      {
        id: 'cancelled-1',
        status: 'CANCELLED',
        errorCode: 'UPLOAD_EXPIRED',
        sourceObjectKey: 'uploads/user-1/cancelled-1.mp4',
      },
      { id: 'pending-1', status: 'PENDING', sourceObjectKey: 'uploads/user-1/pending-1.mp4' },
      { id: 'uploaded-1', status: 'UPLOADED', sourceObjectKey: 'uploads/user-1/uploaded-1.mp4' },
      { id: 'queued-1', status: 'QUEUED', sourceObjectKey: 'uploads/user-1/queued-1.mp4' },
      { id: 'processing-1', status: 'PROCESSING', sourceObjectKey: 'uploads/user-1/processing-1.mp4' },
      { id: 'completed-1', status: 'COMPLETED', sourceObjectKey: 'uploads/user-1/completed-1.mp4' },
      { id: 'theirs-failed', userId: 'user-2', status: 'FAILED', sourceObjectKey: 'uploads/user-2/tf.mp4' },
      { id: 'theirs-cancelled', userId: 'user-2', status: 'CANCELLED', sourceObjectKey: 'uploads/user-2/tc.mp4' },
    ]);
    return ctx;
  }

  it("deletes only the caller's FAILED and CANCELLED files, and reports the counts", async () => {
    const { repository, storage, service } = everyStatusFixture();

    const result = await service.cleanup('user-1', ['FAILED', 'CANCELLED']);

    expect(result).toEqual({ deleted: 3, skipped: 0, remaining: 0 });
    expect([...repository.jobs.keys()].sort()).toEqual([
      'completed-1',
      'pending-1',
      'processing-1',
      'queued-1',
      'theirs-cancelled',
      'theirs-failed',
      'uploaded-1',
    ]);
    expect([...storage.deleteObjectCalls].sort()).toEqual([
      'uploads/user-1/cancelled-1.mp4',
      'uploads/user-1/failed-1.mp4',
      'uploads/user-1/failed-2.mp4',
    ]);
  });

  it('with statuses ["FAILED"] leaves cancelled files alone', async () => {
    const { repository, service } = everyStatusFixture();

    const result = await service.cleanup('user-1', ['FAILED']);

    expect(result.deleted).toBe(2);
    expect(repository.jobs.has('cancelled-1')).toBe(true);
    expect(repository.jobs.has('failed-1')).toBe(false);
  });

  it('with statuses ["CANCELLED"] leaves failed files alone', async () => {
    const { repository, service } = everyStatusFixture();

    const result = await service.cleanup('user-1', ['CANCELLED']);

    expect(result.deleted).toBe(1);
    expect(repository.jobs.has('failed-1')).toBe(true);
    expect(repository.jobs.has('cancelled-1')).toBe(false);
  });

  it("never deletes completed, active or still-usable files, or anyone else's, even when asked for everything", async () => {
    const { repository, service } = everyStatusFixture();

    await service.cleanup('user-1', ['FAILED', 'CANCELLED']);

    for (const id of [
      'completed-1',
      'pending-1',
      'uploaded-1',
      'queued-1',
      'processing-1',
      'theirs-failed',
      'theirs-cancelled',
    ]) {
      expect(repository.jobs.has(id)).toBe(true);
    }
  });

  it('skips a just-cancelled upload whose presigned URL may still be live, and deletes the rest', async () => {
    const { repository, storage, service } = buildService();
    seedMany(repository, storage, [
      { id: 'failed-1', status: 'FAILED', sourceObjectKey: 'uploads/user-1/failed-1.mp4' },
      {
        id: 'fresh-cancel',
        status: 'CANCELLED',
        errorCode: 'USER_CANCELLED',
        createdAt: RECENT_CREATED_AT,
        sourceObjectKey: 'uploads/user-1/fresh.mp4',
      },
    ]);

    const result = await service.cleanup('user-1', ['FAILED', 'CANCELLED']);

    expect(result).toEqual({ deleted: 1, skipped: 1, remaining: 0 });
    expect(repository.jobs.has('fresh-cancel')).toBe(true);
    expect(storage.deleteObjectCalls).toEqual(['uploads/user-1/failed-1.mp4']);
  });

  it('skips (and does not delete) a file a concurrent Retry moved to QUEUED mid-cleanup', async () => {
    const { repository, storage, service } = buildService();
    seedMany(repository, storage, [
      { id: 'failed-1', status: 'FAILED', sourceObjectKey: 'uploads/user-1/failed-1.mp4' },
      { id: 'failed-2', status: 'FAILED', sourceObjectKey: 'uploads/user-1/failed-2.mp4' },
    ]);
    repository.beforeDeleteFinished = (id) => {
      if (id === 'failed-1') repository.jobs.set(id, { ...repository.jobs.get(id)!, status: 'QUEUED' });
    };

    const result = await service.cleanup('user-1', ['FAILED']);

    expect(result).toEqual({ deleted: 1, skipped: 1, remaining: 0 });
    expect(repository.jobs.get('failed-1')?.status).toBe('QUEUED');
    expect(storage.deleteObjectCalls).toEqual(['uploads/user-1/failed-2.mp4']);
  });

  it('processes at most CLEANUP_BATCH_LIMIT files per call and reports the rest as remaining', async () => {
    const { repository, storage, service } = buildService();
    seedMany(
      repository,
      storage,
      Array.from({ length: CLEANUP_BATCH_LIMIT + 5 }, (_unused, index) => ({
        id: `failed-${index}`,
        status: 'FAILED' as const,
        sourceObjectKey: `uploads/user-1/failed-${index}.mp4`,
      })),
    );

    const first = await service.cleanup('user-1', ['FAILED']);
    expect(first).toEqual({ deleted: CLEANUP_BATCH_LIMIT, skipped: 0, remaining: 5 });

    const second = await service.cleanup('user-1', ['FAILED']);
    expect(second).toEqual({ deleted: 5, skipped: 0, remaining: 0 });
    expect(repository.jobs.size).toBe(0);
  });

  it('does nothing, and calls no storage, when there is nothing to clean', async () => {
    const { storage, service } = buildService();

    await expect(service.cleanup('user-1', ['FAILED', 'CANCELLED'])).resolves.toEqual({
      deleted: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(storage.headObjectCalls).toHaveLength(0);
  });
});
