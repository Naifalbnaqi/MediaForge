import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { OutputsService } from '../src/application/jobs/outputs.service.js';
import { ProcessingService } from '../src/application/jobs/processing.service.js';
import { UploadsService } from '../src/application/jobs/uploads.service.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { JobRecord } from '../src/domain/jobs/jobs.types.js';
import type { ProcessedFilesRepository } from '../src/domain/processed-files/processed-files.repository.js';
import type { ProcessedFileRecord } from '../src/domain/processed-files/processed-files.types.js';
import { TokenService } from '../src/infrastructure/security/token-service.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { uploadsRoutes } from '../src/presentation/routes/uploads.routes.js';
import type { DownloadRequest, ObjectStorageService } from '../src/services/storage.service.js';
import type { JobQueue } from '../src/workers/job-queue.js';

const OUTPUT_KEY = 'processed/user-1/output.mp4';

const job: JobRecord = {
  id: 'job-1',
  status: 'COMPLETED',
  sourceObjectKey: 'uploads/user-1/source.mov',
  sourceFileName: 'holiday.mov',
  sourceMimeType: 'video/quicktime',
  sourceSizeBytes: 500n,
  operation: 'convert-to-mp4',
  options: {},
  progress: 100,
  processingAttempt: 1,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  completedAt: null,
  userId: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const output: ProcessedFileRecord = {
  id: 'output-1',
  jobId: 'job-1',
  objectKey: OUTPUT_KEY,
  fileName: 'holiday.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 250n,
  checksum: null,
  expiresAt: null,
  createdAt: new Date('2026-01-01T00:02:00.000Z'),
};

/** Minimal stand-ins: only the methods this route actually exercises do anything. */
const jobsRepository = {
  findById: async (id: string) => (id === job.id ? job : null),
} as unknown as JobsRepository;

const processedFilesRepository = {
  findByJobId: async (jobId: string) => (jobId === job.id ? [output] : []),
} as unknown as ProcessedFilesRepository;

// This file never exercises a multi-input (image-to-pdf) job — every job here has
// no JobInput rows, matching resolveJobInputs' own single-input fallback.
const jobInputsRepository = {
  findByJobId: async () => [],
} as unknown as JobInputsRepository;

const signedRequests: DownloadRequest[] = [];
const storage = {
  headObject: async () => ({ sizeBytes: 250 }),
  createDownloadUrl: async (request: DownloadRequest) => {
    signedRequests.push(request);
    return {
      url: `https://storage.test/${request.objectKey}?sig=abc`,
      expiresAt: new Date('2026-01-01T00:15:00.000Z'),
    };
  },
} as unknown as ObjectStorageService;

async function buildTestApp() {
  const tokenService = new TokenService('a'.repeat(32), 'b'.repeat(32), '15m', 30);
  const app = Fastify();
  // The route throws AppError; without the app's own error handler those would all
  // surface as generic 500s rather than their intended status codes.
  registerErrorHandler(app);
  await app.register(uploadsRoutes, {
    prefix: '/api/v1/uploads',
    uploadsService: new UploadsService(jobsRepository, jobInputsRepository, storage, 1024, {
      uploadUrlTtlSeconds: 900,
      pendingUploadGraceSeconds: 300,
    }),
    // This file never exercises /process — the exact limit doesn't matter, only
    // that ProcessingService's now-required constructor arguments are supplied.
    processingService: new ProcessingService(
      jobsRepository,
      jobInputsRepository,
      {} as unknown as JobQueue,
      100,
    ),
    outputsService: new OutputsService(jobsRepository, processedFilesRepository, storage),
    tokenService,
  });
  return { app, tokenService };
}

async function tokenFor(tokenService: TokenService, userId: string): Promise<string> {
  const pair = await tokenService.createPair(userId, `${userId}@example.test`, 'USER');
  return pair.accessToken;
}

describe('GET /api/v1/uploads/:id/output', () => {
  it('rejects an unauthenticated request with 401 and signs nothing', async () => {
    signedRequests.length = 0;
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/uploads/job-1/output' });

    expect(response.statusCode).toBe(401);
    expect(signedRequests).toHaveLength(0);
    await app.close();
  });

  it('rejects a malformed bearer token with 401 and signs nothing', async () => {
    signedRequests.length = 0;
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output',
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(signedRequests).toHaveLength(0);
    await app.close();
  });

  it('returns a signed URL for the owner and defaults to attachment', async () => {
    signedRequests.length = 0;
    const { app, tokenService } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'user-1')}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.jobId).toBe('job-1');
    expect(body.fileName).toBe('holiday.mp4');
    expect(body.disposition).toBe('attachment');
    expect(typeof body.url).toBe('string');
    // Storage internals never travel to the client.
    expect(Object.keys(body)).not.toContain('objectKey');
    await app.close();
  });

  it('honours ?disposition=inline for preview', async () => {
    signedRequests.length = 0;
    const { app, tokenService } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output?disposition=inline',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'user-1')}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().disposition).toBe('inline');
    expect(signedRequests[0]?.disposition).toBe('inline');
    await app.close();
  });

  it('rejects an invalid disposition value with 400 and signs nothing', async () => {
    signedRequests.length = 0;
    const { app, tokenService } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output?disposition=evil',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'user-1')}` },
    });

    expect(response.statusCode).toBe(400);
    expect(signedRequests).toHaveLength(0);
    await app.close();
  });

  it('sets Cache-Control: no-store on a body carrying a capability URL', async () => {
    const { app, tokenService } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'user-1')}` },
    });

    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('returns 409 through the route when the job is not COMPLETED', async () => {
    signedRequests.length = 0;
    const tokenService = new TokenService('a'.repeat(32), 'b'.repeat(32), '15m', 30);
    const app = Fastify();
    registerErrorHandler(app);
    const pendingJobs = {
      findById: async () => ({ ...job, status: 'PROCESSING' as const }),
    } as unknown as JobsRepository;
    await app.register(uploadsRoutes, {
      prefix: '/api/v1/uploads',
      uploadsService: new UploadsService(pendingJobs, jobInputsRepository, storage, 1024, {
        uploadUrlTtlSeconds: 900,
        pendingUploadGraceSeconds: 300,
      }),
      processingService: new ProcessingService(
        pendingJobs,
        jobInputsRepository,
        {} as unknown as JobQueue,
        100,
      ),
      outputsService: new OutputsService(pendingJobs, processedFilesRepository, storage),
      tokenService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'user-1')}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('JOB_NOT_COMPLETED');
    expect(signedRequests).toHaveLength(0);
    await app.close();
  });

  it('returns 404 (not 403) when an authenticated non-owner guesses the job id', async () => {
    signedRequests.length = 0;
    const { app, tokenService } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/uploads/job-1/output',
      headers: { authorization: `Bearer ${await tokenFor(tokenService, 'attacker')}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('JOB_NOT_FOUND');
    expect(signedRequests).toHaveLength(0);
    await app.close();
  });
});
