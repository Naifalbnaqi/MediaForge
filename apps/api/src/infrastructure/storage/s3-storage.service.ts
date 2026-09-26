import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  DownloadRequest,
  ObjectStorageService,
  UploadRequest,
} from '../../services/storage.service.js';
import { buildContentDisposition } from '../../utils/content-disposition.js';

const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

export interface S3StorageServiceOptions {
  /** Internal endpoint for server-side operations (API/worker) — see the class doc. */
  endpoint: string;
  /** Endpoint embedded in presigned URLs handed to the browser — see the class doc. */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** How long a presigned upload URL stays valid (`ServerEnvironment.UPLOAD_URL_TTL_SECONDS`).
   * Also the basis the stale-upload reconciliation worker uses to decide when an
   * abandoned PENDING job is safe to cancel — both must read this same config value
   * so the two never drift apart. */
  uploadUrlTtlSeconds: number;
  /** Browser origins allowed to talk to the bucket directly (presigned PUT/GET are
   * fetched by the browser from the bucket's own origin, not through apps/api — the
   * bucket's CORS config, not Fastify's, governs those requests). Reuses the exact
   * same allowlist as the API's own CORS config in app.ts. Only consulted when
   * `manageBucketCors` is true. */
  webOrigin: string;
  adminOrigin: string;
  /** Whether this process should manage the bucket's CORS rules itself. When false,
   * CORS is assumed to be managed externally (the provider's own console/API, or
   * MinIO's MINIO_API_CORS_ALLOW_ORIGIN) and no PutBucketCorsCommand is ever sent. */
  manageBucketCors: boolean;
}

/**
 * `ObjectStorageService` implemented against any S3-compatible endpoint (AWS S3,
 * MinIO, etc.) using the official AWS SDK v3. `forcePathStyle` is required for
 * MinIO/most self-hosted S3-compatible servers, which don't support virtual-hosted
 * `<bucket>.<endpoint>` addressing out of the box.
 *
 * Two separate S3 clients are used, deliberately:
 * - `client` (internal `endpoint`): all server-side operations — bucket management,
 *   `headObject`, `downloadToFile`, `uploadFromFile`, `deleteObject`. In Docker this
 *   is typically a service-network hostname the browser can never reach.
 * - `presigningClient` (`publicEndpoint`): used ONLY to generate presigned upload/
 *   download URLs, since those are handed to and fetched directly by the browser.
 * A presigned URL's `Host` is part of what SigV4 signs — generating it against the
 * internal endpoint and then string-replacing the hostname would invalidate the
 * signature (or silently produce a URL that only happens to work if the two hosts
 * are otherwise identical). A second, separately-configured client is the only
 * correct way to presign against a different host. When `publicEndpoint` and
 * `endpoint` are the same value (the common real-deployment case), the same client
 * instance is reused rather than constructing a redundant second one.
 *
 * Objects are never given a public-read ACL — the presigned URLs generated here are
 * the only access mechanism, matching the port's "private by default" contract.
 */
export class S3StorageService implements ObjectStorageService {
  private readonly client: S3Client;
  private readonly presigningClient: S3Client;
  private readonly bucket: string;
  private readonly allowedOrigins: readonly string[];
  private readonly manageBucketCors: boolean;
  private readonly uploadUrlTtlSeconds: number;
  private bucketReady: Promise<void> | null = null;

  public constructor(options: S3StorageServiceOptions) {
    this.bucket = options.bucket;
    this.allowedOrigins = [options.webOrigin, options.adminOrigin];
    this.manageBucketCors = options.manageBucketCors;
    this.uploadUrlTtlSeconds = options.uploadUrlTtlSeconds;
    const credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials,
    });
    this.presigningClient =
      options.publicEndpoint === options.endpoint
        ? this.client
        : new S3Client({
            endpoint: options.publicEndpoint,
            region: options.region,
            forcePathStyle: true,
            credentials,
          });
  }

  public async createUploadUrl(request: UploadRequest): Promise<{ url: string; expiresAt: Date }> {
    await this.ensureBucket();
    // ContentLength is bound into the presigned URL's SigV4 signature (it's a
    // signable header), so S3/MinIO rejects a PUT whose actual body size doesn't
    // match what was declared here — real enforcement, not just a hint. ContentType
    // is NOT signable in the AWS SDK v3 presigner and is therefore unenforced by the
    // signature (see the CORS-rule comment in ensureCors for the verified detail) —
    // passing it here only sets the object's stored metadata, it does not constrain
    // what Content-Type the actual PUT may send.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.objectKey,
      ContentType: request.contentType,
      ContentLength: request.contentLength,
    });
    const url = await getSignedUrl(this.presigningClient, command, {
      expiresIn: this.uploadUrlTtlSeconds,
    });
    return { url, expiresAt: new Date(Date.now() + this.uploadUrlTtlSeconds * 1000) };
  }

  public async createDownloadUrl(
    request: DownloadRequest,
  ): Promise<{ url: string; expiresAt: Date }> {
    await this.ensureBucket();
    // ResponseContentDisposition/ResponseContentType are signed query parameters, so
    // S3/MinIO echoes exactly these values back as response headers and a client
    // cannot tamper with them without invalidating the signature. This is what makes
    // `inline` (preview) vs `attachment` (download) a server-side decision rather
    // than a client-side hint. The file name is sanitized on the way in — it
    // ultimately derives from a user-supplied upload name.
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: request.objectKey,
      ResponseContentType: request.contentType,
      ResponseContentDisposition: buildContentDisposition(request.disposition, request.fileName),
    });
    const url = await getSignedUrl(this.presigningClient, command, {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
  }

  public async deleteObject(objectKey: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  public async headObject(objectKey: string): Promise<{ sizeBytes: number } | null> {
    await this.ensureBucket();
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      // ContentLength comes back as part of the same existence check, so returning it
      // here lets callers verify size with no second round trip.
      return { sizeBytes: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      // A genuine unexpected failure (network error, auth failure, etc.) must
      // propagate rather than being silently treated as "object missing" — that
      // would incorrectly deny a legitimate upload.
      throw error;
    }
  }

  /**
   * Server-side, credentialed download for the (separate) worker task — not a
   * presigned URL, this process's own SDK credentials read the object directly. The
   * response body is piped straight to a `fs.createWriteStream`, never buffered
   * whole into memory, since source media can be large.
   */
  public async downloadToFile(objectKey: string, destinationPath: string): Promise<void> {
    await this.ensureBucket();
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    if (!response.Body) {
      throw new Error(`Object body missing for key: object not found or empty`);
    }
    // In the Node.js runtime (as opposed to browser/edge), the SDK v3 response Body
    // is a real `Readable`, so it can be piped directly without buffering.
    await pipeline(response.Body as Readable, createWriteStream(destinationPath));
  }

  /**
   * Server-side, credentialed upload for the (separate) worker task — not a
   * presigned URL. Streams the local file from disk via `fs.createReadStream`
   * rather than reading it whole into memory. `ContentLength` is looked up via a
   * cheap `stat()` call and passed explicitly: without it, the SDK v3 HTTP handler
   * cannot stream a Node `Readable` body and instead buffers the entire stream in
   * memory to compute it itself — passing it explicitly is what keeps this a true
   * streaming upload. Same private-by-default posture as the rest of this adapter —
   * no ACL is set, so the object is only reachable via a presigned
   * `createDownloadUrl`.
   */
  public async uploadFromFile(
    objectKey: string,
    sourcePath: string,
    contentType: string,
  ): Promise<void> {
    await this.ensureBucket();
    const { size } = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
        ContentLength: size,
      }),
    );
  }

  /**
   * Readiness probe: a live `HeadBucket` on every call (never the cached
   * `ensureBucket` result, which would keep reporting "ready" through a later outage).
   * A 404 means the bucket does not exist *yet* — the normal state of a brand-new
   * MinIO, where the bucket is created lazily on first use — so that one case falls
   * through to `ensureBucket`, which creates it. Any other failure (network, wrong
   * credentials, permission) propagates and reads as not ready.
   */
  public async checkAccessible(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      await this.ensureBucket();
    }
  }

  /**
   * MinIO (unlike AWS S3) does not auto-create a bucket on first use, and there is no
   * init-container wired up in docker-compose for it. Rather than add that
   * orchestration complexity, lazily and idempotently ensure the bucket exists (and,
   * when this process is responsible for it, has the CORS config the browser upload
   * flow needs — see `ensureCors`) on first call from this process, caching the
   * in-flight/completed check so steady state costs nothing extra. Safe to call
   * concurrently or repeatedly — a "bucket already exists" response from a racing
   * creator is swallowed.
   */
  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.createBucketIfMissing().catch((error: unknown) => {
        this.bucketReady = null;
        throw error;
      });
    }
    return this.bucketReady;
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      // Bucket probably doesn't exist yet — fall through and try to create it.
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        const name = (error as { name?: string } | undefined)?.name;
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
          throw error;
        }
      }
    }
    // Skip bucket-CORS management entirely when it's handled externally (the
    // provider's own console/API, or MinIO's MINIO_API_CORS_ALLOW_ORIGIN) — sending
    // PutBucketCorsCommand in that case would either be redundant or could clobber a
    // configuration this application doesn't own.
    if (this.manageBucketCors) {
      await this.ensureCors();
    }
  }

  /**
   * A presigned PUT is fetched directly from the browser to this bucket's own
   * origin — that's the entire point of a direct-to-storage upload — so it's the
   * *bucket's* CORS config, not Fastify's `@fastify/cors` registration in app.ts,
   * that a browser's preflight actually checks. Without this, curl/server-to-server
   * calls succeed (CORS is a browser-only enforcement mechanism) while a real browser
   * upload is blocked. Idempotent: `PutBucketCorsCommand` fully replaces any existing
   * rule set, so calling this repeatedly is safe and simply re-applies the same
   * config, matching the lazy/idempotent pattern used for bucket creation above. Only
   * called when `manageBucketCors` is true — see `createBucketIfMissing`.
   */
  private async ensureCors(): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              // Reuses the exact same allowlist trusted by the API's own CORS config
              // (app.ts) — never '*'.
              AllowedOrigins: [...this.allowedOrigins],
              // Only PUT is needed, and that is still true now that presigned GETs
              // ship (the processed-output route): the browser consumes those via
              // anchor navigation and a <video src>, neither of which is a
              // cross-origin XHR/fetch, so no preflight occurs and no GET rule is
              // required. Do NOT widen this to satisfy a client that switches to
              // fetch()-ing the presigned URL — add a narrowly-scoped GET rule then,
              // and never '*'.
              AllowedMethods: ['PUT'],
              // The browser sends a Content-Type header on the PUT (a non-safelisted
              // value triggers a CORS preflight), so it must be allow-listed here or
              // the preflight itself would be blocked. NOTE: this does NOT mean the
              // declared Content-Type is cryptographically enforced — the AWS SDK v3
              // presigner treats content-type as an unsignable header by default, so
              // it is absent from the URL's X-Amz-SignedHeaders/signature (verified
              // empirically against the installed SDK version). S3/MinIO will accept
              // the PUT with any actual Content-Type, regardless of what was declared
              // to initiate(). Content-Length, by contrast, IS in SignedHeaders and is
              // enforced (see createUploadUrl below) — file size is genuinely pinned,
              // MIME type is not. Do not treat sourceMimeType as verified content;
              // real content-type trust would require inspecting the uploaded bytes
              // (e.g. magic-byte sniffing), which this phase does not do.
              AllowedHeaders: ['content-type'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }
}

/**
 * `HeadObjectCommand`'s modeled 404 response is `NotFound` (unlike, e.g., GetObject's
 * `NoSuchKey`) — HEAD responses never carry a body, so S3/MinIO can only signal
 * "missing" via a bare 404 status, and the SDK surfaces that as this specific,
 * always-the-same exception shape rather than deriving an error code from a response
 * body that doesn't exist. Checking `$metadata.httpStatusCode` too guards against any
 * S3-compatible backend that doesn't populate `name` exactly the same way. Anything
 * else (network failure, wrong credentials, etc.) is a real error and must not be
 * mistaken for "object missing".
 */
function isNotFoundError(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404;
}
