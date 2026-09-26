import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  ADMIN_ORIGIN: z.url().default('http://localhost:3001'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.preprocess(emptyToUndefined, z.string().optional()),
  // Explicit override for the Secure attribute on auth cookies. Deliberately NOT
  // z.coerce.boolean() — that coerces any non-empty string (including the literal
  // text "false") to `true`, which would silently defeat this setting's entire
  // purpose. Only the exact strings "true"/"false" are accepted; anything else
  // (including a typo) fails validation at startup rather than being misread.
  // Left undefined when unset so callers can distinguish "not provided" (fall back
  // to NODE_ENV === 'production') from an explicit choice.
  COOKIE_SECURE: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).optional(),
  ).transform((value) => (value === undefined ? undefined : value === 'true')),
  // Internal endpoint used by the API/worker for server-side storage access (bucket
  // management, download/upload streaming, existence checks) — inside Docker this is
  // typically a service-network hostname (e.g. http://object-storage:9000) that is
  // not reachable from a browser.
  S3_ENDPOINT: z.url(),
  // Endpoint embedded in presigned URLs handed to the browser (upload/download).
  // Falls back to S3_ENDPOINT when not provided — the common case for a real
  // deployment where the same endpoint is reachable both server-side and from the
  // browser (e.g. a public AWS S3/HTTPS endpoint). Only needs to differ locally,
  // where the API reaches MinIO via a Docker-internal hostname but the browser must
  // use http://localhost instead. Resolving the effective value (falling back to
  // S3_ENDPOINT) is done by the caller, not here, so this stays a plain optional URL.
  S3_PUBLIC_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  // Whether this process should manage the bucket's CORS rules itself via the S3 API
  // (PutBucketCorsCommand). Deliberately NOT z.coerce.boolean() — see COOKIE_SECURE's
  // comment above for why that would silently misparse the literal string "false".
  // Defaults to true (the pre-existing, always-manage behavior) so any deployment
  // that doesn't set this var keeps working exactly as before. Set to false when
  // CORS is managed externally (the storage provider's own console/API, e.g. a
  // locally-configured MinIO via MINIO_API_CORS_ALLOW_ORIGIN, or an AWS account where
  // bucket CORS is provisioned outside this application).
  S3_MANAGE_BUCKET_CORS: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default('true'),
  ).transform((value) => value === 'true'),
  // 500 MiB: comfortably covers short-to-medium source video/audio files (the media
  // types this platform accepts) without allowing unbounded uploads through a
  // presigned URL. Deployments with different needs can override via env.
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().positive().default(524_288_000),
  // How long a presigned upload URL (and, by extension, a PENDING Job row) stays
  // valid. 15 minutes is ample for a browser to start and finish a direct-to-storage
  // PUT. Shared by two consumers that must never drift apart: S3StorageService signs
  // the presigned PUT with this exact TTL, and the stale-upload reconciliation worker
  // uses it (together with PENDING_UPLOAD_GRACE_SECONDS below) to decide when an
  // abandoned PENDING row is safe to act on. NOTE: reaching this TTL alone does not
  // guarantee no PUT is still in flight — S3/MinIO validates a presigned request's
  // signature only when the request is first *accepted*, not continuously through
  // the body transfer, so a PUT that started a moment before this boundary can still
  // legitimately finish landing bytes afterward. PENDING_UPLOAD_GRACE_SECONDS exists
  // specifically to cover that gap; nothing in this codebase should treat "past this
  // TTL" alone as "safe to cancel or delete".
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Extra buffer *on top of* UPLOAD_URL_TTL_SECONDS before the stale-upload
  // reconciliation worker treats a PENDING (or manually-cancelled) upload as truly
  // safe to act on — see UPLOAD_URL_TTL_SECONDS's doc for why the raw TTL alone
  // isn't enough. The effective cutoff used everywhere is always `createdAt +
  // UPLOAD_URL_TTL_SECONDS + PENDING_UPLOAD_GRACE_SECONDS` (stale-upload-
  // reconciliation.worker.ts's `computeSafeCutoff`) — this single margin covers both
  // the sweep's own stale-PENDING pass and the deferred physical deletion of a
  // manually-cancelled upload's storage object; there is deliberately no second,
  // separate grace constant for the latter. 5 minutes is generous relative to how
  // long a transfer of up to MAX_UPLOAD_SIZE_BYTES could plausibly still be running
  // after being accepted just under the wire.
  PENDING_UPLOAD_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(300),
  // The most jobs a single user may have QUEUED+PROCESSING at once — a
  // server-side abuse/fairness guard against one user flooding the shared
  // worker pool (see ProcessingService.enforceActiveJobLimit). Only enforced by
  // the API process; PENDING/UPLOADED (not yet submitted) and COMPLETED/FAILED/
  // CANCELLED (already finished) never count toward it. 3 is generous for
  // normal single-user usage while still bounding worst-case queue depth from
  // any one account.
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(3),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  // Only ever invoked by the worker (document-to-pdf), same as FFMPEG_PATH — the
  // api process never runs it. Not installed in the api image at all (see
  // infrastructure/docker/api.Dockerfile's runtime-worker stage), so this default
  // is meaningless there, but harmless: the binary is simply never called.
  LIBREOFFICE_PATH: z.string().default('soffice'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // How many reverse proxies sit between the internet and the API (the API only, not
  // the worker). Fastify derives `request.ip` — the key for every per-IP rate limit
  // (login, register, uploads, ...) — from X-Forwarded-For, and a client can put any
  // value it likes in that header. Trusting it blindly (`trustProxy: true`) lets an
  // attacker rotate the header to dodge those limits, so only the entries appended by
  // the N proxies we operate are trusted: 0 trusts no forwarded header (request.ip is the
  // socket peer), 1 is one proxy such as the bundled nginx, 2 is a load balancer in
  // front of nginx, and so on. Defaults to 0 (secure by default); a mismatch is
  // visible rather than exploitable — too low makes every user share the proxy's
  // address (and its rate-limit bucket), too high trusts client-supplied entries.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Jobs one worker process runs at once. Media work is CPU-bound (FFmpeg encodes,
  // LibreOffice), so the right value tracks the container's CPU allocation; scaling out
  // means more worker replicas, not just a bigger number here. Worker only.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Port for the worker's small HTTP health server (`/health/live`, `/health/ready`),
  // used by container/orchestrator probes. The worker has no public listener, so this
  // must stay unpublished. 0 disables the server entirely.
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(4001),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

/**
 * Variables that fall back to a `localhost` default in development but must be set
 * deliberately in production — a production process that silently inherited them
 * would trust CORS/cookie origins nobody chose.
 */
const REQUIRED_IN_PRODUCTION = ['WEB_ORIGIN', 'ADMIN_ORIGIN'] as const;

export function loadServerEnvironment(source: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  const environment = serverEnvironmentSchema.parse(source);
  if (environment.NODE_ENV === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !source[name]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required production environment variable(s): ${missing.join(', ')}. ` +
          'These default to localhost in development and must be set explicitly in production.',
      );
    }
  }
  if (environment.JWT_ACCESS_SECRET === environment.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values: they sign ' +
        'different token types and must not be interchangeable.',
    );
  }
  return environment;
}
