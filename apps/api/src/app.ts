import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import type { ServerEnvironment } from '@media/config';
import { createDatabaseClient } from '@media/database';
import { AuthService } from './application/auth/auth.service.js';
import { OutputsService } from './application/jobs/outputs.service.js';
import { ProcessingService } from './application/jobs/processing.service.js';
import { UploadsService } from './application/jobs/uploads.service.js';
import { BullMqJobQueue } from './infrastructure/queue/bullmq-job-queue.js';
import { PrismaAuthRepository } from './infrastructure/repositories/prisma-auth.repository.js';
import { PrismaJobInputsRepository } from './infrastructure/repositories/prisma-job-inputs.repository.js';
import { PrismaJobsRepository } from './infrastructure/repositories/prisma-jobs.repository.js';
import { PrismaProcessedFilesRepository } from './infrastructure/repositories/prisma-processed-files.repository.js';
import { BcryptPasswordHasher } from './infrastructure/security/password-hasher.js';
import { TokenService } from './infrastructure/security/token-service.js';
import { S3StorageService } from './infrastructure/storage/s3-storage.service.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { adminRoutes } from './presentation/routes/admin.routes.js';
import { authRoutes } from './presentation/routes/auth.routes.js';
import { healthRoutes } from './presentation/routes/health.routes.js';
import { uploadsRoutes } from './presentation/routes/uploads.routes.js';
import { resolveCookieSecure } from './utils/cookie-security.js';
import { resolveTrustProxy } from './utils/trust-proxy.js';

export async function buildApp(environment: ServerEnvironment): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: environment.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    },
    // Only the entries appended by our own N reverse proxies are trusted when deriving
    // `request.ip` (the rate-limit key). `true` would trust the whole header, whose
    // leftmost values are client-controlled — see TRUST_PROXY_HOPS in @media/config.
    trustProxy: resolveTrustProxy(environment.TRUST_PROXY_HOPS),
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
  });

  // Echo the correlation id so a client (or a support ticket) can quote it and an
  // operator can grep it across nginx, API and worker logs.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: [environment.WEB_ORIGIN, environment.ADMIN_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  const redis = new Redis(environment.REDIS_URL, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    redis,
  });

  // BullMQ requires its own dedicated connection with maxRetriesPerRequest: null (a
  // hard requirement for the blocking commands it issues internally) — it cannot
  // share the rate-limiter's connection above, which is deliberately configured with
  // maxRetriesPerRequest: 1 for unrelated (fail-fast-on-rate-limit-check) reasons.
  const queueRedis = new Redis(environment.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  registerErrorHandler(app);

  const database = createDatabaseClient(environment.DATABASE_URL);
  const jobQueue = new BullMqJobQueue(queueRedis);
  app.addHook('onClose', async () => {
    await database.$disconnect();
    await jobQueue.close();
    redis.disconnect();
    queueRedis.disconnect();
  });
  const tokenService = new TokenService(
    environment.JWT_ACCESS_SECRET,
    environment.JWT_REFRESH_SECRET,
    environment.ACCESS_TOKEN_TTL,
    environment.REFRESH_TOKEN_TTL_DAYS,
  );
  const authService = new AuthService(
    new PrismaAuthRepository(database),
    new BcryptPasswordHasher(),
    tokenService,
  );
  const storageService = new S3StorageService({
    endpoint: environment.S3_ENDPOINT,
    // Falls back to the internal endpoint when no separate public one is configured
    // (the normal case for a real deployment where the same HTTPS endpoint is
    // reachable both server-side and from the browser).
    publicEndpoint: environment.S3_PUBLIC_ENDPOINT ?? environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    bucket: environment.S3_BUCKET,
    accessKeyId: environment.S3_ACCESS_KEY,
    secretAccessKey: environment.S3_SECRET_KEY,
    // Same allowlist already trusted by the @fastify/cors registration above — the
    // bucket needs its own CORS config because the browser's presigned PUT goes
    // directly to the storage endpoint's origin, not through this Fastify app.
    webOrigin: environment.WEB_ORIGIN,
    adminOrigin: environment.ADMIN_ORIGIN,
    manageBucketCors: environment.S3_MANAGE_BUCKET_CORS,
    uploadUrlTtlSeconds: environment.UPLOAD_URL_TTL_SECONDS,
  });
  const jobsRepository = new PrismaJobsRepository(database);
  const jobInputsRepository = new PrismaJobInputsRepository(database);
  const uploadsService = new UploadsService(
    jobsRepository,
    jobInputsRepository,
    storageService,
    environment.MAX_UPLOAD_SIZE_BYTES,
    {
      uploadUrlTtlSeconds: environment.UPLOAD_URL_TTL_SECONDS,
      pendingUploadGraceSeconds: environment.PENDING_UPLOAD_GRACE_SECONDS,
    },
  );
  const processingService = new ProcessingService(
    jobsRepository,
    jobInputsRepository,
    jobQueue,
    environment.MAX_ACTIVE_JOBS_PER_USER,
  );
  const outputsService = new OutputsService(
    jobsRepository,
    new PrismaProcessedFilesRepository(database),
    storageService,
  );

  await app.register(healthRoutes, {
    prefix: '/health',
    // Distinct from liveness on purpose: these are the dependencies a request actually
    // needs. The BullMQ producer connection is probed (not the rate-limiter's lazy one).
    readinessChecks: [
      { name: 'database', run: () => database.$queryRaw`SELECT 1` },
      { name: 'redis', run: () => queueRedis.ping() },
      { name: 'storage', run: () => storageService.checkAccessible() },
    ],
  });
  await app.register(authRoutes, {
    prefix: '/api/v1/auth',
    authService,
    tokenService,
    cookieSecure: resolveCookieSecure(environment),
    ...(environment.COOKIE_DOMAIN ? { cookieDomain: environment.COOKIE_DOMAIN } : {}),
  });
  await app.register(adminRoutes, { prefix: '/api/v1/admin', tokenService });
  await app.register(uploadsRoutes, {
    prefix: '/api/v1/uploads',
    uploadsService,
    processingService,
    outputsService,
    tokenService,
  });

  return app;
}
