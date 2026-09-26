import { describe, expect, it } from 'vitest';
import { OutputsService } from '../src/application/jobs/outputs.service.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { CreateJobData, DeletedJob, JobRecord } from '../src/domain/jobs/jobs.types.js';
import type { ProcessedFilesRepository } from '../src/domain/processed-files/processed-files.repository.js';
import type {
  CreateProcessedFileData,
  ProcessedFileRecord,
} from '../src/domain/processed-files/processed-files.types.js';
import type {
  DownloadRequest,
  ObjectStorageService,
  UploadRequest,
} from '../src/services/storage.service.js';

const SOURCE_KEY = 'uploads/user-1/source-object.mov';
const OUTPUT_KEY = 'processed/user-1/output-object.mp4';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    status: 'COMPLETED',
    sourceObjectKey: SOURCE_KEY,
    sourceFileName: 'holiday.mov',
    sourceMimeType: 'video/quicktime',
    sourceSizeBytes: 500n,
    operation: 'convert-to-mp4',
    options: {},
    progress: 100,
    processingAttempt: 1,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date('2026-01-01T00:01:00.000Z'),
    completedAt: new Date('2026-01-01T00:02:00.000Z'),
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeOutput(overrides: Partial<ProcessedFileRecord> = {}): ProcessedFileRecord {
  return {
    id: 'output-1',
    jobId: 'job-1',
    objectKey: OUTPUT_KEY,
    fileName: 'holiday.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 250n,
    checksum: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:02:00.000Z'),
    ...overrides,
  };
}

class FakeJobsRepository implements JobsRepository {
  public jobs = new Map<string, JobRecord>();

  public async create(data: CreateJobData): Promise<JobRecord> {
    const job = makeJob({ ...data, status: 'PENDING' });
    this.jobs.set(job.id, job);
    return job;
  }
  public async markUploaded(id: string): Promise<JobRecord> {
    return this.mustGet(id);
  }
  public async findById(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }
  public async findManyByUser(userId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.userId === userId);
  }
  public async markQueued(id: string): Promise<JobRecord | null> {
    return this.mustGet(id);
  }
  public async markProcessing(id: string): Promise<JobRecord> {
    return this.mustGet(id);
  }
  public async markCompleted(id: string): Promise<JobRecord> {
    return this.mustGet(id);
  }
  public async markFailed(id: string): Promise<JobRecord> {
    return this.mustGet(id);
  }
  public async markRetried(id: string): Promise<JobRecord | null> {
    return this.mustGet(id);
  }
  public async findStalePending(): Promise<JobRecord[]> {
    return [];
  }
  public async markCancelled(id: string): Promise<JobRecord | null> {
    return this.mustGet(id);
  }
  public async findCancelledAwaitingStorageCleanup(): Promise<JobRecord[]> {
    return [];
  }
  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    return this.mustGet(id);
  }
  public async countActiveByUser(): Promise<number> {
    return 0;
  }

  public async deleteFinished(): Promise<DeletedJob | null> {
    throw new Error('deleteFinished is not exercised by this test file');
  }
  private mustGet(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`FakeJobsRepository: unknown job ${id}`);
    return job;
  }
}

class FakeProcessedFilesRepository implements ProcessedFilesRepository {
  public outputs: ProcessedFileRecord[] = [];

  public async create(data: CreateProcessedFileData): Promise<ProcessedFileRecord> {
    const record = makeOutput(data);
    this.outputs.push(record);
    return record;
  }
  public async findByJobId(jobId: string): Promise<ProcessedFileRecord[]> {
    return this.outputs.filter((output) => output.jobId === jobId);
  }
}

class FakeStorageService implements ObjectStorageService {
  public downloadRequests: DownloadRequest[] = [];
  public headObjectKeys: string[] = [];
  /** Keys the fake treats as present in storage. */
  public existingKeys = new Set<string>([OUTPUT_KEY, SOURCE_KEY]);
  public headObjectError: Error | null = null;
  private signCounter = 0;

  public async createUploadUrl(request: UploadRequest): Promise<{ url: string; expiresAt: Date }> {
    return { url: `https://storage.test/${request.objectKey}`, expiresAt: new Date() };
  }

  public async createDownloadUrl(
    request: DownloadRequest,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.downloadRequests.push(request);
    this.signCounter += 1;
    // Signature-like query suffix differs per call, standing in for a real presigned
    // URL so "a fresh URL was issued" is observable.
    return {
      url: `https://storage.test/${request.objectKey}?sig=${this.signCounter}`,
      expiresAt: new Date('2026-01-01T00:15:00.000Z'),
    };
  }

  public async deleteObject(): Promise<void> {}

  public async headObject(objectKey: string): Promise<{ sizeBytes: number } | null> {
    this.headObjectKeys.push(objectKey);
    if (this.headObjectError) throw this.headObjectError;
    return this.existingKeys.has(objectKey) ? { sizeBytes: 250 } : null;
  }

  public async downloadToFile(): Promise<void> {}
  public async uploadFromFile(): Promise<void> {}
  public async checkAccessible(): Promise<void> {}
}

function build() {
  const jobs = new FakeJobsRepository();
  const processedFiles = new FakeProcessedFilesRepository();
  const storage = new FakeStorageService();
  const service = new OutputsService(jobs, processedFiles, storage);
  return { jobs, processedFiles, storage, service };
}

/** Arranges the standard happy-path fixture: a completed, owned job with one output. */
function buildCompleted() {
  const context = build();
  context.jobs.jobs.set('job-1', makeJob());
  context.processedFiles.outputs.push(makeOutput());
  return context;
}

describe('OutputsService.getProcessedOutput', () => {
  it('returns a signed URL and the processed output metadata for the owner', async () => {
    const { service, storage } = buildCompleted();

    const result = await service.getProcessedOutput('user-1', 'job-1', 'attachment');

    expect(result.jobId).toBe('job-1');
    expect(result.url).toContain('https://storage.test/');
    expect(result.expiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(result.disposition).toBe('attachment');
    expect(storage.downloadRequests).toHaveLength(1);
  });

  it('describes the processed output, not the original upload', async () => {
    const { service, storage } = buildCompleted();

    const result = await service.getProcessedOutput('user-1', 'job-1', 'inline');

    // The job's source is holiday.mov / video/quicktime / 500 bytes; the response must
    // describe the produced artifact instead.
    expect(result.fileName).toBe('holiday.mp4');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.sizeBytes).toBe('250');
    // And the object actually signed is the processed key, never the source key.
    expect(storage.downloadRequests[0]?.objectKey).toBe(OUTPUT_KEY);
    expect(storage.downloadRequests[0]?.objectKey).not.toBe(SOURCE_KEY);
  });

  it('passes the requested disposition and output file name through to the signer', async () => {
    const { service, storage } = buildCompleted();

    await service.getProcessedOutput('user-1', 'job-1', 'inline');
    await service.getProcessedOutput('user-1', 'job-1', 'attachment');

    expect(storage.downloadRequests.map((request) => request.disposition)).toEqual([
      'inline',
      'attachment',
    ]);
    for (const request of storage.downloadRequests) {
      expect(request.fileName).toBe('holiday.mp4');
      expect(request.contentType).toBe('video/mp4');
    }
  });

  it('issues a newly signed URL on each call, so an expired one can be replaced', async () => {
    const { service } = buildCompleted();

    const first = await service.getProcessedOutput('user-1', 'job-1', 'inline');
    const second = await service.getProcessedOutput('user-1', 'job-1', 'inline');

    expect(first.url).not.toBe(second.url);
  });

  it('rejects another user with a 404 and signs nothing', async () => {
    const { service, storage } = buildCompleted();

    await expect(
      service.getProcessedOutput('someone-else', 'job-1', 'attachment'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });

    // The authorization requirement that matters: nothing was signed at all.
    expect(storage.downloadRequests).toHaveLength(0);
    expect(storage.headObjectKeys).toHaveLength(0);
  });

  it('rejects an unknown job id with the same 404 shape, signing nothing', async () => {
    const { service, storage } = buildCompleted();

    await expect(
      service.getProcessedOutput('user-1', 'no-such-job', 'attachment'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
    expect(storage.downloadRequests).toHaveLength(0);
  });

  it.each(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'FAILED', 'CANCELLED'] as const)(
    'rejects a job in %s state with 409 and signs nothing',
    async (status) => {
      const { service, storage, jobs, processedFiles } = build();
      jobs.jobs.set('job-1', makeJob({ status }));
      processedFiles.outputs.push(makeOutput());

      await expect(
        service.getProcessedOutput('user-1', 'job-1', 'attachment'),
      ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_NOT_COMPLETED' });
      expect(storage.downloadRequests).toHaveLength(0);
    },
  );

  it('rejects when the job is completed but no output metadata exists', async () => {
    const { service, storage, jobs } = build();
    jobs.jobs.set('job-1', makeJob());
    // No ProcessedFile row recorded.

    await expect(service.getProcessedOutput('user-1', 'job-1', 'attachment')).rejects.toMatchObject(
      {
        statusCode: 404,
        code: 'OUTPUT_NOT_AVAILABLE',
      },
    );
    expect(storage.downloadRequests).toHaveLength(0);
  });

  it('rejects when the output metadata exists but the object is gone from storage', async () => {
    const { service, storage } = buildCompleted();
    storage.existingKeys.delete(OUTPUT_KEY);

    await expect(service.getProcessedOutput('user-1', 'job-1', 'attachment')).rejects.toMatchObject(
      {
        statusCode: 404,
        code: 'OUTPUT_NOT_AVAILABLE',
      },
    );
    // Existence was checked, but no URL was handed out for a missing object.
    expect(storage.headObjectKeys).toEqual([OUTPUT_KEY]);
    expect(storage.downloadRequests).toHaveLength(0);
  });

  it('propagates a genuine storage failure rather than reporting it as "not available"', async () => {
    const { service, storage } = buildCompleted();
    storage.headObjectError = new Error('connection reset by peer');

    // Surfaces as a 500 through the global error handler — deliberately NOT mapped to
    // a 404, which would misreport an outage as a missing file.
    await expect(service.getProcessedOutput('user-1', 'job-1', 'attachment')).rejects.toThrow(
      'connection reset by peer',
    );
    expect(storage.downloadRequests).toHaveLength(0);
  });

  it('selects the most recent output when a job has more than one', async () => {
    const { service, storage, jobs, processedFiles } = build();
    jobs.jobs.set('job-1', makeJob());
    processedFiles.outputs.push(
      makeOutput({
        id: 'older',
        objectKey: 'processed/user-1/older.mp4',
        createdAt: new Date('2026-01-01T00:02:00.000Z'),
      }),
      makeOutput({
        id: 'newer',
        objectKey: 'processed/user-1/newer.mp4',
        createdAt: new Date('2026-01-01T00:09:00.000Z'),
      }),
    );
    storage.existingKeys.add('processed/user-1/newer.mp4');

    await service.getProcessedOutput('user-1', 'job-1', 'attachment');

    expect(storage.downloadRequests[0]?.objectKey).toBe('processed/user-1/newer.mp4');
  });
});
