import { apiRequest } from '@media/auth-client';
import type {
  CleanupUploadsResponse,
  InitiateImageToPdfResponse,
  JobStatusResponse,
  ProcessedOutputResponse,
  UploadInitiateResponse,
  UploadedFileSummary,
} from '@media/types';
import type {
  DeletableJobStatus,
  InitiateImageToPdfInput,
  InitiateUploadInput,
  OutputDisposition,
  ProcessingOperation,
} from '@media/validation';

/**
 * Relative to `NEXT_PUBLIC_API_URL`, which already includes the `/api/v1`
 * prefix (see `@media/auth-client`'s `api-client.ts`), matching the API's
 * `app.register(uploadsRoutes, { prefix: '/api/v1/uploads', ... })`.
 */
const UPLOADS_PATH = '/uploads';

/** Step 1: creates a PENDING upload job and returns a presigned storage URL. */
export function initiateUpload(
  accessToken: string,
  input: InitiateUploadInput,
): Promise<UploadInitiateResponse> {
  return apiRequest<UploadInitiateResponse>(UPLOADS_PATH, {
    method: 'POST',
    accessToken,
    body: input,
  });
}

/** Step 3: marks the job UPLOADED after the direct-to-storage PUT succeeds. */
export function completeUpload(accessToken: string, jobId: string): Promise<UploadedFileSummary> {
  return apiRequest<UploadedFileSummary>(`${UPLOADS_PATH}/${jobId}/complete`, {
    method: 'POST',
    accessToken,
  });
}

/**
 * Image-to-pdf's own upload-initiation path (never a variant of `initiateUpload`
 * above): one Job for every image at once, ordered — order here is page order.
 * Returns one presigned upload URL per image, in the same order.
 */
export function initiateImageToPdf(
  accessToken: string,
  input: InitiateImageToPdfInput,
): Promise<InitiateImageToPdfResponse> {
  return apiRequest<InitiateImageToPdfResponse>(`${UPLOADS_PATH}/image-to-pdf`, {
    method: 'POST',
    accessToken,
    body: input,
  });
}

/**
 * Starts processing an UPLOADED image-to-pdf job — image-to-pdf's own
 * counterpart to `requestProcessing`, taking no operation/options (there is
 * exactly one thing this job type can become). Call after every image has
 * been PUT to its presigned URL and `completeUpload` has confirmed them all.
 */
export function processImageToPdf(accessToken: string, jobId: string): Promise<JobStatusResponse> {
  return apiRequest<JobStatusResponse>(`${UPLOADS_PATH}/${jobId}/process-image-to-pdf`, {
    method: 'POST',
    accessToken,
  });
}

/** Lists the current user's own uploaded files. */
export function listUploads(accessToken: string): Promise<{ files: UploadedFileSummary[] }> {
  return apiRequest<{ files: UploadedFileSummary[] }>(UPLOADS_PATH, { accessToken });
}

/**
 * Requests that an UPLOADED job be queued for processing with the given
 * operation — see `@/lib/media-tools`'s `MEDIA_TOOLS` registry for which
 * operations the dashboard actually offers, matching the API's own
 * `requestProcessingSchema` discriminated union in `@media/validation`. The API
 * responds 409 `JOB_NOT_UPLOADED` if the job isn't currently in the `UPLOADED`
 * state (e.g. already queued/processing/completed), and 429
 * `TOO_MANY_ACTIVE_JOBS` if the caller already has too many jobs QUEUED/
 * PROCESSING at once.
 */
export function requestProcessing(
  accessToken: string,
  jobId: string,
  operation: ProcessingOperation,
  options?: Record<string, unknown>,
): Promise<JobStatusResponse> {
  return apiRequest<JobStatusResponse>(`${UPLOADS_PATH}/${jobId}/process`, {
    method: 'POST',
    accessToken,
    body: options ? { operation, options } : { operation },
  });
}

/** Phase 5: fetches a single job's current processing status (for polling). */
export function getJobStatus(accessToken: string, jobId: string): Promise<JobStatusResponse> {
  return apiRequest<JobStatusResponse>(`${UPLOADS_PATH}/${jobId}`, { accessToken });
}

/**
 * Re-queues a FAILED job using its original uploaded source file. The API resets the
 * previous error fields and re-enqueues processing; it responds 409 `JOB_NOT_FAILED`
 * if the job isn't currently FAILED (e.g. a second click after it already re-queued).
 */
export function retryProcessing(accessToken: string, jobId: string): Promise<JobStatusResponse> {
  return apiRequest<JobStatusResponse>(`${UPLOADS_PATH}/${jobId}/retry`, {
    method: 'POST',
    accessToken,
  });
}

/**
 * Cancels the caller's own still-PENDING upload. The API responds 409
 * `UPLOAD_NOT_PENDING` if the job isn't currently PENDING (already confirmed, or
 * already reconciled away as stale by the background sweep).
 */
export function cancelUpload(accessToken: string, jobId: string): Promise<UploadedFileSummary> {
  return apiRequest<UploadedFileSummary>(`${UPLOADS_PATH}/${jobId}/cancel`, {
    method: 'POST',
    accessToken,
  });
}

/**
 * Permanently deletes the caller's own FAILED or CANCELLED file and its stored data
 * (204, no body). The API responds 404 for a file that is already gone (or is not
 * the caller's — indistinguishable by design), 409 `JOB_NOT_DELETABLE` if it is in
 * any other state, and 409 `UPLOAD_CLEANUP_PENDING` for an upload cancelled moments
 * ago whose storage is still being cleaned up.
 */
export function deleteUpload(accessToken: string, jobId: string): Promise<void> {
  return apiRequest<void>(`${UPLOADS_PATH}/${jobId}`, { method: 'DELETE', accessToken });
}

/**
 * Bulk-deletes the caller's own files in the given finished states (only FAILED and
 * CANCELLED exist as options — active, usable and completed files are never
 * touched, server-side). Reports how many were deleted, how many were skipped (for
 * example a just-cancelled upload still being cleaned up), and how many matching
 * files remain beyond the per-request limit.
 */
export function cleanupUploads(
  accessToken: string,
  statuses: readonly DeletableJobStatus[],
): Promise<CleanupUploadsResponse> {
  return apiRequest<CleanupUploadsResponse>(`${UPLOADS_PATH}/cleanup`, {
    method: 'POST',
    accessToken,
    body: { statuses },
  });
}

/**
 * Requests a short-lived presigned URL for a COMPLETED job's processed output —
 * `inline` to preview it in the browser, `attachment` to download it. The URL
 * expires, so callers should invoke this fresh per action rather than caching the
 * result. The API resolves the storage object from its own records; no object key is
 * ever sent from here.
 */
export function getProcessedOutput(
  accessToken: string,
  jobId: string,
  disposition: OutputDisposition,
): Promise<ProcessedOutputResponse> {
  return apiRequest<ProcessedOutputResponse>(
    `${UPLOADS_PATH}/${jobId}/output?disposition=${encodeURIComponent(disposition)}`,
    { accessToken },
  );
}

/**
 * Step 2: uploads the raw file bytes directly to the presigned storage URL
 * returned by `initiateUpload`. This is a different origin from the API and
 * is authorized entirely by the presigned URL itself — it must NOT go
 * through `apiRequest`, must NOT carry an `Authorization` header, and must
 * NOT use `credentials: 'include'` (no API cookies belong on this request).
 *
 * Uses `XMLHttpRequest` rather than `fetch` specifically because `fetch` has
 * no upload-progress API; `xhr.upload.onprogress` is what powers the
 * progress feedback in the upload UI.
 */
export function uploadFileToPresignedUrl(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Storage upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('A network error interrupted the upload.'));
    xhr.onabort = () => reject(new Error('The upload was aborted.'));

    xhr.send(file);
  });
}
