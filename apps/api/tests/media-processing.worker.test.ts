import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  handleWorkerJobFailed,
  processMediaJob,
  type MediaProcessingWorkerDeps,
} from '../src/workers/media-processing.worker.js';
import { OPERATION_HANDLERS, lookupOperationHandler } from '../src/workers/operations/registry.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { CreateJobInputData, JobInputRecord } from '../src/domain/job-inputs/job-inputs.types.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { CreateJobData, DeletedJob, JobRecord } from '../src/domain/jobs/jobs.types.js';
import type { ProcessedFilesRepository } from '../src/domain/processed-files/processed-files.repository.js';
import type { DocumentConversionService } from '../src/services/document-conversion.service.js';
import type {
  CreateProcessedFileData,
  ProcessedFileRecord,
} from '../src/domain/processed-files/processed-files.types.js';
import type { CompressVideoQuality, ExtractMp3Quality, ResizeVideoOptions } from '@media/validation';
import {
  InvalidMediaError,
  MediaConversionError,
  type MediaProbeResult,
  type MediaService,
  type TrimRange,
} from '../src/services/media.service.js';
import type { ObjectStorageService } from '../src/services/storage.service.js';
import type { MediaJobMessage } from '../src/workers/job-queue.js';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    status: 'QUEUED',
    sourceObjectKey: 'uploads/user-1/source.mp4',
    sourceFileName: 'my clip.mov',
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

/**
 * `sharedCallOrder`, when given, is an optional cross-fake array every fake below
 * pushes into (in addition to its own always-present, fake-local tracking arrays) —
 * used only by the one test that needs to assert a single chronological ordering
 * across repository/storage/media calls. Every other test relies solely on each
 * fake's own local tracking, so it is never affected by another fake's activity.
 */

class FakeJobsRepository implements JobsRepository {
  public jobs = new Map<string, JobRecord>();
  public transitionCalls: string[] = [];
  public markFailedCalls: Array<{ id: string; errorCode: string; errorMessage: string }> = [];

  public constructor(private readonly sharedCallOrder?: string[]) {}

  public seed(job: JobRecord): void {
    this.jobs.set(job.id, job);
  }

  public async create(data: CreateJobData): Promise<JobRecord> {
    const job = makeJob({ ...data, status: 'PENDING' });
    this.jobs.set(job.id, job);
    return job;
  }

  public async markUploaded(id: string): Promise<JobRecord> {
    return this.update(id, { status: 'UPLOADED' });
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
    if (!job || job.status !== 'UPLOADED') return null;
    return this.update(id, {
      status: 'QUEUED',
      operation,
      options,
      processingAttempt: job.processingAttempt + 1,
    });
  }

  public async markProcessing(id: string): Promise<JobRecord> {
    this.transitionCalls.push('markProcessing');
    this.sharedCallOrder?.push('markProcessing');
    return this.update(id, { status: 'PROCESSING', startedAt: new Date() });
  }

  public async markCompleted(id: string): Promise<JobRecord> {
    this.transitionCalls.push('markCompleted');
    this.sharedCallOrder?.push('markCompleted');
    return this.update(id, { status: 'COMPLETED', completedAt: new Date(), progress: 100 });
  }

  public async markFailed(id: string, errorCode: string, errorMessage: string): Promise<JobRecord> {
    this.transitionCalls.push('markFailed');
    this.sharedCallOrder?.push('markFailed');
    this.markFailedCalls.push({ id, errorCode, errorMessage });
    return this.update(id, { status: 'FAILED', errorCode, errorMessage, completedAt: new Date() });
  }

  public async markRetried(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'FAILED') return null;
    return this.update(id, {
      status: 'QUEUED',
      errorCode: null,
      errorMessage: null,
      progress: 0,
      completedAt: null,
      processingAttempt: job.processingAttempt + 1,
    });
  }

  public async findStalePending(): Promise<JobRecord[]> {
    return [];
  }

  public async markCancelled(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'PENDING') return null;
    return this.update(id, { status: 'CANCELLED', errorCode, errorMessage, completedAt: new Date() });
  }

  public async findCancelledAwaitingStorageCleanup(): Promise<JobRecord[]> {
    return [];
  }

  public async markCancelledStorageCleaned(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'CANCELLED') return null;
    return job;
  }

  public async countActiveByUser(): Promise<number> {
    return 0;
  }

  public async deleteFinished(): Promise<DeletedJob | null> {
    throw new Error('deleteFinished is not exercised by this test file');
  }

  private update(id: string, patch: Partial<JobRecord>): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no such job: ${id}`);
    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }
}

/** Empty by default (every job's `findByJobId` returns `[]`), matching every job
 * in this file — `resolveJobInputs` then falls back to the job's legacy source
 * fields, exactly as it does for every real job today. */
class FakeJobInputsRepository implements JobInputsRepository {
  public rows = new Map<string, JobInputRecord[]>();
  public createCalls: CreateJobInputData[] = [];

  public async create(data: CreateJobInputData): Promise<JobInputRecord> {
    this.createCalls.push(data);
    const record: JobInputRecord = { id: `input-${this.createCalls.length}`, createdAt: new Date(), ...data };
    this.rows.set(data.jobId, [...(this.rows.get(data.jobId) ?? []), record]);
    return record;
  }

  public async findByJobId(jobId: string): Promise<JobInputRecord[]> {
    return this.rows.get(jobId) ?? [];
  }
}

class FakeProcessedFilesRepository implements ProcessedFilesRepository {
  public createCalls: CreateProcessedFileData[] = [];

  public constructor(private readonly sharedCallOrder?: string[]) {}

  public async create(data: CreateProcessedFileData): Promise<ProcessedFileRecord> {
    this.createCalls.push(data);
    this.sharedCallOrder?.push('processedFiles.create');
    return {
      id: 'processed-1',
      jobId: data.jobId,
      objectKey: data.objectKey,
      fileName: data.fileName,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      checksum: null,
      expiresAt: null,
      createdAt: new Date(),
    };
  }

  public async findByJobId(): Promise<ProcessedFileRecord[]> {
    return [];
  }
}

class FakeStorageService implements ObjectStorageService {
  public downloadCalls: Array<{ objectKey: string; destinationPath: string }> = [];
  public uploadCalls: Array<{ objectKey: string; sourcePath: string; contentType: string }> = [];
  public downloadImpl: (objectKey: string, destinationPath: string) => Promise<void> = async () => {};
  public uploadImpl: (objectKey: string, sourcePath: string, contentType: string) => Promise<void> =
    async () => {};

  public constructor(private readonly sharedCallOrder?: string[]) {}

  public async createUploadUrl(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('FakeStorageService.createUploadUrl: not used by the worker');
  }

  public async createDownloadUrl(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('FakeStorageService.createDownloadUrl: not used by the worker');
  }

  public async deleteObject(): Promise<void> {
    throw new Error('FakeStorageService.deleteObject: not used by the worker');
  }

  public async headObject(): Promise<{ sizeBytes: number } | null> {
    throw new Error('FakeStorageService.headObject: not used by the worker');
  }

  public async downloadToFile(objectKey: string, destinationPath: string): Promise<void> {
    this.downloadCalls.push({ objectKey, destinationPath });
    await this.downloadImpl(objectKey, destinationPath);
    // Only recorded once the (possibly throwing) implementation above succeeds, so a
    // transient download failure never shows up as a completed "download" step.
    this.sharedCallOrder?.push('download');
  }

  public async uploadFromFile(objectKey: string, sourcePath: string, contentType: string): Promise<void> {
    this.uploadCalls.push({ objectKey, sourcePath, contentType });
    await this.uploadImpl(objectKey, sourcePath, contentType);
    this.sharedCallOrder?.push('upload');
  }

  public async checkAccessible(): Promise<void> {}
}

const VIDEO_PROBE_RESULT: MediaProbeResult = {
  durationSeconds: 12.5,
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  streams: [{ codecType: 'video', codecName: 'h264' }],
};

class FakeMediaService implements MediaService {
  public probeCalls: string[] = [];
  public convertCalls: Array<{ inputPath: string; outputPath: string }> = [];
  public compressCalls: Array<{ inputPath: string; outputPath: string; quality: CompressVideoQuality }> = [];
  public resizeCalls: Array<{ inputPath: string; outputPath: string; options: ResizeVideoOptions }> = [];
  public extractMp3Calls: Array<{ inputPath: string; outputPath: string; quality: ExtractMp3Quality }> = [];
  public trimCalls: Array<{ inputPath: string; outputPath: string; range: TrimRange }> = [];
  public probeImpl: (inputPath: string) => Promise<MediaProbeResult> = async () => VIDEO_PROBE_RESULT;
  // Default: behave like a real conversion and actually write bytes to outputPath,
  // since the worker calls the real fs.stat() on it afterward.
  public convertImpl: (inputPath: string, outputPath: string) => Promise<void> = async (
    _inputPath,
    outputPath,
  ) => {
    await writeFile(outputPath, Buffer.from('fake-mp4-bytes'));
  };
  public compressImpl: (inputPath: string, outputPath: string, quality: CompressVideoQuality) => Promise<void> =
    async (_inputPath, outputPath) => {
      await writeFile(outputPath, Buffer.from('fake-compressed-mp4-bytes'));
    };
  public resizeImpl: (inputPath: string, outputPath: string, options: ResizeVideoOptions) => Promise<void> = async (
    _inputPath,
    outputPath,
  ) => {
    await writeFile(outputPath, Buffer.from('fake-resized-mp4-bytes'));
  };
  public extractMp3Impl: (inputPath: string, outputPath: string, quality: ExtractMp3Quality) => Promise<void> =
    async (_inputPath, outputPath) => {
      await writeFile(outputPath, Buffer.from('fake-mp3-bytes'));
    };
  public trimImpl: (inputPath: string, outputPath: string, range: TrimRange) => Promise<void> = async (
    _inputPath,
    outputPath,
  ) => {
    await writeFile(outputPath, Buffer.from('fake-trimmed-mp4-bytes'));
  };
  public convertImageToPngCalls: Array<{ inputPath: string; outputPath: string }> = [];
  public convertImageToPngImpl: (inputPath: string, outputPath: string) => Promise<void> = async (
    _inputPath,
    outputPath,
  ) => {
    await writeFile(outputPath, Buffer.from('fake-png-bytes'));
  };

  public constructor(private readonly sharedCallOrder?: string[]) {}

  public async probe(inputPath: string): Promise<MediaProbeResult> {
    this.probeCalls.push(inputPath);
    const result = await this.probeImpl(inputPath);
    this.sharedCallOrder?.push('probe');
    return result;
  }

  public async convertToMp4(inputPath: string, outputPath: string): Promise<void> {
    this.convertCalls.push({ inputPath, outputPath });
    await this.convertImpl(inputPath, outputPath);
    this.sharedCallOrder?.push('convert');
  }

  public async compressVideo(inputPath: string, outputPath: string, quality: CompressVideoQuality): Promise<void> {
    this.compressCalls.push({ inputPath, outputPath, quality });
    await this.compressImpl(inputPath, outputPath, quality);
    this.sharedCallOrder?.push('compress');
  }

  public async resizeVideo(inputPath: string, outputPath: string, options: ResizeVideoOptions): Promise<void> {
    this.resizeCalls.push({ inputPath, outputPath, options });
    await this.resizeImpl(inputPath, outputPath, options);
    this.sharedCallOrder?.push('resize');
  }

  public async extractMp3(inputPath: string, outputPath: string, quality: ExtractMp3Quality): Promise<void> {
    this.extractMp3Calls.push({ inputPath, outputPath, quality });
    await this.extractMp3Impl(inputPath, outputPath, quality);
    this.sharedCallOrder?.push('extractMp3');
  }

  public async trimVideo(inputPath: string, outputPath: string, range: TrimRange): Promise<void> {
    this.trimCalls.push({ inputPath, outputPath, range });
    await this.trimImpl(inputPath, outputPath, range);
    this.sharedCallOrder?.push('trim');
  }

  public async convertImageToPng(inputPath: string, outputPath: string): Promise<void> {
    this.convertImageToPngCalls.push({ inputPath, outputPath });
    await this.convertImageToPngImpl(inputPath, outputPath);
    this.sharedCallOrder?.push('convertImageToPng');
  }
}

/** Default: behave like a real conversion and write real-looking PDF bytes to
 * a deterministic `output.pdf` under `outputDir`, since the worker calls the
 * real fs.stat() on it afterward. */
class FakeDocumentConversionService implements DocumentConversionService {
  public convertToPdfCalls: Array<{ inputPath: string; outputDir: string }> = [];
  public convertToPdfImpl: (inputPath: string, outputDir: string) => Promise<string> = async (
    _inputPath,
    outputDir,
  ) => {
    const outputPath = path.join(outputDir, 'output.pdf');
    await writeFile(outputPath, Buffer.from('%PDF-1.7 fake-pdf-bytes'));
    return outputPath;
  };

  public constructor(private readonly sharedCallOrder?: string[]) {}

  public async convertToPdf(inputPath: string, outputDir: string): Promise<string> {
    this.convertToPdfCalls.push({ inputPath, outputDir });
    const result = await this.convertToPdfImpl(inputPath, outputDir);
    this.sharedCallOrder?.push('convertToPdf');
    return result;
  }
}

function buildDeps(sharedCallOrder?: string[]): {
  deps: MediaProcessingWorkerDeps;
  jobsRepository: FakeJobsRepository;
  jobInputsRepository: FakeJobInputsRepository;
  processedFilesRepository: FakeProcessedFilesRepository;
  storage: FakeStorageService;
  mediaService: FakeMediaService;
  documentConversionService: FakeDocumentConversionService;
} {
  const jobsRepository = new FakeJobsRepository(sharedCallOrder);
  const jobInputsRepository = new FakeJobInputsRepository();
  const processedFilesRepository = new FakeProcessedFilesRepository(sharedCallOrder);
  const storage = new FakeStorageService(sharedCallOrder);
  const mediaService = new FakeMediaService(sharedCallOrder);
  const documentConversionService = new FakeDocumentConversionService(sharedCallOrder);
  return {
    deps: {
      jobsRepository,
      jobInputsRepository,
      processedFilesRepository,
      storage,
      mediaService,
      documentConversionService,
    },
    jobsRepository,
    jobInputsRepository,
    processedFilesRepository,
    storage,
    mediaService,
    documentConversionService,
  };
}

describe('processMediaJob', () => {
  it.each(['PENDING', 'UPLOADED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'returns without calling anything when the job is %s (not QUEUED or PROCESSING)',
    async (status) => {
      const { deps, jobsRepository, storage, mediaService, processedFilesRepository } = buildDeps();
      const job = makeJob({ status });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(jobsRepository.transitionCalls).toEqual([]);
      expect(storage.downloadCalls).toHaveLength(0);
      expect(mediaService.probeCalls).toHaveLength(0);
      expect(processedFilesRepository.createCalls).toHaveLength(0);
    },
  );

  it('resumes a PROCESSING job (redelivered after an interrupted worker) instead of skipping it', async () => {
    const { deps, jobsRepository, storage, mediaService, processedFilesRepository } = buildDeps();
    // Simulates a job that was already picked up once — startedAt set, progress
    // untouched — and got redelivered because the worker that had it crashed before
    // finishing (or BullMQ's stalled-job detector reclaimed it after a normal stall).
    const job = makeJob({ status: 'PROCESSING', startedAt: new Date('2026-01-01T00:00:30.000Z') });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    // The pipeline actually runs to completion rather than being skipped, and
    // markProcessing is called again (re-stamping startedAt) before the rest proceeds.
    expect(jobsRepository.transitionCalls).toEqual(['markProcessing', 'markCompleted']);
    expect(mediaService.probeCalls).toHaveLength(1);
    expect(storage.uploadCalls).toHaveLength(1);
    expect(processedFilesRepository.createCalls).toHaveLength(1);
    expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
  });

  it('returns without calling anything when the referenced job does not exist', async () => {
    const { deps, jobsRepository, storage } = buildDeps();

    await processMediaJob(deps, { jobId: 'nonexistent', userId: 'user-1', attempt: 1 });

    expect(jobsRepository.transitionCalls).toEqual([]);
    expect(storage.downloadCalls).toHaveLength(0);
  });

  it('marks the job FAILED with a safe INVALID_MEDIA error when probing rejects, and does not re-throw', async () => {
    const { deps, jobsRepository, storage, mediaService, processedFilesRepository } = buildDeps();
    const job = makeJob();
    jobsRepository.seed(job);
    mediaService.probeImpl = async () => {
      // The real FfmpegMediaService.probe() always throws InvalidMediaError
      // specifically (see services/media.service.ts's documented contract) — the
      // handler relies on that exact type to classify this as permanent, so the
      // fake must honor it too, not a bare Error.
      throw new InvalidMediaError('ffprobe: moov atom not found (raw stderr detail that must never leak)');
    };

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

    expect(jobsRepository.markFailedCalls).toEqual([
      {
        id: job.id,
        errorCode: 'INVALID_MEDIA',
        errorMessage: 'The uploaded file could not be processed as a valid video.',
      },
    ]);
    expect((await jobsRepository.findById(job.id))?.status).toBe('FAILED');
    expect(storage.uploadCalls).toHaveLength(0);
    expect(processedFilesRepository.createCalls).toHaveLength(0);
    // The raw failure detail must never be persisted as the job's error message.
    expect(jobsRepository.markFailedCalls[0]?.errorMessage).not.toContain('moov atom');

    // Temp dir must be cleaned up even on this failure path.
    const probedPath = mediaService.probeCalls[0]!;
    await expect(stat(path.dirname(probedPath))).rejects.toThrow();
  });

  it('marks the job FAILED with a safe CONVERSION_FAILED error when conversion throws, and does not re-throw', async () => {
    const { deps, jobsRepository, storage, mediaService, processedFilesRepository } = buildDeps();
    const job = makeJob();
    jobsRepository.seed(job);
    mediaService.convertImpl = async () => {
      // Same reasoning as the probe test above: the real convertToMp4() always
      // throws MediaConversionError specifically.
      throw new MediaConversionError('ffmpeg: raw encoder failure detail that must never leak');
    };

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

    expect(jobsRepository.markFailedCalls).toEqual([
      {
        id: job.id,
        errorCode: 'CONVERSION_FAILED',
        errorMessage: 'The uploaded file could not be converted.',
      },
    ]);
    expect(storage.uploadCalls).toHaveLength(0);
    expect(processedFilesRepository.createCalls).toHaveLength(0);

    const convertedInputPath = mediaService.convertCalls[0]!.inputPath;
    await expect(stat(path.dirname(convertedInputPath))).rejects.toThrow();
  });

  it('re-throws (does not catch) a transient storage failure, so a real BullMQ retry would occur', async () => {
    const { deps, jobsRepository, storage, mediaService } = buildDeps();
    const job = makeJob();
    jobsRepository.seed(job);
    storage.downloadImpl = async () => {
      throw new Error('ECONNRESET: transient network blip talking to object storage');
    };

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).rejects.toThrow(
      /transient network blip/,
    );

    // markProcessing still happened (it runs before the temp dir/download step), but
    // this function must never itself call markFailed for a transient failure.
    expect(jobsRepository.transitionCalls).toEqual(['markProcessing']);
    expect(jobsRepository.markFailedCalls).toHaveLength(0);
    expect(mediaService.probeCalls).toHaveLength(0);

    // Temp dir is still cleaned up even though the error propagated.
    const destinationPath = storage.downloadCalls[0]!.destinationPath;
    await expect(stat(path.dirname(destinationPath))).rejects.toThrow();
  });

  it('runs the full success path in order and persists server-generated, content-authoritative data', async () => {
    const callOrder: string[] = [];
    const { deps, jobsRepository, storage, processedFilesRepository } = buildDeps(callOrder);
    const job = makeJob({ userId: 'user-42', sourceFileName: 'vacation clip.mov' });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(callOrder).toEqual([
      'markProcessing',
      'download',
      'probe',
      'convert',
      'upload',
      'processedFiles.create',
      'markCompleted',
    ]);

    // Object key is server-generated (processed/<userId>/<uuid>.mp4), never derived
    // from the client-supplied source file name.
    const uploadCall = storage.uploadCalls[0]!;
    expect(uploadCall.objectKey).toMatch(/^processed\/user-42\/[0-9a-f-]+\.mp4$/);
    expect(uploadCall.objectKey).not.toContain('vacation clip');
    expect(uploadCall.contentType).toBe('video/mp4');

    // mimeType persisted is always video/mp4 regardless of the source file's original
    // (client-declared) type (this job's sourceMimeType is video/quicktime).
    expect(processedFilesRepository.createCalls).toEqual([
      {
        jobId: job.id,
        objectKey: uploadCall.objectKey,
        fileName: 'vacation clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 14n, // byte length of FakeMediaService.convertImpl's fake payload
      },
    ]);

    expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');

    // Temp dir cleaned up after a successful run too.
    const sourcePath = storage.downloadCalls[0]!.destinationPath;
    await expect(stat(path.dirname(sourcePath))).rejects.toThrow();
  });

  it('runs the compress-video success path through the registry, calling MediaService.compressVideo with the requested quality', async () => {
    const callOrder: string[] = [];
    const { deps, jobsRepository, storage, processedFilesRepository, mediaService } = buildDeps(callOrder);
    const job = makeJob({
      userId: 'user-42',
      sourceFileName: 'vacation clip.mov',
      operation: 'compress-video',
      options: { quality: 'small' },
    });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(callOrder).toEqual([
      'markProcessing',
      'download',
      'probe',
      'compress',
      'upload',
      'processedFiles.create',
      'markCompleted',
    ]);
    expect(mediaService.compressCalls).toHaveLength(1);
    expect(mediaService.compressCalls[0]?.quality).toBe('small');
    // convertToMp4/resizeVideo must never be invoked for a compress-video job.
    expect(mediaService.convertCalls).toHaveLength(0);
    expect(mediaService.resizeCalls).toHaveLength(0);

    expect(processedFilesRepository.createCalls).toEqual([
      {
        jobId: job.id,
        objectKey: storage.uploadCalls[0]!.objectKey,
        fileName: 'vacation clip-compressed.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 25n, // byte length of FakeMediaService.compressImpl's fake payload
      },
    ]);
    expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
  });

  it('defaults compress-video to the balanced quality when options omits it', async () => {
    const { deps, jobsRepository, mediaService } = buildDeps();
    // Mirrors what the API persists when a client sends { operation: 'compress-video' }
    // with no options key at all — requestProcessingSchema defaults it to {}.
    const job = makeJob({ operation: 'compress-video', options: {} });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(mediaService.compressCalls[0]?.quality).toBe('balanced');
  });

  it('runs the resize-video success path through the registry, calling MediaService.resizeVideo with the requested dimensions', async () => {
    const callOrder: string[] = [];
    const { deps, jobsRepository, storage, processedFilesRepository, mediaService } = buildDeps(callOrder);
    const job = makeJob({
      userId: 'user-42',
      sourceFileName: 'vacation clip.mov',
      operation: 'resize-video',
      options: { width: 1280, height: 720 },
    });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(callOrder).toEqual([
      'markProcessing',
      'download',
      'probe',
      'resize',
      'upload',
      'processedFiles.create',
      'markCompleted',
    ]);
    expect(mediaService.resizeCalls).toEqual([
      {
        inputPath: mediaService.resizeCalls[0]!.inputPath,
        outputPath: mediaService.resizeCalls[0]!.outputPath,
        options: { width: 1280, height: 720 },
      },
    ]);
    expect(mediaService.convertCalls).toHaveLength(0);
    expect(mediaService.compressCalls).toHaveLength(0);

    expect(processedFilesRepository.createCalls).toEqual([
      {
        jobId: job.id,
        objectKey: storage.uploadCalls[0]!.objectKey,
        fileName: 'vacation clip-1280x720.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 22n, // byte length of FakeMediaService.resizeImpl's fake payload
      },
    ]);
    expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
  });

  it('marks a resize-video job FAILED with a safe INVALID_OPTIONS error when neither width nor height is persisted', async () => {
    const { deps, jobsRepository, storage } = buildDeps();
    // Simulates a corrupted/foreign row — the API itself can never produce this,
    // since resizeVideoOptionsSchema requires at least one dimension.
    const job = makeJob({ operation: 'resize-video', options: {} });
    jobsRepository.seed(job);

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

    expect(jobsRepository.markFailedCalls).toEqual([
      { id: job.id, errorCode: 'INVALID_OPTIONS', errorMessage: 'The requested processing options are invalid.' },
    ]);
    expect(storage.downloadCalls).toHaveLength(0);
  });

  it('runs the extract-mp3 success path through the registry, calling MediaService.extractMp3 with the requested quality', async () => {
    const callOrder: string[] = [];
    const { deps, jobsRepository, storage, processedFilesRepository, mediaService } = buildDeps(callOrder);
    // extract-mp3 requires an audio stream — override the default (video-only)
    // probe result for this test.
    mediaService.probeImpl = async () => ({
      streams: [
        { codecType: 'video', codecName: 'h264' },
        { codecType: 'audio', codecName: 'aac' },
      ],
    });
    const job = makeJob({
      userId: 'user-42',
      sourceFileName: 'vacation clip.mov',
      operation: 'extract-mp3',
      options: { quality: 'high' },
    });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(callOrder).toEqual([
      'markProcessing',
      'download',
      'probe',
      'extractMp3',
      'upload',
      'processedFiles.create',
      'markCompleted',
    ]);
    expect(mediaService.extractMp3Calls).toHaveLength(1);
    expect(mediaService.extractMp3Calls[0]?.quality).toBe('high');
    expect(mediaService.convertCalls).toHaveLength(0);
    expect(mediaService.compressCalls).toHaveLength(0);
    expect(mediaService.resizeCalls).toHaveLength(0);

    const uploadCall = storage.uploadCalls[0]!;
    expect(uploadCall.objectKey).toMatch(/^processed\/user-42\/[0-9a-f-]+\.mp3$/);
    expect(uploadCall.contentType).toBe('audio/mpeg');

    expect(processedFilesRepository.createCalls).toEqual([
      {
        jobId: job.id,
        objectKey: uploadCall.objectKey,
        fileName: 'vacation clip-audio.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 14n, // byte length of FakeMediaService.extractMp3Impl's fake payload
      },
    ]);
    expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
  });

  describe('extract-mp3 input/redelivery compatibility', () => {
    const withAudio = async () => ({
      streams: [
        { codecType: 'video', codecName: 'h264' },
        { codecType: 'audio', codecName: 'aac' },
      ],
    });

    it('legacy single-input fallback: downloads Job.sourceObjectKey when no JobInput rows exist', async () => {
      const { deps, jobsRepository, storage, mediaService } = buildDeps();
      mediaService.probeImpl = withAudio;
      const job = makeJob({ operation: 'extract-mp3', options: {}, sourceObjectKey: 'uploads/user-1/legacy-source.mp4' });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(storage.downloadCalls.map((call) => call.objectKey)).toEqual(['uploads/user-1/legacy-source.mp4']);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('JobInput compatibility: downloads the JobInput row (not the legacy source key) when one exists', async () => {
      const { deps, jobsRepository, jobInputsRepository, storage, mediaService } = buildDeps();
      mediaService.probeImpl = withAudio;
      const job = makeJob({ operation: 'extract-mp3', options: {}, sourceObjectKey: 'uploads/user-1/legacy-source.mp4' });
      jobsRepository.seed(job);
      await jobInputsRepository.create({
        jobId: job.id,
        objectKey: 'uploads/user-1/via-job-input.mp4',
        fileName: 'via input.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 100n,
        order: 0,
      });

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(storage.downloadCalls.map((call) => call.objectKey)).toEqual(['uploads/user-1/via-job-input.mp4']);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('a redelivered/retried attempt (status PROCESSING, attempt 2) still runs extract-mp3 to completion', async () => {
      const { deps, jobsRepository, processedFilesRepository, mediaService } = buildDeps();
      mediaService.probeImpl = withAudio;
      const job = makeJob({
        status: 'PROCESSING',
        processingAttempt: 2,
        operation: 'extract-mp3',
        options: { quality: 'small' },
        startedAt: new Date('2026-01-01T00:00:30.000Z'),
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 2 });

      expect(mediaService.extractMp3Calls[0]?.quality).toBe('small');
      expect(processedFilesRepository.createCalls[0]?.mimeType).toBe('audio/mpeg');
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('a no-audio failure is permanent: it does not re-throw, so BullMQ never retries it', async () => {
      const { deps, jobsRepository } = buildDeps();
      // default probe result has no audio stream
      const job = makeJob({ operation: 'extract-mp3', options: {} });
      jobsRepository.seed(job);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();
    });
  });

  it('defaults extract-mp3 to the balanced quality when options omits it', async () => {
    const { deps, jobsRepository, mediaService } = buildDeps();
    mediaService.probeImpl = async () => ({
      streams: [
        { codecType: 'video', codecName: 'h264' },
        { codecType: 'audio', codecName: 'aac' },
      ],
    });
    const job = makeJob({ operation: 'extract-mp3', options: {} });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(mediaService.extractMp3Calls[0]?.quality).toBe('balanced');
  });

  it('marks an extract-mp3 job FAILED with a dedicated NO_AUDIO_STREAM error — not a fake/empty MP3, and not the misleading generic "invalid video" message — when the source has no audio stream', async () => {
    const { deps, jobsRepository, storage, mediaService } = buildDeps();
    // Default VIDEO_PROBE_RESULT has a video stream but no audio stream —
    // exactly the case extract-mp3 must reject safely.
    const job = makeJob({ operation: 'extract-mp3', options: { quality: 'balanced' } });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(jobsRepository.markFailedCalls).toEqual([
      {
        id: job.id,
        errorCode: 'NO_AUDIO_STREAM',
        errorMessage: 'This video has no audio track, so there is no audio to extract.',
      },
    ]);
    expect(mediaService.extractMp3Calls).toHaveLength(0);
    expect(storage.uploadCalls).toHaveLength(0);
    expect((await jobsRepository.findById(job.id))?.status).toBe('FAILED');
  });

  describe('trim-video', () => {
    const TRIM_FAILURE = {
      errorCode: 'TRIM_RANGE_INVALID',
      errorMessage: 'The selected time range does not contain any video. Choose a start time within the video.',
    };

    it('runs the success path through the registry: probe the input, trim the resolved window, verify the output, then upload and record it', async () => {
      const callOrder: string[] = [];
      const { deps, jobsRepository, storage, processedFilesRepository, mediaService } = buildDeps(callOrder);
      const job = makeJob({
        userId: 'user-42',
        sourceFileName: 'vacation clip.mov',
        operation: 'trim-video',
        options: { start: 2, end: 8 },
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(callOrder).toEqual([
        'markProcessing',
        'download',
        'probe',
        'trim',
        'probe',
        'upload',
        'processedFiles.create',
        'markCompleted',
      ]);
      expect(mediaService.trimCalls).toHaveLength(1);
      expect(mediaService.trimCalls[0]?.range).toEqual({ startSeconds: 2, durationSeconds: 6 });
      expect(mediaService.convertCalls).toHaveLength(0);
      expect(mediaService.compressCalls).toHaveLength(0);
      expect(mediaService.resizeCalls).toHaveLength(0);
      expect(mediaService.extractMp3Calls).toHaveLength(0);

      const uploadCall = storage.uploadCalls[0]!;
      expect(uploadCall.objectKey).toMatch(/^processed\/user-42\/[0-9a-f-]+\.mp4$/);
      expect(uploadCall.contentType).toBe('video/mp4');
      expect(processedFilesRepository.createCalls).toEqual([
        {
          jobId: job.id,
          objectKey: uploadCall.objectKey,
          fileName: 'vacation clip-trimmed.mp4',
          mimeType: 'video/mp4',
          sizeBytes: BigInt(Buffer.byteLength('fake-trimmed-mp4-bytes')),
        },
      ]);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('accepts a start + duration request and passes the duration through unchanged', async () => {
      const { deps, jobsRepository, mediaService } = buildDeps();
      const job = makeJob({ operation: 'trim-video', options: { start: 1.5, duration: 4 } });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(mediaService.trimCalls[0]?.range).toEqual({ startSeconds: 1.5, durationSeconds: 4 });
    });

    it('clamps an end that runs past the source to the end of the video (source is 12.5 s)', async () => {
      const { deps, jobsRepository, mediaService } = buildDeps();
      const job = makeJob({ operation: 'trim-video', options: { start: 10, duration: 60 } });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(mediaService.trimCalls[0]?.range).toEqual({ startSeconds: 10, durationSeconds: 2.5 });
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('fails permanently with TRIM_RANGE_INVALID — no trim, no upload, no retry — when the start is at or past the end of the source', async () => {
      const { deps, jobsRepository, storage, mediaService } = buildDeps();
      const job = makeJob({ operation: 'trim-video', options: { start: 20, end: 30 } });
      jobsRepository.seed(job);

      // Resolves (never re-throws), so BullMQ never retries a deterministic failure.
      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

      expect(jobsRepository.markFailedCalls).toEqual([{ id: job.id, ...TRIM_FAILURE }]);
      expect(mediaService.trimCalls).toHaveLength(0);
      expect(storage.uploadCalls).toHaveLength(0);
      expect((await jobsRepository.findById(job.id))?.status).toBe('FAILED');
    });

    it('fails with TRIM_RANGE_INVALID — not COMPLETED, nothing uploaded — when FFmpeg exits cleanly but the output is not valid video', async () => {
      const { deps, jobsRepository, storage, processedFilesRepository, mediaService } = buildDeps();
      // First probe (the source) succeeds; the second (the trimmed output) is
      // rejected by the real probe as having no usable video.
      let probeCount = 0;
      mediaService.probeImpl = async () => {
        probeCount += 1;
        if (probeCount === 1) return VIDEO_PROBE_RESULT;
        throw new InvalidMediaError('The input file has no video stream');
      };
      const job = makeJob({ operation: 'trim-video', options: { start: 1, end: 5 } });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(jobsRepository.markFailedCalls).toEqual([{ id: job.id, ...TRIM_FAILURE }]);
      expect(storage.uploadCalls).toHaveLength(0);
      expect(processedFilesRepository.createCalls).toHaveLength(0);
    });

    it('a non-InvalidMediaError probe failure on the output is treated as transient: it propagates so BullMQ retries', async () => {
      const { deps, jobsRepository, mediaService } = buildDeps();
      let probeCount = 0;
      mediaService.probeImpl = async () => {
        probeCount += 1;
        if (probeCount === 1) return VIDEO_PROBE_RESULT;
        throw new Error('disk hiccup');
      };
      const job = makeJob({ operation: 'trim-video', options: { start: 1, end: 5 } });
      jobsRepository.seed(job);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).rejects.toThrow(
        'disk hiccup',
      );
      expect(jobsRepository.markFailedCalls).toHaveLength(0);
    });

    it('records a permanent CONVERSION_FAILED when FFmpeg itself fails while trimming', async () => {
      const { deps, jobsRepository, storage, mediaService } = buildDeps();
      mediaService.trimImpl = async () => {
        throw new MediaConversionError('ffmpeg failed to trim the input file');
      };
      const job = makeJob({ operation: 'trim-video', options: { start: 1, end: 5 } });
      jobsRepository.seed(job);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

      expect(jobsRepository.markFailedCalls).toEqual([
        { id: job.id, errorCode: 'CONVERSION_FAILED', errorMessage: 'The uploaded file could not be converted.' },
      ]);
      expect(storage.uploadCalls).toHaveLength(0);
    });

    it.each([
      ['a negative start', { start: -1, end: 5 }],
      ['an end before the start', { start: 5, end: 2 }],
      ['both end and duration', { start: 1, end: 5, duration: 4 }],
      ['no end or duration', { start: 1 }],
    ])('marks the job FAILED with INVALID_OPTIONS, before any download or trim, for %s', async (_label, options) => {
      const { deps, jobsRepository, storage, mediaService } = buildDeps();
      const job = makeJob({ operation: 'trim-video', options });
      jobsRepository.seed(job);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

      expect(jobsRepository.markFailedCalls).toEqual([
        { id: job.id, errorCode: 'INVALID_OPTIONS', errorMessage: 'The requested processing options are invalid.' },
      ]);
      expect(storage.downloadCalls).toHaveLength(0);
      expect(mediaService.trimCalls).toHaveLength(0);
    });

    it('a redelivered attempt (status PROCESSING, attempt 2) still runs trim-video to completion', async () => {
      const { deps, jobsRepository, processedFilesRepository, mediaService } = buildDeps();
      const job = makeJob({
        status: 'PROCESSING',
        processingAttempt: 2,
        operation: 'trim-video',
        options: { start: 0, duration: 3 },
        startedAt: new Date('2026-01-01T00:00:30.000Z'),
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 2 });

      expect(mediaService.trimCalls[0]?.range).toEqual({ startSeconds: 0, durationSeconds: 3 });
      expect(processedFilesRepository.createCalls[0]?.mimeType).toBe('video/mp4');
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });
  });

  describe('image-to-pdf', () => {
    /** Real, tiny, valid 1x1 pixel fixtures (generated via `sharp`, verified to
     * embed successfully via `pdf-lib`) — this operation's handler reads and
     * decodes real bytes directly (unlike the video handlers, which only ever
     * hand paths to the fully-faked MediaService), so the fake storage's
     * `downloadImpl` must write real, embeddable image bytes to disk. */
    const JPEG_1X1 = Buffer.from(
      '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
      'base64',
    );
    const PNG_1X1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
      'base64',
    );
    const CORRUPT_JPEG = Buffer.from(
      '/9j/2wBDAAYEBQYFBAYGBQYHBwZub3QgYSByZWFsIGpwZWcgYm9keSBhdCBhbGwsIGp1c3QgZ2FyYmFnZSBieXRlcw==',
      'base64',
    );

    /** Maps a JobInput's `objectKey` to the real bytes `downloadToFile` should
     * write for it — set up by each test before seeding JobInput rows. */
    function withFixtureDownloads(storage: FakeStorageService, bytesByKey: Record<string, Buffer>) {
      storage.downloadImpl = async (objectKey, destinationPath) => {
        const bytes = bytesByKey[objectKey];
        if (!bytes) throw new Error(`no fixture configured for ${objectKey}`);
        await writeFile(destinationPath, bytes);
      };
    }

    async function seedImageToPdfJob(
      jobsRepository: FakeJobsRepository,
      jobInputsRepository: FakeJobInputsRepository,
      images: Array<{ objectKey: string; fileName: string; mimeType: string; sizeBytes: bigint }>,
    ): Promise<JobRecord> {
      const [first] = images;
      const job = makeJob({
        operation: 'image-to-pdf',
        options: {},
        sourceObjectKey: first!.objectKey,
        sourceFileName: first!.fileName,
        sourceMimeType: first!.mimeType,
        sourceSizeBytes: first!.sizeBytes,
      });
      jobsRepository.seed(job);
      for (const [order, image] of images.entries()) {
        await jobInputsRepository.create({ jobId: job.id, order, ...image });
      }
      return job;
    }

    it('runs the success path: downloads every JobInput in order, produces one PDF, uploads and records it', async () => {
      const callOrder: string[] = [];
      const { deps, jobsRepository, jobInputsRepository, storage, processedFilesRepository } =
        buildDeps(callOrder);
      withFixtureDownloads(storage, {
        'uploads/user-1/a.jpg': JPEG_1X1,
        'uploads/user-1/b.png': PNG_1X1,
      });
      const job = await seedImageToPdfJob(jobsRepository, jobInputsRepository, [
        { objectKey: 'uploads/user-1/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100n },
        { objectKey: 'uploads/user-1/b.png', fileName: 'b.png', mimeType: 'image/png', sizeBytes: 200n },
      ]);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(storage.downloadCalls.map((c) => c.objectKey)).toEqual([
        'uploads/user-1/a.jpg',
        'uploads/user-1/b.png',
      ]);
      expect(callOrder).toEqual(['markProcessing', 'download', 'download', 'upload', 'processedFiles.create', 'markCompleted']);

      const uploadCall = storage.uploadCalls[0]!;
      expect(uploadCall.objectKey).toMatch(/^processed\/user-1\/[0-9a-f-]+\.pdf$/);
      expect(uploadCall.contentType).toBe('application/pdf');
      expect(processedFilesRepository.createCalls).toEqual([
        {
          jobId: job.id,
          objectKey: uploadCall.objectKey,
          fileName: 'images.pdf',
          mimeType: 'application/pdf',
          sizeBytes: expect.any(BigInt),
        },
      ]);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('downloads and embeds inputs in JobInput.order, not insertion order', async () => {
      const { deps, jobsRepository, jobInputsRepository, storage } = buildDeps();
      withFixtureDownloads(storage, {
        'uploads/user-1/second.png': PNG_1X1,
        'uploads/user-1/first.jpg': JPEG_1X1,
      });
      const job = makeJob({ operation: 'image-to-pdf', options: {}, sourceObjectKey: 'uploads/user-1/first.jpg' });
      jobsRepository.seed(job);
      // Created out of order; `order` is what must be honored, not call sequence.
      await jobInputsRepository.create({
        jobId: job.id,
        order: 1,
        objectKey: 'uploads/user-1/second.png',
        fileName: 'second.png',
        mimeType: 'image/png',
        sizeBytes: 200n,
      });
      await jobInputsRepository.create({
        jobId: job.id,
        order: 0,
        objectKey: 'uploads/user-1/first.jpg',
        fileName: 'first.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100n,
      });

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(storage.downloadCalls.map((c) => c.objectKey)).toEqual([
        'uploads/user-1/first.jpg',
        'uploads/user-1/second.png',
      ]);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('converts a WebP input via MediaService.convertImageToPng before embedding it', async () => {
      const { deps, jobsRepository, jobInputsRepository, storage, mediaService } = buildDeps();
      withFixtureDownloads(storage, { 'uploads/user-1/photo.webp': Buffer.from('fake-webp-bytes') });
      mediaService.convertImageToPngImpl = async (_inputPath, outputPath) => {
        await writeFile(outputPath, PNG_1X1);
      };
      const job = await seedImageToPdfJob(jobsRepository, jobInputsRepository, [
        { objectKey: 'uploads/user-1/photo.webp', fileName: 'photo.webp', mimeType: 'image/webp', sizeBytes: 68n },
      ]);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(mediaService.convertImageToPngCalls).toHaveLength(1);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('fails permanently with INVALID_IMAGE — never COMPLETED, nothing uploaded — when one input is not a valid image', async () => {
      const { deps, jobsRepository, jobInputsRepository, storage } = buildDeps();
      withFixtureDownloads(storage, {
        'uploads/user-1/good.jpg': JPEG_1X1,
        'uploads/user-1/bad.jpg': CORRUPT_JPEG,
      });
      const job = await seedImageToPdfJob(jobsRepository, jobInputsRepository, [
        { objectKey: 'uploads/user-1/good.jpg', fileName: 'good.jpg', mimeType: 'image/jpeg', sizeBytes: 100n },
        { objectKey: 'uploads/user-1/bad.jpg', fileName: 'bad.jpg', mimeType: 'image/jpeg', sizeBytes: 100n },
      ]);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

      expect(jobsRepository.markFailedCalls).toEqual([
        {
          id: job.id,
          errorCode: 'INVALID_IMAGE',
          errorMessage: 'One of the images could not be used. Remove or replace it and try again.',
        },
      ]);
      expect(storage.uploadCalls).toHaveLength(0);
      expect((await jobsRepository.findById(job.id))?.status).toBe('FAILED');
    });

    it('a redelivered attempt (status PROCESSING, attempt 2) still runs image-to-pdf to completion', async () => {
      const { deps, jobsRepository, jobInputsRepository, storage, processedFilesRepository } = buildDeps();
      withFixtureDownloads(storage, { 'uploads/user-1/a.jpg': JPEG_1X1 });
      const job = await seedImageToPdfJob(jobsRepository, jobInputsRepository, [
        { objectKey: 'uploads/user-1/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100n },
      ]);
      jobsRepository.seed({ ...job, status: 'PROCESSING', processingAttempt: 2 });

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 2 });

      expect(processedFilesRepository.createCalls[0]?.mimeType).toBe('application/pdf');
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });
  });

  describe('document-to-pdf', () => {
    it('runs the success path: copies the input with the correct extension, converts it, uploads and records the PDF', async () => {
      const callOrder: string[] = [];
      const { deps, jobsRepository, storage, processedFilesRepository, documentConversionService } =
        buildDeps(callOrder);
      storage.downloadImpl = async (_objectKey, destinationPath) => {
        await writeFile(destinationPath, Buffer.from('fake source document bytes'));
      };
      const job = makeJob({
        userId: 'user-7',
        sourceFileName: 'report.docx',
        sourceMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        operation: 'document-to-pdf',
        options: {},
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(callOrder).toEqual([
        'markProcessing',
        'download',
        'convertToPdf',
        'upload',
        'processedFiles.create',
        'markCompleted',
      ]);
      expect(documentConversionService.convertToPdfCalls).toHaveLength(1);
      expect(documentConversionService.convertToPdfCalls[0]?.inputPath).toMatch(/input\.docx$/);

      const uploadCall = storage.uploadCalls[0]!;
      expect(uploadCall.objectKey).toMatch(/^processed\/user-7\/[0-9a-f-]+\.pdf$/);
      expect(uploadCall.contentType).toBe('application/pdf');
      expect(processedFilesRepository.createCalls).toEqual([
        {
          jobId: job.id,
          objectKey: uploadCall.objectKey,
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: BigInt(Buffer.byteLength('%PDF-1.7 fake-pdf-bytes')),
        },
      ]);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it.each([
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx', '.pptx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'numbers.xlsx', '.xlsx'],
      ['application/vnd.oasis.opendocument.text', 'notes.odt', '.odt'],
      ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods', '.ods'],
      ['application/vnd.oasis.opendocument.presentation', 'deck.odp', '.odp'],
      ['application/rtf', 'letter.rtf', '.rtf'],
      ['text/plain', 'readme.txt', '.txt'],
      ['application/msword', 'legacy.doc', '.doc'],
      ['application/vnd.ms-powerpoint', 'legacy.ppt', '.ppt'],
      ['application/vnd.ms-excel', 'legacy.xls', '.xls'],
    ])('copies a %s input to a path ending in %s before conversion', async (mimeType, fileName, expectedExt) => {
      const { deps, jobsRepository, storage, documentConversionService } = buildDeps();
      storage.downloadImpl = async (_objectKey, destinationPath) => {
        await writeFile(destinationPath, Buffer.from('fake source document bytes'));
      };
      const job = makeJob({
        sourceFileName: fileName,
        sourceMimeType: mimeType,
        operation: 'document-to-pdf',
        options: {},
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

      expect(documentConversionService.convertToPdfCalls[0]?.inputPath.endsWith(expectedExt)).toBe(true);
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });

    it('fails permanently with INVALID_DOCUMENT — never COMPLETED, nothing uploaded — when conversion produces no usable PDF', async () => {
      const { deps, jobsRepository, storage, documentConversionService } = buildDeps();
      const { InvalidDocumentError } = await import('../src/services/document-conversion.service.js');
      storage.downloadImpl = async (_objectKey, destinationPath) => {
        await writeFile(destinationPath, Buffer.from('fake corrupt document bytes'));
      };
      documentConversionService.convertToPdfImpl = async () => {
        throw new InvalidDocumentError('LibreOffice produced no output file');
      };
      const job = makeJob({
        sourceFileName: 'corrupt.docx',
        sourceMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        operation: 'document-to-pdf',
        options: {},
      });
      jobsRepository.seed(job);

      await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

      expect(jobsRepository.markFailedCalls).toEqual([
        {
          id: job.id,
          errorCode: 'INVALID_DOCUMENT',
          errorMessage: 'This document could not be converted to PDF. Check that it opens correctly and try again.',
        },
      ]);
      expect(storage.uploadCalls).toHaveLength(0);
      expect((await jobsRepository.findById(job.id))?.status).toBe('FAILED');
    });

    it('a redelivered attempt (status PROCESSING, attempt 2) still runs document-to-pdf to completion', async () => {
      const { deps, jobsRepository, storage, processedFilesRepository } = buildDeps();
      storage.downloadImpl = async (_objectKey, destinationPath) => {
        await writeFile(destinationPath, Buffer.from('fake source document bytes'));
      };
      const job = makeJob({
        status: 'PROCESSING',
        processingAttempt: 2,
        sourceFileName: 'report.docx',
        sourceMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        operation: 'document-to-pdf',
        options: {},
        startedAt: new Date('2026-01-01T00:00:30.000Z'),
      });
      jobsRepository.seed(job);

      await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 2 });

      expect(processedFilesRepository.createCalls[0]?.mimeType).toBe('application/pdf');
      expect((await jobsRepository.findById(job.id))?.status).toBe('COMPLETED');
    });
  });

  it('never constructs or depends on a shell command string — fakes only ever receive structured paths/keys', async () => {
    const { deps, jobsRepository, storage, mediaService } = buildDeps();
    const job = makeJob();
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    for (const call of storage.downloadCalls) {
      expect(call.destinationPath).not.toMatch(/[|;&`$]/);
    }
    for (const call of storage.uploadCalls) {
      expect(call.sourcePath).not.toMatch(/[|;&`$]/);
    }
    for (const call of mediaService.convertCalls) {
      expect(call.inputPath).not.toMatch(/[|;&`$]/);
      expect(call.outputPath).not.toMatch(/[|;&`$]/);
    }
  });

  it('marks the job FAILED with a safe UNSUPPORTED_OPERATION error for an operation the registry has no handler for, without ever calling markProcessing or touching storage', async () => {
    const { deps, jobsRepository, storage } = buildDeps();
    const job = makeJob({ operation: 'some-future-operation-not-yet-registered' });
    jobsRepository.seed(job);

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

    expect(jobsRepository.markFailedCalls).toEqual([
      { id: job.id, errorCode: 'UNSUPPORTED_OPERATION', errorMessage: 'This processing operation is not supported.' },
    ]);
    // Validated and rejected *before* ever stamping PROCESSING or touching storage
    // — a pre-flight failure, not a real processing attempt.
    expect(jobsRepository.transitionCalls).toEqual(['markFailed']);
    expect(storage.downloadCalls).toHaveLength(0);
  });

  it('marks the job FAILED with a safe UNSUPPORTED_OPERATION error when operation is null', async () => {
    const { deps, jobsRepository } = buildDeps();
    const job = makeJob({ operation: null });
    jobsRepository.seed(job);

    await processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 });

    expect(jobsRepository.markFailedCalls).toEqual([
      { id: job.id, errorCode: 'UNSUPPORTED_OPERATION', errorMessage: 'This processing operation is not supported.' },
    ]);
  });

  it('marks the job FAILED with a safe INVALID_OPTIONS error when persisted options fail re-validation, without ever calling markProcessing', async () => {
    const { deps, jobsRepository, storage } = buildDeps();
    // convert-to-mp4's options schema is z.strictObject({}) — any key at all is
    // invalid. Simulates a corrupted/foreign row rather than anything the API's
    // own validation could ever produce today.
    const job = makeJob({ operation: 'convert-to-mp4', options: { quality: 'ultra' } });
    jobsRepository.seed(job);

    await expect(processMediaJob(deps, { jobId: job.id, userId: job.userId, attempt: 1 })).resolves.toBeUndefined();

    expect(jobsRepository.markFailedCalls).toEqual([
      { id: job.id, errorCode: 'INVALID_OPTIONS', errorMessage: 'The requested processing options are invalid.' },
    ]);
    expect(jobsRepository.transitionCalls).toEqual(['markFailed']);
    expect(storage.downloadCalls).toHaveLength(0);
  });
});

describe('operation handler registry', () => {
  it('contains exactly the seven operations after Documents to PDF', () => {
    expect(Object.keys(OPERATION_HANDLERS).sort()).toEqual(
      [
        'compress-video',
        'convert-to-mp4',
        'document-to-pdf',
        'extract-mp3',
        'image-to-pdf',
        'resize-video',
        'trim-video',
      ].sort(),
    );
  });

  it.each([
    'convert-to-mp4',
    'compress-video',
    'resize-video',
    'extract-mp3',
    'trim-video',
    'image-to-pdf',
    'document-to-pdf',
  ] as const)('lookupOperationHandler resolves the registered %s handler', (operation) => {
    expect(lookupOperationHandler(operation)).toBe(OPERATION_HANDLERS[operation]);
  });

  it.each([null, '', 'mute-video', 'not-a-real-operation'])(
    'lookupOperationHandler returns undefined for %s',
    (operation) => {
      expect(lookupOperationHandler(operation)).toBeUndefined();
    },
  );
});

describe('handleWorkerJobFailed', () => {
  function makeBullJob(overrides: {
    jobId: string;
    userId: string;
    attemptsMade: number;
    attempts?: number;
    attempt?: number;
  }): Job<MediaJobMessage> {
    return {
      data: { jobId: overrides.jobId, userId: overrides.userId, attempt: overrides.attempt ?? 1 },
      attemptsMade: overrides.attemptsMade,
      opts: { attempts: overrides.attempts },
    } as unknown as Job<MediaJobMessage>;
  }

  it('does nothing when the job has retries remaining (BullMQ will retry automatically)', async () => {
    const jobsRepository = new FakeJobsRepository();
    const job = makeBullJob({ jobId: 'job-1', userId: 'user-1', attemptsMade: 1, attempts: 3 });

    await handleWorkerJobFailed(jobsRepository, job, new Error('transient blip'));

    expect(jobsRepository.markFailedCalls).toHaveLength(0);
  });

  it('marks the job FAILED once attemptsMade reaches the configured attempts limit', async () => {
    const jobsRepository = new FakeJobsRepository();
    jobsRepository.seed(makeJob({ id: 'job-1', status: 'PROCESSING' }));
    const job = makeBullJob({ jobId: 'job-1', userId: 'user-1', attemptsMade: 3, attempts: 3 });

    await handleWorkerJobFailed(jobsRepository, job, new Error('transient blip, retries exhausted'));

    expect(jobsRepository.markFailedCalls).toEqual([
      {
        id: 'job-1',
        errorCode: 'PROCESSING_FAILED',
        errorMessage:
          'Processing could not be completed due to a temporary system error. Please try again.',
      },
    ]);
  });

  it('marks the job FAILED on an UnrecoverableError regardless of attemptsMade (stalled-job limit exceeded)', async () => {
    const jobsRepository = new FakeJobsRepository();
    jobsRepository.seed(makeJob({ id: 'job-1', status: 'PROCESSING' }));
    // BullMQ never re-invokes the processor for this delivery — it detects the job's
    // deferred failure and fails it directly with attemptsMade still well under the
    // configured attempts limit, so the exhaustion check alone would miss this case.
    const job = makeBullJob({ jobId: 'job-1', userId: 'user-1', attemptsMade: 1, attempts: 3 });

    await handleWorkerJobFailed(
      jobsRepository,
      job,
      new UnrecoverableError('job stalled more than allowable limit'),
    );

    expect(jobsRepository.markFailedCalls).toEqual([
      {
        id: 'job-1',
        errorCode: 'PROCESSING_FAILED',
        errorMessage:
          'Processing could not be completed due to a temporary system error. Please try again.',
      },
    ]);
  });

  it('does not overwrite a job that has already reached a terminal status', async () => {
    const jobsRepository = new FakeJobsRepository();
    jobsRepository.seed(makeJob({ id: 'job-1', status: 'COMPLETED' }));
    const job = makeBullJob({ jobId: 'job-1', userId: 'user-1', attemptsMade: 3, attempts: 3 });

    await handleWorkerJobFailed(jobsRepository, job, new Error('late failure event, already done'));

    expect(jobsRepository.markFailedCalls).toHaveLength(0);
    expect((await jobsRepository.findById('job-1'))?.status).toBe('COMPLETED');
  });

  it('does nothing (and does not throw) when BullMQ reports no job attached to the failure', async () => {
    const jobsRepository = new FakeJobsRepository();

    await expect(
      handleWorkerJobFailed(jobsRepository, undefined, new Error('stalled')),
    ).resolves.toBeUndefined();
    expect(jobsRepository.markFailedCalls).toHaveLength(0);
  });
});
