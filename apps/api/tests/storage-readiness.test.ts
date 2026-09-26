import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3StorageService } from '../src/infrastructure/storage/s3-storage.service.js';

function buildService(): S3StorageService {
  return new S3StorageService({
    endpoint: 'http://internal-host:9000',
    publicEndpoint: 'http://internal-host:9000',
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    webOrigin: 'http://localhost:3000',
    adminOrigin: 'http://localhost:3001',
    manageBucketCors: false,
    uploadUrlTtlSeconds: 900,
  });
}

function notFound(): Error {
  return Object.assign(new Error('NotFound'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

describe('S3StorageService.checkAccessible', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues a live HeadBucket on every call rather than trusting an earlier success', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const service = buildService();

    await service.checkAccessible();
    await service.checkAccessible();
    await service.checkAccessible();

    const heads = send.mock.calls.filter(([command]) => command instanceof HeadBucketCommand);
    expect(heads).toHaveLength(3);
  });

  it('reports a later outage even after the bucket was successfully used earlier', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const service = buildService();
    await service.checkAccessible();

    send.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' }));
    await expect(service.checkAccessible()).rejects.toThrow('ECONNREFUSED');
  });

  it('creates the bucket when it does not exist yet (brand-new MinIO), then reports ready', async () => {
    const commands: string[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      commands.push((command as { constructor: { name: string } }).constructor.name);
      if (command instanceof HeadBucketCommand && !commands.includes('CreateBucketCommand')) {
        throw notFound();
      }
      return {};
    });

    await buildService().checkAccessible();

    expect(commands).toContain(CreateBucketCommand.name);
  });

  it('does not try to create the bucket for a non-404 failure such as bad credentials', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        name: 'Forbidden',
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await expect(buildService().checkAccessible()).rejects.toThrow('Forbidden');
    expect(send.mock.calls.some(([command]) => command instanceof CreateBucketCommand)).toBe(false);
  });
});
