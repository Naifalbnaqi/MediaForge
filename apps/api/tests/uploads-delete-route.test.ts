import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { OutputsService } from '../src/application/jobs/outputs.service.js';
import { ProcessingService } from '../src/application/jobs/processing.service.js';
import { UploadsService } from '../src/application/jobs/uploads.service.js';
import type { JobInputsRepository } from '../src/domain/job-inputs/job-inputs.repository.js';
import type { JobsRepository } from '../src/domain/jobs/jobs.repository.js';
import type { DeletedJob, JobRecord } from '../src/domain/jobs/jobs.types.js';
import type { ProcessedFilesRepository } from '../src/domain/processed-files/processed-files.repository.js';
import { TokenService } from '../src/infrastructure/security/token-service.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { uploadsRoutes } from '../src/presentation/routes/uploads.routes.js';
import type { ObjectStorageService } from '../src/services/storage.service.js';
import type { JobQueue } from '../src/workers/job-queue.js';

/**
 * HTTP-level checks for `DELETE /:id` and `POST /cleanup`: the wire contract (auth,
 * status codes, error shape, body validation). The deletion rules themselves are
 * covered exhaustively against `UploadsService` in `uploads.service.test.ts`; this
 * file only proves the routes expose them faithfully.
 */

function makeJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    status: 'FAILED',
    sourceObjectKey: 'uploads/user-1/source.mp4',
    sourceFileName: 'holiday.mp4',
    sourceMimeType: 'video/mp4',
    sourceSizeBytes: 500n,
    operation: 'convert-to-mp4',
    options: {},
    progress: 0,
    processingAttempt: 1,
    errorCode: 'CONVERSION_FAILED',
    errorMessage: 'The uploaded file could not be converted.',
    startedAt: null,
    completedAt: null,
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildTestApp(initialJobs: JobRecord[]) {
  const jobs = new Map(initialJobs.map((job) => [job.id, job]));
  const deletedObjectKeys: string[] = [];

  const jobsRepository = {
    findById: async (id: string) => jobs.get(id) ?? null,
    findManyByUser: async (userId: string) =>
      [...jobs.values()].filter((job) => job.userId === userId),
    deleteFinished: async (id: string, userId: string): Promise<DeletedJob | null> => {
      const job = jobs.get(id);
      if (!job || job.userId !== userId || !['FAILED', 'CANCELLED'].includes(job.status))
        return null;
      jobs.delete(id);
      return { job, objectKeys: [job.sourceObjectKey] };
    },
  } as unknown as JobsRepository;

  const storage = {
    headObject: async () => ({ sizeBytes: 1 }),
    deleteObject: async (objectKey: string) => {
      deletedObjectKeys.push(objectKey);
    },
  } as unknown as ObjectStorageService;

  // This file never exercises a multi-input (image-to-pdf) job.
  const jobInputsRepository = {
    findByJobId: async () => [],
  } as unknown as JobInputsRepository;

  const tokenService = new TokenService('a'.repeat(32), 'b'.repeat(32), '15m', 30);
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(uploadsRoutes, {
    prefix: '/api/v1/uploads',
    uploadsService: new UploadsService(jobsRepository, jobInputsRepository, storage, 1024, {
      uploadUrlTtlSeconds: 900,
      pendingUploadGraceSeconds: 300,
    }),
    processingService: new ProcessingService(
      jobsRepository,
      jobInputsRepository,
      {} as unknown as JobQueue,
      100,
    ),
    outputsService: new OutputsService(
      jobsRepository,
      {} as unknown as ProcessedFilesRepository,
      storage,
    ),
    tokenService,
  });
  return { app, tokenService, jobs, deletedObjectKeys };
}

async function bearer(
  tokenService: TokenService,
  userId: string,
): Promise<{ authorization: string }> {
  const pair = await tokenService.createPair(userId, `${userId}@example.test`, 'USER');
  return { authorization: `Bearer ${pair.accessToken}` };
}

describe('DELETE /api/v1/uploads/:id', () => {
  it('rejects an unauthenticated request with 401 and deletes nothing', async () => {
    const { app, jobs, deletedObjectKeys } = await buildTestApp([makeJob({})]);

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/uploads/job-1' });

    expect(response.statusCode).toBe(401);
    expect(jobs.has('job-1')).toBe(true);
    expect(deletedObjectKeys).toHaveLength(0);
    await app.close();
  });

  it("returns 204 with an empty body for the owner's FAILED job, and removes the row and its object", async () => {
    const { app, tokenService, jobs, deletedObjectKeys } = await buildTestApp([makeJob({})]);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/uploads/job-1',
      headers: await bearer(tokenService, 'user-1'),
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(jobs.has('job-1')).toBe(false);
    expect(deletedObjectKeys).toEqual(['uploads/user-1/source.mp4']);
    await app.close();
  });

  it("returns the same 404 JOB_NOT_FOUND for another user's job as for a missing one", async () => {
    const { app, tokenService, jobs, deletedObjectKeys } = await buildTestApp([makeJob({})]);
    const headers = await bearer(tokenService, 'user-2');

    const foreign = await app.inject({ method: 'DELETE', url: '/api/v1/uploads/job-1', headers });
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/uploads/nope', headers });

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error).toMatchObject({
      code: 'JOB_NOT_FOUND',
      message: 'Upload not found',
    });
    expect(missing.json().error).toMatchObject({
      code: 'JOB_NOT_FOUND',
      message: 'Upload not found',
    });
    expect(jobs.has('job-1')).toBe(true);
    expect(deletedObjectKeys).toHaveLength(0);
    await app.close();
  });

  it.each(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED'] as const)(
    'returns 409 JOB_NOT_DELETABLE for a %s job and leaves it in place',
    async (status) => {
      const { app, tokenService, jobs } = await buildTestApp([makeJob({ status })]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/uploads/job-1',
        headers: await bearer(tokenService, 'user-1'),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('JOB_NOT_DELETABLE');
      expect(jobs.has('job-1')).toBe(true);
      await app.close();
    },
  );

  it('returns 409 UPLOAD_CLEANUP_PENDING for a user-cancelled upload created moments ago', async () => {
    const { app, tokenService, jobs } = await buildTestApp([
      makeJob({ status: 'CANCELLED', errorCode: 'USER_CANCELLED', createdAt: new Date() }),
    ]);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/uploads/job-1',
      headers: await bearer(tokenService, 'user-1'),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('UPLOAD_CLEANUP_PENDING');
    expect(jobs.has('job-1')).toBe(true);
    await app.close();
  });

  it('a repeated delete of the same job is 404 (safe to double-click)', async () => {
    const { app, tokenService } = await buildTestApp([makeJob({})]);
    const headers = await bearer(tokenService, 'user-1');

    const first = await app.inject({ method: 'DELETE', url: '/api/v1/uploads/job-1', headers });
    const second = await app.inject({ method: 'DELETE', url: '/api/v1/uploads/job-1', headers });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/v1/uploads/cleanup', () => {
  const finished = () => [
    makeJob({ id: 'failed-1', status: 'FAILED', sourceObjectKey: 'uploads/user-1/f1.mp4' }),
    makeJob({
      id: 'cancelled-1',
      status: 'CANCELLED',
      errorCode: 'UPLOAD_EXPIRED',
      sourceObjectKey: 'uploads/user-1/c1.mp4',
    }),
    makeJob({ id: 'completed-1', status: 'COMPLETED', sourceObjectKey: 'uploads/user-1/ok.mp4' }),
    makeJob({
      id: 'theirs',
      userId: 'user-2',
      status: 'FAILED',
      sourceObjectKey: 'uploads/user-2/x.mp4',
    }),
  ];

  it('rejects an unauthenticated request with 401', async () => {
    const { app, jobs } = await buildTestApp(finished());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/cleanup',
      payload: { statuses: ['FAILED'] },
    });

    expect(response.statusCode).toBe(401);
    expect(jobs.size).toBe(4);
    await app.close();
  });

  it('clears only the requested finished states of the caller and reports the counts', async () => {
    const { app, tokenService, jobs } = await buildTestApp(finished());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/cleanup',
      headers: await bearer(tokenService, 'user-1'),
      payload: { statuses: ['FAILED', 'CANCELLED'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 2, skipped: 0, remaining: 0 });
    expect([...jobs.keys()].sort()).toEqual(['completed-1', 'theirs']);
    await app.close();
  });

  it('only clears failed files when only FAILED is requested', async () => {
    const { app, tokenService, jobs } = await buildTestApp(finished());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/cleanup',
      headers: await bearer(tokenService, 'user-1'),
      payload: { statuses: ['FAILED'] },
    });

    expect(response.json()).toEqual({ deleted: 1, skipped: 0, remaining: 0 });
    expect(jobs.has('cancelled-1')).toBe(true);
    await app.close();
  });

  it.each([
    ['a status that is not deletable', { statuses: ['COMPLETED'] }],
    ['an active status', { statuses: ['PROCESSING'] }],
    ['an empty status list', { statuses: [] }],
    ['a missing statuses key', {}],
    ['an unknown extra key', { statuses: ['FAILED'], everything: true }],
    ['statuses that are not an array', { statuses: 'FAILED' }],
    ['more statuses than exist', { statuses: ['FAILED', 'CANCELLED', 'FAILED'] }],
  ])('returns 400 and deletes nothing for %s', async (_label, payload) => {
    const { app, tokenService, jobs } = await buildTestApp(finished());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/cleanup',
      headers: await bearer(tokenService, 'user-1'),
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(jobs.size).toBe(4);
    await app.close();
  });

  it('returns 400 for a request with no body at all', async () => {
    const { app, tokenService, jobs } = await buildTestApp(finished());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads/cleanup',
      headers: await bearer(tokenService, 'user-1'),
    });

    expect(response.statusCode).toBe(400);
    expect(jobs.size).toBe(4);
    await app.close();
  });
});
