import { describe, expect, it } from 'vitest';
import { assertSafeRemoteUrl } from '../src/services/safe-url.service.js';

describe('assertSafeRemoteUrl', () => {
  it('rejects non-HTTPS URLs', async () => {
    await expect(assertSafeRemoteUrl('http://example.com/file.mp4')).rejects.toMatchObject({
      code: 'UNSAFE_REMOTE_URL',
    });
  });

  it('rejects local and metadata targets', async () => {
    await expect(assertSafeRemoteUrl('https://127.0.0.1/video')).rejects.toMatchObject({
      code: 'UNSAFE_REMOTE_URL',
    });
    await expect(assertSafeRemoteUrl('https://metadata.google.internal/')).rejects.toMatchObject({
      code: 'UNSAFE_REMOTE_URL',
    });
  });
});
