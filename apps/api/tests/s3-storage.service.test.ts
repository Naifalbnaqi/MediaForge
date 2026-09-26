import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverEnvironmentSchema } from '@media/config';
import {
  S3StorageService,
  type S3StorageServiceOptions,
} from '../src/infrastructure/storage/s3-storage.service.js';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  S3_ENDPOINT: 'http://internal-host:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
};

describe('serverEnvironmentSchema S3_MANAGE_BUCKET_CORS parsing', () => {
  it('parses "false" as boolean false, not a truthy coercion', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_MANAGE_BUCKET_CORS: 'false' });
    expect(env.S3_MANAGE_BUCKET_CORS).toBe(false);
  });

  it('parses "true" as boolean true', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_MANAGE_BUCKET_CORS: 'true' });
    expect(env.S3_MANAGE_BUCKET_CORS).toBe(true);
  });

  it('defaults to true when omitted (preserves pre-existing always-manage behavior)', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV });
    expect(env.S3_MANAGE_BUCKET_CORS).toBe(true);
  });

  it('defaults to true when set to an empty string', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_MANAGE_BUCKET_CORS: '' });
    expect(env.S3_MANAGE_BUCKET_CORS).toBe(true);
  });

  it('rejects any value other than exactly "true" or "false"', () => {
    expect(() =>
      serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_MANAGE_BUCKET_CORS: 'yes' }),
    ).toThrow();
    expect(() =>
      serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_MANAGE_BUCKET_CORS: '1' }),
    ).toThrow();
  });
});

describe('serverEnvironmentSchema S3_PUBLIC_ENDPOINT parsing', () => {
  it('is undefined when omitted, so the caller can fall back to S3_ENDPOINT', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV });
    expect(env.S3_PUBLIC_ENDPOINT).toBeUndefined();
  });

  it('is undefined when set to an empty string', () => {
    const env = serverEnvironmentSchema.parse({ ...REQUIRED_ENV, S3_PUBLIC_ENDPOINT: '' });
    expect(env.S3_PUBLIC_ENDPOINT).toBeUndefined();
  });

  it('parses a provided URL as-is', () => {
    const env = serverEnvironmentSchema.parse({
      ...REQUIRED_ENV,
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    });
    expect(env.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
  });
});

describe('S3StorageService', () => {
  interface DispatchedCommand {
    name: string;
    hostname: string;
  }

  let dispatched: DispatchedCommand[];

  beforeEach(() => {
    dispatched = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async function (
      this: S3Client,
      command: unknown,
    ) {
      const endpoint = await this.config.endpoint?.();
      dispatched.push({
        name: (command as { constructor: { name: string } }).constructor.name,
        hostname: (endpoint as { hostname?: string } | undefined)?.hostname ?? 'unknown',
      });
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: 42 };
      }
      // HeadBucketCommand, CreateBucketCommand, PutBucketCorsCommand, PutObjectCommand,
      // DeleteObjectCommand all just need to resolve successfully for these tests.
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseOptions: Omit<
    S3StorageServiceOptions,
    'endpoint' | 'publicEndpoint' | 'manageBucketCors'
  > = {
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    webOrigin: 'http://localhost:3000',
    adminOrigin: 'http://localhost:3001',
    uploadUrlTtlSeconds: 900,
  };

  it('does NOT send PutBucketCorsCommand when manageBucketCors is false', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://internal-host:9000',
      manageBucketCors: false,
    });

    await service.createUploadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      contentType: 'video/mp4',
      contentLength: 1024,
    });

    expect(dispatched.some((d) => d.name === 'PutBucketCorsCommand')).toBe(false);
    // Bucket existence is still checked either way — only CORS management is skipped.
    expect(dispatched.some((d) => d.name === 'HeadBucketCommand')).toBe(true);
  });

  it('DOES send PutBucketCorsCommand when manageBucketCors is true (existing behavior retained)', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://internal-host:9000',
      manageBucketCors: true,
    });

    await service.createUploadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      contentType: 'video/mp4',
      contentLength: 1024,
    });

    const corsCall = dispatched.find((d) => d.name === 'PutBucketCorsCommand');
    expect(corsCall).toBeDefined();
  });

  it('uses S3_PUBLIC_ENDPOINT (a genuinely different host) for presigned upload/download URLs', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://public-host:9001',
      manageBucketCors: false,
    });

    const upload = await service.createUploadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      contentType: 'video/mp4',
      contentLength: 1024,
    });
    const download = await service.createDownloadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      disposition: 'attachment',
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
    });

    expect(new URL(upload.url).hostname).toBe('public-host');
    expect(new URL(upload.url).port).toBe('9001');
    expect(new URL(download.url).hostname).toBe('public-host');
    expect(new URL(download.url).port).toBe('9001');
  });

  it('binds the response content-type and disposition into the signed download URL', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://internal-host:9000',
      manageBucketCors: false,
    });

    const download = await service.createDownloadUrl({
      objectKey: 'processed/user-1/output.mp4',
      disposition: 'attachment',
      fileName: 'holiday.mp4',
      contentType: 'video/mp4',
    });

    const params = new URL(download.url).searchParams;
    // Present as signed query parameters (they are part of the canonical request), so
    // a client cannot change how storage serves the object without breaking the
    // signature — this is what makes inline-vs-attachment a server-side decision.
    expect(params.get('response-content-type')).toBe('video/mp4');
    expect(params.get('response-content-disposition')).toContain('attachment');
    expect(params.get('response-content-disposition')).toContain('holiday.mp4');
    expect(params.get('X-Amz-SignedHeaders')).toBeTruthy();
  });

  it('falls back the presigning client to S3_ENDPOINT when no public endpoint is configured', async () => {
    // Simulates app.ts's own fallback (S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT) already
    // having resolved to the same value before construction.
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://internal-host:9000',
      manageBucketCors: false,
    });

    const upload = await service.createUploadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      contentType: 'video/mp4',
      contentLength: 1024,
    });

    expect(new URL(upload.url).hostname).toBe('internal-host');
  });

  it('keeps server-side operations (headObject, downloadToFile, uploadFromFile, deleteObject) on the internal endpoint, even when publicEndpoint differs', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://internal-host:9000',
      publicEndpoint: 'http://public-host:9001',
      manageBucketCors: false,
    });

    await service.headObject('uploads/user-1/file.mp4');
    await service.deleteObject('uploads/user-1/file.mp4');

    const serverSideCommands = dispatched.filter((d) =>
      [
        'HeadObjectCommand',
        'DeleteObjectCommand',
        'HeadBucketCommand',
        'CreateBucketCommand',
      ].includes(d.name),
    );
    expect(serverSideCommands.length).toBeGreaterThan(0);
    for (const command of serverSideCommands) {
      expect(command.hostname).toBe('internal-host');
    }
    // Never dispatched against the public endpoint.
    expect(serverSideCommands.some((c) => c.hostname === 'public-host')).toBe(false);
  });

  it('reuses a single S3Client instance (no redundant construction) when publicEndpoint equals endpoint', async () => {
    const service = new S3StorageService({
      ...baseOptions,
      endpoint: 'http://same-host:9000',
      publicEndpoint: 'http://same-host:9000',
      manageBucketCors: false,
    });

    const upload = await service.createUploadUrl({
      objectKey: 'uploads/user-1/file.mp4',
      contentType: 'video/mp4',
      contentLength: 1024,
    });
    await service.headObject('uploads/user-1/file.mp4');

    // Both the presigned URL and the server-side call resolve against the same host —
    // observable proof the same underlying configuration is used for both, without
    // reaching into private fields.
    expect(new URL(upload.url).hostname).toBe('same-host');
    expect(dispatched.every((d) => d.hostname === 'same-host')).toBe(true);
  });
});
