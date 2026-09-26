export type UserRole = 'USER' | 'ADMIN';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface ApiErrorPayload {
  error: { code: string; message: string; requestId?: string };
}

export interface AuthResponse {
  accessToken: string;
  user: AuthenticatedUser;
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  version: string;
}

/** Outcome of one dependency probe in a readiness check. */
export type ReadinessCheckResult = 'ok' | 'failed';

/**
 * `GET /health/ready`: whether this process can currently do useful work. HTTP 200 when
 * every dependency check passed, 503 otherwise. Only dependency names and pass/fail are
 * reported — never error text, hostnames, or connection details.
 */
export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
  timestamp: string;
  checks: Record<string, ReadinessCheckResult>;
}

export interface UploadInitiateResponse {
  id: string;
  uploadUrl: string;
  expiresAt: string;
}

/**
 * Result of `POST /uploads/image-to-pdf`: one Job (`id`) covering every image,
 * plus one presigned upload URL per image, in the same order the images were
 * submitted in (which becomes PDF page order). A client PUTs each image to its
 * matching `uploads[i].uploadUrl`, then calls `POST /:id/complete` once all of
 * them have landed.
 */
export interface InitiateImageToPdfResponse {
  id: string;
  uploads: { uploadUrl: string; expiresAt: string }[];
}

/**
 * Full `Job` lifecycle, widened in Phase 5 (processing-request slice) to include the
 * states reachable once a job has been queued for processing. `PENDING`/`UPLOADED`
 * are the only states the Phase 4 upload-only slice ever produced; the rest are
 * written by the processing-request route and (eventually) the worker task.
 */
export type UploadStatus =
  'PENDING' | 'UPLOADED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface UploadedFileSummary {
  id: string;
  fileName: string;
  mimeType: string;
  /** BigInt on the server; serialized as a string since JSON has no BigInt type. */
  sizeBytes: string;
  status: UploadStatus;
  createdAt: string;
}

/**
 * Result of a bulk cleanup of the caller's own finished (FAILED/CANCELLED) files.
 * `skipped` counts files that were left alone on purpose or by a race (for example
 * a just-cancelled upload whose storage is still being cleaned up, or one that
 * changed state mid-request); `remaining` counts matching files beyond this
 * request's per-call limit — call again to clear them.
 */
export interface CleanupUploadsResponse {
  deleted: number;
  skipped: number;
  remaining: number;
}

/**
 * Safe, client-facing view of a `Job`'s processing status — returned by both
 * `POST /api/v1/uploads/:id/process` (immediately after enqueueing) and
 * `GET /api/v1/uploads/:id` (polled thereafter). Deliberately excludes any
 * storage/queue/Redis internal detail (object keys, BullMQ job ids, bucket/endpoint
 * info) — see `ProcessingService` in apps/api for the mapping.
 */
export interface JobStatusResponse {
  id: string;
  status: UploadStatus;
  progress: number;
  fileName: string;
  mimeType: string;
  createdAt: string;
  /** Present only when `status` is `FAILED` or `CANCELLED`; always a safe,
   * pre-sanitized message — never a raw FFmpeg/storage error. */
  errorMessage?: string;
}

/**
 * A completed job's processed artifact, plus a short-lived presigned URL to fetch it.
 * Describes the *output* of the conversion, never the original upload — `fileName`,
 * `mimeType` and `sizeBytes` here all belong to the produced file, which is why they
 * can legitimately differ from the same-named fields on `UploadedFileSummary`/
 * `JobStatusResponse` (those describe the source).
 *
 * The URL expires (see `expiresAt`); clients should request a fresh one per action
 * rather than storing or sharing this, and the API never returns the underlying
 * storage object key.
 */
export interface ProcessedOutputResponse {
  jobId: string;
  fileName: string;
  mimeType: string;
  /** BigInt on the server; serialized as a string since JSON has no BigInt type. */
  sizeBytes: string;
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
}
