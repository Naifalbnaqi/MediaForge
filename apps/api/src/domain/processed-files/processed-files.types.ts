/**
 * Domain view of a `ProcessedFile` row — the output artifact a worker writes after
 * successfully processing a `Job`. Written by the media-processing worker
 * (`processMediaJob`) on success, and read by `OutputsService` to resolve and sign
 * a job's processed output for `GET /:id/output`. Deliberately generic — nothing
 * here assumes the output is always an MP4 video — so a future operation (audio
 * extraction, thumbnails, etc.) can write a row here with its own `mimeType`/
 * `fileName` without changing this type or the authorization/download path that
 * reads it.
 */
export interface ProcessedFileRecord {
  id: string;
  jobId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksum: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CreateProcessedFileData {
  jobId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
}
