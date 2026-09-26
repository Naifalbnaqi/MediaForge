import type { FastifyInstance } from 'fastify';
import {
  cleanupUploadsSchema,
  initiateImageToPdfSchema,
  initiateUploadSchema,
  jobIdParamsSchema,
  outputQuerySchema,
  requestProcessingSchema,
} from '@media/validation';
import type { OutputsService } from '../../application/jobs/outputs.service.js';
import type { ProcessingService } from '../../application/jobs/processing.service.js';
import type { UploadsService } from '../../application/jobs/uploads.service.js';
import type { TokenService } from '../../infrastructure/security/token-service.js';
import { createAuthenticate } from '../../middleware/authenticate.js';
import { AppError } from '../../utils/app-error.js';

interface UploadsRoutesOptions {
  uploadsService: UploadsService;
  processingService: ProcessingService;
  outputsService: OutputsService;
  tokenService: TokenService;
}

export async function uploadsRoutes(
  app: FastifyInstance,
  options: UploadsRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.tokenService);

  function requireAuthUser(request: { authUser?: { id: string } }): string {
    if (!request.authUser) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
    }
    return request.authUser.id;
  }

  app.post(
    '/',
    {
      preHandler: [authenticate],
      // Mitigates a user spamming PENDING job-row creation (and presigned URL
      // generation) without ever actually uploading anything to storage.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = requireAuthUser(request);
      const input = initiateUploadSchema.parse(request.body);
      const result = await options.uploadsService.initiate(userId, input);
      return reply.status(201).send(result);
    },
  );

  /**
   * Initiates a multi-image `image-to-pdf` job: one Job plus one presigned
   * upload URL per image, in the same order the images were submitted in
   * (page order). Image-to-pdf's own upload-initiation path, entirely
   * separate from `POST /` above — see `UploadsService.initiateImageToPdf`.
   * Same rate-limit tier as `POST /` (metadata + presigned-URL work only, no
   * real processing yet).
   */
  app.post(
    '/image-to-pdf',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = requireAuthUser(request);
      const input = initiateImageToPdfSchema.parse(request.body);
      const result = await options.uploadsService.initiateImageToPdf(userId, input);
      return reply.status(201).send(result);
    },
  );

  app.post('/:id/complete', { preHandler: [authenticate] }, async (request) => {
    const userId = requireAuthUser(request);
    const { id } = jobIdParamsSchema.parse(request.params);
    return options.uploadsService.complete(userId, id);
  });

  app.get('/', { preHandler: [authenticate] }, async (request) => {
    const userId = requireAuthUser(request);
    const files = await options.uploadsService.list(userId);
    return { files };
  });

  /**
   * Cancels the caller's own still-PENDING upload (e.g. the user changed their
   * mind, or the presigned URL expired before they finished) — no body needed, same
   * no-input-resupplied shape as POST /:id/complete and /:id/retry. Ownership and
   * PENDING-only enforcement happen in UploadsService.cancel.
   */
  app.post(
    '/:id/cancel',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      return options.uploadsService.cancel(userId, id);
    },
  );

  /**
   * Bulk cleanup of the caller's own finished (FAILED/CANCELLED) files — the body
   * names which of those two states to clear. Nothing else is ever deletable here:
   * the schema only admits those two names, and `UploadsService.cleanup` runs every
   * file through the same checks as a single delete. A POST (not `DELETE /`) because
   * it carries a body and reports a result rather than removing one addressed
   * resource. Registered before the `/:id/...` routes purely for readability;
   * `cleanup` is a static segment, so it can never be read as a job id.
   */
  app.post(
    '/cleanup',
    {
      preHandler: [authenticate],
      // Each call can delete many files and touch storage for each — far tighter than
      // the single-delete bucket below.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireAuthUser(request);
      const { statuses } = cleanupUploadsSchema.parse(request.body);
      return options.uploadsService.cleanup(userId, statuses);
    },
  );

  /**
   * Permanently deletes the caller's own FAILED or CANCELLED job and its stored
   * files. 204 on success; 404 for a missing job and for someone else's (same
   * non-enumerable convention as complete/cancel); 409 when the job is not in a
   * deletable state (or is a just-cancelled upload whose storage is still being
   * cleaned up). Ownership and every safety rule live in `UploadsService.delete`.
   */
  app.delete(
    '/:id',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      await options.uploadsService.delete(userId, id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/:id/process',
    {
      preHandler: [authenticate],
      // Unlike upload-initiation, a successful call here enqueues real, bounded-
      // concurrency, CPU-bound FFmpeg work — the global 100/min/IP limit alone would
      // let one client queue far more conversion work than the worker pool can keep
      // up with. Mirrors the same rateLimit shape already used on POST / above.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      // The discriminated union's variants each carry their own optional
      // `options` (absent whenever an operation, like convert-to-mp4 today,
      // takes none) — default to `{}` so Job.options always persists a plain
      // object, never `undefined`.
      const parsed = requestProcessingSchema.parse(request.body);
      return options.processingService.requestProcessing(userId, id, parsed.operation, parsed.options ?? {});
    },
  );

  /**
   * Starts processing an `UPLOADED` `image-to-pdf` job — no body, mirroring
   * `POST /:id/complete`/`/:id/cancel`/`/:id/retry`'s "action on an existing
   * resource, nothing re-suppliable" shape. Deliberately not `POST /:id/process`:
   * `image-to-pdf` is never a variant of that route's `requestProcessingSchema`
   * body (see the note on `processingOperations` in `@media/validation`) since
   * there is nothing for a caller to choose — the operation was fixed by
   * calling `POST /image-to-pdf` in the first place. Same rate-limit tier as
   * `POST /:id/process`, since a successful call here also enqueues real
   * CPU-bound work.
   */
  app.post(
    '/:id/process-image-to-pdf',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      return options.processingService.processImageToPdf(userId, id);
    },
  );

  app.get('/:id', { preHandler: [authenticate] }, async (request) => {
    const userId = requireAuthUser(request);
    const { id } = jobIdParamsSchema.parse(request.params);
    return options.processingService.getStatus(userId, id);
  });

  /**
   * Retries a FAILED job against the same stored source object and the same
   * operation it originally failed with — no body needed, nothing about the request
   * is re-suppliable (mirrors POST /:id/complete's shape: an action on an existing
   * resource, not new input). Same rate-limit posture as POST /:id/process, since a
   * successful call here also enqueues real CPU-bound work.
   */
  app.post(
    '/:id/retry',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      return options.processingService.retryProcessing(userId, id);
    },
  );

  /**
   * Issues a short-lived presigned URL for a completed job's processed output.
   * `?disposition=inline` previews in the browser, `attachment` (the default)
   * downloads. The object key is resolved server-side from the job's own
   * ProcessedFile record — never accepted from the caller — and nothing is signed
   * until ownership and COMPLETED status have been verified. The signed URL is
   * returned in the response body only; it is deliberately never logged.
   */
  app.get(
    '/:id/output',
    {
      preHandler: [authenticate],
      // Every call costs two DB reads plus a real storage HEAD round trip, and mints
      // a fresh time-limited capability URL. Tighter than the global 100/min/IP for
      // the same reason the sibling write routes above opt into their own buckets,
      // while still leaving ample room for preview + download + a retry or two.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = requireAuthUser(request);
      const { id } = jobIdParamsSchema.parse(request.params);
      const { disposition } = outputQuerySchema.parse(request.query);
      // The body carries a short-lived capability URL; keep it out of any cache.
      reply.header('Cache-Control', 'no-store');
      return options.outputsService.getProcessedOutput(userId, id, disposition);
    },
  );
}
