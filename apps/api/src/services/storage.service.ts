export interface UploadRequest {
  objectKey: string;
  contentType: string;
  contentLength: number;
}

export interface DownloadRequest {
  objectKey: string;
  /** `inline` to preview in the browser, `attachment` to force a save. */
  disposition: 'inline' | 'attachment';
  /**
   * Name the browser should present. Implementations must treat this as untrusted
   * and sanitize it before it reaches any header value.
   */
  fileName: string;
  contentType: string;
}

export interface ObjectStorageService {
  createUploadUrl(request: UploadRequest): Promise<{ url: string; expiresAt: Date }>;
  /**
   * Issues a short-lived presigned GET for a caller that has *already* been
   * authorized — this method performs no ownership or state checks of its own, and
   * the object key must always be resolved from server-side records, never accepted
   * from a client.
   */
  createDownloadUrl(request: DownloadRequest): Promise<{ url: string; expiresAt: Date }>;
  deleteObject(objectKey: string): Promise<void>;
  /**
   * Checks whether an object genuinely exists in storage, returning its actual size
   * if so or `null` if it does not. A presigned PUT URL only constrains what *can* be
   * uploaded (see the ContentLength-is-signed/ContentType-is-not note on
   * `createUploadUrl`'s implementation) — it never proves anything actually was. This
   * is the one real server-side verification available, used by the upload
   * confirmation flow before trusting a client's "I uploaded it" claim.
   */
  headObject(objectKey: string): Promise<{ sizeBytes: number } | null>;

  /**
   * Streams an object directly to a local file path on disk. Unlike
   * `createDownloadUrl`/`createUploadUrl` (which hand the *browser* a presigned URL
   * to talk to storage directly), these two methods are for server-side callers that
   * hold real SDK credentials — namely the (separate) FFmpeg worker task, which needs
   * to pull a source file down to local disk before it can invoke FFmpeg on it, and
   * push the resulting output back up. Never buffers the whole object in memory —
   * media files can be large — implementations must pipe/stream both directions.
   */
  downloadToFile(objectKey: string, destinationPath: string): Promise<void>;
  /**
   * Streams a local file up to storage under the given object key. Same server-side,
   * credentialed-caller-only distinction as `downloadToFile` above — not presigned,
   * not browser-facing. Objects written this way get the same private-by-default
   * posture as everything else in this adapter (no public ACL).
   */
  uploadFromFile(objectKey: string, sourcePath: string, contentType: string): Promise<void>;

  /**
   * Resolves if the configured bucket is reachable with the configured credentials,
   * rejects otherwise. Used by readiness probes, so it must stay cheap (no object
   * listing) and must re-check the live endpoint on every call rather than trusting a
   * cached success from earlier in the process's life.
   */
  checkAccessible(): Promise<void>;
}

export class StorageNotConfiguredError extends Error {
  public constructor() {
    super('Object storage adapter is not configured');
  }
}
