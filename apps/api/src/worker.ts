import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import { loadServerEnvironment } from '@media/config';
import { createDatabaseClient } from '@media/database';
import { LibreOfficeDocumentService } from './infrastructure/document/libreoffice-document.service.js';
import { FfmpegMediaService } from './infrastructure/media/ffmpeg-media.service.js';
import { PrismaJobInputsRepository } from './infrastructure/repositories/prisma-job-inputs.repository.js';
import { PrismaJobsRepository } from './infrastructure/repositories/prisma-jobs.repository.js';
import { PrismaProcessedFilesRepository } from './infrastructure/repositories/prisma-processed-files.repository.js';
import { S3StorageService } from './infrastructure/storage/s3-storage.service.js';
import { createLogger } from './utils/logger.js';
import { createMediaProcessingWorker } from './workers/media-processing.worker.js';
import {
  createStaleUploadReconciliationWorker,
  scheduleStaleUploadReconciliation,
} from './workers/stale-upload-reconciliation.worker.js';
import { createWorkerHealthServer } from './workers/worker-health-server.js';

dotenv.config({ path: resolve(process.cwd(), '../../.env') });

const log = createLogger('worker');
const environment = loadServerEnvironment();

const database = createDatabaseClient(environment.DATABASE_URL);

const storageService = new S3StorageService({
  endpoint: environment.S3_ENDPOINT,
  // The worker never issues presigned URLs (it only does server-side
  // downloadToFile/uploadFromFile against the internal endpoint), so this value is
  // never actually used to sign anything here — but the constructor is shared with
  // the API process, so it's still computed the same way for consistency.
  publicEndpoint: environment.S3_PUBLIC_ENDPOINT ?? environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  bucket: environment.S3_BUCKET,
  accessKeyId: environment.S3_ACCESS_KEY,
  secretAccessKey: environment.S3_SECRET_KEY,
  webOrigin: environment.WEB_ORIGIN,
  adminOrigin: environment.ADMIN_ORIGIN,
  manageBucketCors: environment.S3_MANAGE_BUCKET_CORS,
  uploadUrlTtlSeconds: environment.UPLOAD_URL_TTL_SECONDS,
});

const jobsRepository = new PrismaJobsRepository(database);
const jobInputsRepository = new PrismaJobInputsRepository(database);
const processedFilesRepository = new PrismaProcessedFilesRepository(database);
const mediaService = new FfmpegMediaService(environment.FFMPEG_PATH);
const documentConversionService = new LibreOfficeDocumentService(environment.LIBREOFFICE_PATH);

// BullMQ requires its own dedicated connection with maxRetriesPerRequest: null — the
// same hard requirement documented next to the API process's own queue-producer
// connection in app.ts. This worker never shares a Redis connection with anything else.
const connection = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });

const worker = createMediaProcessingWorker(
  {
    jobsRepository,
    jobInputsRepository,
    processedFilesRepository,
    storage: storageService,
    mediaService,
    documentConversionService,
  },
  connection,
  environment.WORKER_CONCURRENCY,
);

worker.on('error', (error) => {
  log.error({ err: error }, 'BullMQ worker error');
});

log.info({ concurrency: worker.opts.concurrency ?? 1 }, 'Media-processing worker started');

// Reuses this same worker process/container rather than a new always-on service —
// see stale-upload-reconciliation.worker.ts for why this is safe under multiple
// API/worker replicas (upsertJobScheduler is idempotent by a fixed scheduler id).
const staleUploadWorker = createStaleUploadReconciliationWorker(
  { jobsRepository, storage: storageService },
  connection,
  {
    uploadUrlTtlSeconds: environment.UPLOAD_URL_TTL_SECONDS,
    pendingUploadGraceSeconds: environment.PENDING_UPLOAD_GRACE_SECONDS,
  },
);

staleUploadWorker.on('error', (error) => {
  log.error({ err: error }, 'Stale-upload reconciliation BullMQ worker error');
});

await scheduleStaleUploadReconciliation(connection);
log.info('Stale-upload reconciliation scheduled');

// Readiness = "can this worker actually take and finish a job right now": Postgres and
// Redis reachable, and both BullMQ consumers still running. Object storage is left out
// on purpose — a storage blip already surfaces as retried transient job failures, and
// flipping the whole worker to not-ready for it would only add churn.
const healthServer =
  environment.WORKER_HEALTH_PORT > 0
    ? createWorkerHealthServer({
        log,
        checks: [
          { name: 'database', run: () => database.$queryRaw`SELECT 1` },
          { name: 'redis', run: () => connection.ping() },
          {
            name: 'workers',
            run: async () => {
              if (!worker.isRunning() || !staleUploadWorker.isRunning()) {
                throw new Error('A BullMQ worker is not running');
              }
            },
          },
        ],
      })
    : undefined;
healthServer?.listen(environment.WORKER_HEALTH_PORT, '0.0.0.0', () => {
  log.info({ port: environment.WORKER_HEALTH_PORT }, 'Worker health server listening');
});

// `worker.close()` waits for in-flight jobs to finish. There is deliberately no timer here:
// how long a deploy may wait for a running job is the orchestrator's stop timeout to
// decide. If it kills us first, BullMQ's stalled-job detection redelivers the interrupted
// job (see the crash-recovery notes in media-processing.worker.ts).
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Graceful shutdown started');
  healthServer?.close();
  await worker.close();
  await staleUploadWorker.close();
  await database.$disconnect();
  connection.disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
