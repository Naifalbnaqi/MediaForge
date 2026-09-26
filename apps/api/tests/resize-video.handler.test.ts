import { describe, expect, it } from 'vitest';
import { resizeVideoHandler } from '../src/workers/operations/resize-video.handler.js';
import { InvalidMediaError, type MediaProbeResult, type MediaService } from '../src/services/media.service.js';
import type { OperationHandlerContext } from '../src/workers/operations/operation-handler.js';

const PROBE_RESULT: MediaProbeResult = { streams: [{ codecType: 'video', codecName: 'h264' }] };

function buildContext(overrides: Partial<OperationHandlerContext> = {}): {
  ctx: OperationHandlerContext;
  resizeCalls: Array<{ inputPath: string; outputPath: string; options: unknown }>;
} {
  const resizeCalls: Array<{ inputPath: string; outputPath: string; options: unknown }> = [];
  const mediaService: MediaService = {
    probe: async () => PROBE_RESULT,
    convertToMp4: async () => {
      throw new Error('resize-video must never call convertToMp4');
    },
    compressVideo: async () => {
      throw new Error('resize-video must never call compressVideo');
    },
    resizeVideo: async (inputPath, outputPath, options) => {
      resizeCalls.push({ inputPath, outputPath, options });
    },
    extractMp3: async () => {
      throw new Error('resize-video must never call extractMp3');
    },
    trimVideo: async () => {
      throw new Error('resize-video must never call trimVideo');
    },
    convertImageToPng: async () => {
      throw new Error('resize-video must never call convertImageToPng');
    },
  };
  return {
    ctx: {
      inputs: [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'holiday.mp4' }],
      options: { width: 1280 },
      outputDir: '/tmp/out',
      mediaService,
      documentConversionService: {
        convertToPdf: async () => {
          throw new Error('resize-video must never call convertToPdf');
        },
      },
      ...overrides,
    },
    resizeCalls,
  };
}

describe('resizeVideoHandler.parseOptions', () => {
  it('accepts width only', () => {
    expect(resizeVideoHandler.parseOptions({ width: 1280 })).toEqual({ width: 1280 });
  });

  it('accepts height only', () => {
    expect(resizeVideoHandler.parseOptions({ height: 720 })).toEqual({ height: 720 });
  });

  it('accepts width and height together', () => {
    expect(resizeVideoHandler.parseOptions({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it('rejects missing dimensions (neither width nor height)', () => {
    expect(() => resizeVideoHandler.parseOptions({})).toThrow();
  });

  it('rejects a zero dimension', () => {
    expect(() => resizeVideoHandler.parseOptions({ width: 0 })).toThrow();
  });

  it('rejects a negative dimension', () => {
    expect(() => resizeVideoHandler.parseOptions({ width: -100 })).toThrow();
  });

  it('rejects a dimension above the configured maximum', () => {
    expect(() => resizeVideoHandler.parseOptions({ width: 7681 })).toThrow();
  });

  it('accepts a dimension exactly at the configured maximum', () => {
    expect(resizeVideoHandler.parseOptions({ width: 7680 })).toEqual({ width: 7680 });
  });

  it('rejects an unrecognised option key', () => {
    expect(() => resizeVideoHandler.parseOptions({ width: 1280, stretch: true })).toThrow();
  });

  it('rejects a non-integer dimension', () => {
    expect(() => resizeVideoHandler.parseOptions({ width: 1280.5 })).toThrow();
  });
});

describe('resizeVideoHandler.run', () => {
  it('probes the input, then calls MediaService.resizeVideo with the parsed dimensions', async () => {
    const { ctx, resizeCalls } = buildContext({ options: { width: 1280, height: 720 } });

    const output = await resizeVideoHandler.run(ctx);

    expect(resizeCalls).toEqual([
      { inputPath: '/tmp/input-0', outputPath: output.outputPath, options: { width: 1280, height: 720 } },
    ]);
  });

  it('names the output "-WxH" when both dimensions are given', async () => {
    const { ctx } = buildContext({ options: { width: 1280, height: 720 } });
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'clip.mp4' }];

    const output = await resizeVideoHandler.run(ctx);

    expect(output.mimeType).toBe('video/mp4');
    expect(output.fileName).toBe('clip-1280x720.mp4');
  });

  it('names the output "-w{width}" when only width is given', async () => {
    const { ctx } = buildContext({ options: { width: 1280 } });
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'clip.mp4' }];

    const output = await resizeVideoHandler.run(ctx);

    expect(output.fileName).toBe('clip-w1280.mp4');
  });

  it('names the output "-h{height}" when only height is given', async () => {
    const { ctx } = buildContext({ options: { height: 720 } });
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'clip.mp4' }];

    const output = await resizeVideoHandler.run(ctx);

    expect(output.fileName).toBe('clip-h720.mp4');
  });

  it('throws InvalidMediaError when no input is provided', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [];

    await expect(resizeVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });

  it('lets a probe-thrown InvalidMediaError propagate unmodified', async () => {
    const { ctx } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        throw new InvalidMediaError('no video stream');
      },
    };

    await expect(resizeVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });
});
