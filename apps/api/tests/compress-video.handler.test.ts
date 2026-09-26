import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compressVideoHandler } from '../src/workers/operations/compress-video.handler.js';
import { InvalidMediaError, type MediaProbeResult, type MediaService } from '../src/services/media.service.js';
import type { OperationHandlerContext } from '../src/workers/operations/operation-handler.js';

const PROBE_RESULT: MediaProbeResult = { streams: [{ codecType: 'video', codecName: 'h264' }] };

function buildContext(overrides: Partial<OperationHandlerContext> = {}): {
  ctx: OperationHandlerContext;
  compressCalls: Array<{ inputPath: string; outputPath: string; quality: string }>;
} {
  const compressCalls: Array<{ inputPath: string; outputPath: string; quality: string }> = [];
  const mediaService: MediaService = {
    probe: async () => PROBE_RESULT,
    convertToMp4: async () => {
      throw new Error('compress-video must never call convertToMp4');
    },
    compressVideo: async (inputPath, outputPath, quality) => {
      compressCalls.push({ inputPath, outputPath, quality });
    },
    resizeVideo: async () => {
      throw new Error('compress-video must never call resizeVideo');
    },
    extractMp3: async () => {
      throw new Error('compress-video must never call extractMp3');
    },
    trimVideo: async () => {
      throw new Error('compress-video must never call trimVideo');
    },
    convertImageToPng: async () => {
      throw new Error('compress-video must never call convertImageToPng');
    },
  };
  return {
    ctx: {
      inputs: [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'holiday.mp4' }],
      options: { quality: 'balanced' },
      outputDir: '/tmp/out',
      mediaService,
      documentConversionService: {
        convertToPdf: async () => {
          throw new Error('compress-video must never call convertToPdf');
        },
      },
      ...overrides,
    },
    compressCalls,
  };
}

describe('compressVideoHandler.parseOptions', () => {
  it('accepts a valid quality preset', () => {
    expect(compressVideoHandler.parseOptions({ quality: 'high' })).toEqual({ quality: 'high' });
  });

  it('defaults to balanced when options is an empty object', () => {
    expect(compressVideoHandler.parseOptions({})).toEqual({ quality: 'balanced' });
  });

  it('defaults to balanced when options is entirely absent (undefined)', () => {
    expect(compressVideoHandler.parseOptions(undefined)).toEqual({ quality: 'balanced' });
  });

  it('rejects an invalid quality preset', () => {
    expect(() => compressVideoHandler.parseOptions({ quality: 'ultra' })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => compressVideoHandler.parseOptions({ quality: 'high', bitrate: '500k' })).toThrow();
  });
});

describe('compressVideoHandler.run', () => {
  it('probes the input, then calls MediaService.compressVideo with the parsed quality', async () => {
    const { ctx, compressCalls } = buildContext({ options: { quality: 'high' } });

    const output = await compressVideoHandler.run(ctx);

    expect(compressCalls).toEqual([{ inputPath: '/tmp/input-0', outputPath: output.outputPath, quality: 'high' }]);
  });

  it('returns video/mp4 output with a "-compressed" suffixed file name', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/quicktime', fileName: 'my clip.mov' }];

    const output = await compressVideoHandler.run(ctx);

    expect(output.mimeType).toBe('video/mp4');
    expect(output.fileName).toBe('my clip-compressed.mp4');
    // path.join normalizes separators per-platform (e.g. backslashes on
    // Windows), so assert on the joined basename rather than raw substring
    // containment of ctx.outputDir.
    expect(path.basename(output.outputPath)).toBe('output.mp4');
  });

  it('throws InvalidMediaError when no input is provided', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [];

    await expect(compressVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });

  it('lets a probe-thrown InvalidMediaError propagate unmodified', async () => {
    const { ctx } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        throw new InvalidMediaError('no video stream');
      },
    };

    await expect(compressVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });
});
