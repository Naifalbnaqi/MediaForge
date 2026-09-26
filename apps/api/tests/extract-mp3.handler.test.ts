import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMp3Handler } from '../src/workers/operations/extract-mp3.handler.js';
import {
  InvalidMediaError,
  NoAudioStreamError,
  type MediaProbeResult,
  type MediaService,
} from '../src/services/media.service.js';
import type { OperationHandlerContext } from '../src/workers/operations/operation-handler.js';

const PROBE_RESULT_WITH_AUDIO: MediaProbeResult = {
  streams: [
    { codecType: 'video', codecName: 'h264' },
    { codecType: 'audio', codecName: 'aac' },
  ],
};

const PROBE_RESULT_NO_AUDIO: MediaProbeResult = {
  streams: [{ codecType: 'video', codecName: 'h264' }],
};

function buildContext(overrides: Partial<OperationHandlerContext> = {}): {
  ctx: OperationHandlerContext;
  extractCalls: Array<{ inputPath: string; outputPath: string; quality: string }>;
} {
  const extractCalls: Array<{ inputPath: string; outputPath: string; quality: string }> = [];
  const mediaService: MediaService = {
    probe: async () => PROBE_RESULT_WITH_AUDIO,
    convertToMp4: async () => {
      throw new Error('extract-mp3 must never call convertToMp4');
    },
    compressVideo: async () => {
      throw new Error('extract-mp3 must never call compressVideo');
    },
    resizeVideo: async () => {
      throw new Error('extract-mp3 must never call resizeVideo');
    },
    extractMp3: async (inputPath, outputPath, quality) => {
      extractCalls.push({ inputPath, outputPath, quality });
    },
    trimVideo: async () => {
      throw new Error('extract-mp3 must never call trimVideo');
    },
    convertImageToPng: async () => {
      throw new Error('extract-mp3 must never call convertImageToPng');
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
          throw new Error('extract-mp3 must never call convertToPdf');
        },
      },
      ...overrides,
    },
    extractCalls,
  };
}

describe('extractMp3Handler.parseOptions', () => {
  it('accepts a valid quality preset', () => {
    expect(extractMp3Handler.parseOptions({ quality: 'high' })).toEqual({ quality: 'high' });
  });

  it('defaults to balanced when options is an empty object', () => {
    expect(extractMp3Handler.parseOptions({})).toEqual({ quality: 'balanced' });
  });

  it('defaults to balanced when options is entirely absent (undefined)', () => {
    expect(extractMp3Handler.parseOptions(undefined)).toEqual({ quality: 'balanced' });
  });

  it('rejects an invalid quality preset', () => {
    expect(() => extractMp3Handler.parseOptions({ quality: 'ultra' })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => extractMp3Handler.parseOptions({ quality: 'high', bitrate: '500k' })).toThrow();
  });
});

describe('extractMp3Handler.run', () => {
  it('probes the input, then calls MediaService.extractMp3 with the parsed quality', async () => {
    const { ctx, extractCalls } = buildContext({ options: { quality: 'high' } });

    const output = await extractMp3Handler.run(ctx);

    expect(extractCalls).toEqual([{ inputPath: '/tmp/input-0', outputPath: output.outputPath, quality: 'high' }]);
  });

  it('returns audio/mpeg output with a "-audio.mp3" suffixed file name', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/quicktime', fileName: 'my clip.mov' }];

    const output = await extractMp3Handler.run(ctx);

    expect(output.mimeType).toBe('audio/mpeg');
    expect(output.fileName).toBe('my clip-audio.mp3');
    expect(path.basename(output.outputPath)).toBe('output.mp3');
  });

  it('throws InvalidMediaError when no input is provided', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [];

    await expect(extractMp3Handler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });

  it('lets a probe-thrown InvalidMediaError propagate unmodified (e.g. no video stream at all)', async () => {
    const { ctx } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        throw new InvalidMediaError('no video stream');
      },
    };

    await expect(extractMp3Handler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });

  it('throws a permanent InvalidMediaError — not a fake/empty MP3 — when the source has no audio stream', async () => {
    const extractCalls: Array<unknown> = [];
    const { ctx } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => PROBE_RESULT_NO_AUDIO,
      extractMp3: async (...args) => {
        extractCalls.push(args);
      },
    };

    // A dedicated error type (so the worker can persist an accurate message),
    // which is still an InvalidMediaError — i.e. still permanent/non-retried.
    await expect(extractMp3Handler.run(ctx)).rejects.toThrow(NoAudioStreamError);
    await expect(extractMp3Handler.run(ctx)).rejects.toThrow(InvalidMediaError);
    await expect(extractMp3Handler.run(ctx)).rejects.toThrow(/no audio stream/i);
    // Never falls through to actually running the encoder against a source
    // with nothing to encode.
    expect(extractCalls).toHaveLength(0);
  });
});
