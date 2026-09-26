import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveTrimRange,
  trimVideoHandler,
} from '../src/workers/operations/trim-video.handler.js';
import {
  InvalidMediaError,
  MediaConversionError,
  TrimRangeError,
  type MediaProbeResult,
  type MediaService,
  type TrimRange,
} from '../src/services/media.service.js';
import type { OperationHandlerContext } from '../src/workers/operations/operation-handler.js';

const SOURCE_DURATION = 60;
const VIDEO_PROBE: MediaProbeResult = {
  durationSeconds: SOURCE_DURATION,
  streams: [{ codecType: 'video', codecName: 'h264' }],
};
const OUTPUT_PROBE: MediaProbeResult = {
  durationSeconds: 5,
  streams: [{ codecType: 'video', codecName: 'h264' }],
};

function buildContext(overrides: Partial<OperationHandlerContext> = {}): {
  ctx: OperationHandlerContext;
  trimCalls: Array<{ inputPath: string; outputPath: string; range: TrimRange }>;
  probedPaths: string[];
} {
  const trimCalls: Array<{ inputPath: string; outputPath: string; range: TrimRange }> = [];
  const probedPaths: string[] = [];
  const mediaService: MediaService = {
    // First probe is the source, later ones are the trimmed output.
    probe: async (inputPath) => {
      probedPaths.push(inputPath);
      return probedPaths.length === 1 ? VIDEO_PROBE : OUTPUT_PROBE;
    },
    convertToMp4: async () => {
      throw new Error('trim-video must never call convertToMp4');
    },
    compressVideo: async () => {
      throw new Error('trim-video must never call compressVideo');
    },
    resizeVideo: async () => {
      throw new Error('trim-video must never call resizeVideo');
    },
    extractMp3: async () => {
      throw new Error('trim-video must never call extractMp3');
    },
    trimVideo: async (inputPath, outputPath, range) => {
      trimCalls.push({ inputPath, outputPath, range });
    },
    convertImageToPng: async () => {
      throw new Error('trim-video must never call convertImageToPng');
    },
  };
  return {
    ctx: {
      inputs: [{ path: '/tmp/input-0', mimeType: 'video/mp4', fileName: 'holiday.mp4' }],
      options: { start: 10, end: 20 },
      outputDir: '/tmp/out',
      mediaService,
      documentConversionService: {
        convertToPdf: async () => {
          throw new Error('trim-video must never call convertToPdf');
        },
      },
      ...overrides,
    },
    trimCalls,
    probedPaths,
  };
}

describe('trimVideoHandler.parseOptions', () => {
  it('accepts start + end', () => {
    expect(trimVideoHandler.parseOptions({ start: 1, end: 5 })).toEqual({ start: 1, end: 5 });
  });

  it('accepts start + duration', () => {
    expect(trimVideoHandler.parseOptions({ start: 1, duration: 4 })).toEqual({
      start: 1,
      duration: 4,
    });
  });

  it('rejects absent options entirely (a start is always required)', () => {
    expect(() => trimVideoHandler.parseOptions(undefined)).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => trimVideoHandler.parseOptions({ start: 1, end: 5, codec: 'copy' })).toThrow();
  });
});

describe('trimVideoHandler.run', () => {
  it('probes the input, trims the resolved window, then verifies the output', async () => {
    const { ctx, trimCalls, probedPaths } = buildContext();

    const output = await trimVideoHandler.run(ctx);

    expect(trimCalls).toEqual([
      {
        inputPath: '/tmp/input-0',
        outputPath: output.outputPath,
        range: { startSeconds: 10, durationSeconds: 10 },
      },
    ]);
    expect(probedPaths).toEqual(['/tmp/input-0', output.outputPath]);
  });

  it('converts an end time into a duration (end - start) for MediaService', async () => {
    const { ctx, trimCalls } = buildContext({ options: { start: 12.5, end: 20 } });

    await trimVideoHandler.run(ctx);

    expect(trimCalls[0]?.range).toEqual({ startSeconds: 12.5, durationSeconds: 7.5 });
  });

  it('passes a requested duration through unchanged', async () => {
    const { ctx, trimCalls } = buildContext({ options: { start: 3, duration: 4.25 } });

    await trimVideoHandler.run(ctx);

    expect(trimCalls[0]?.range).toEqual({ startSeconds: 3, durationSeconds: 4.25 });
  });

  it('returns video/mp4 output with a "-trimmed.mp4" suffixed file name', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [{ path: '/tmp/input-0', mimeType: 'video/quicktime', fileName: 'my clip.mov' }];

    const output = await trimVideoHandler.run(ctx);

    expect(output.mimeType).toBe('video/mp4');
    expect(output.fileName).toBe('my clip-trimmed.mp4');
    expect(path.basename(output.outputPath)).toBe('output.mp4');
  });

  it('throws InvalidMediaError when no input is provided', async () => {
    const { ctx } = buildContext();
    ctx.inputs = [];

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
  });

  it('lets a source-probe InvalidMediaError propagate (no video stream at all) without trimming', async () => {
    const { ctx, trimCalls } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        throw new InvalidMediaError('no video stream');
      },
    };

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(InvalidMediaError);
    expect(trimCalls).toHaveLength(0);
  });

  it('throws a permanent TrimRangeError, without trimming, when the start is past the end of the source', async () => {
    const { ctx, trimCalls } = buildContext({ options: { start: 75, end: 90 } });

    // One run, asserted twice: the probe fake is stateful (source first, output
    // after), so a second run on the same context would probe a different file.
    const failure = trimVideoHandler.run(ctx);
    await expect(failure).rejects.toThrow(TrimRangeError);
    // Still an InvalidMediaError, i.e. still permanent/non-retried.
    await expect(failure).rejects.toThrow(InvalidMediaError);
    expect(trimCalls).toHaveLength(0);
  });

  it('throws TrimRangeError when the start is exactly the end of the source', async () => {
    const { ctx, trimCalls } = buildContext({ options: { start: SOURCE_DURATION, duration: 5 } });

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(TrimRangeError);
    expect(trimCalls).toHaveLength(0);
  });

  it('clamps an end past the source to the end of the video', async () => {
    const { ctx, trimCalls } = buildContext({ options: { start: 50, end: 500 } });

    await trimVideoHandler.run(ctx);

    expect(trimCalls[0]?.range).toEqual({ startSeconds: 50, durationSeconds: 10 });
  });

  it('propagates a MediaConversionError from the trim itself, without verifying any output', async () => {
    const { ctx, probedPaths } = buildContext();
    ctx.mediaService = {
      ...ctx.mediaService,
      trimVideo: async () => {
        throw new MediaConversionError('ffmpeg failed to trim the input file');
      },
    };

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(MediaConversionError);
    expect(probedPaths).toHaveLength(1);
  });

  it('converts an output the probe rejects as not-a-video into a TrimRangeError (FFmpeg exited 0 but encoded nothing)', async () => {
    const { ctx } = buildContext();
    let calls = 0;
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        calls += 1;
        if (calls === 1) return VIDEO_PROBE;
        throw new InvalidMediaError('The input file has no video stream');
      },
    };

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(TrimRangeError);
  });

  it('throws TrimRangeError when the output reports a zero duration', async () => {
    const { ctx } = buildContext();
    let calls = 0;
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        calls += 1;
        return calls === 1
          ? VIDEO_PROBE
          : { durationSeconds: 0, streams: [{ codecType: 'video' }] };
      },
    };

    await expect(trimVideoHandler.run(ctx)).rejects.toThrow(TrimRangeError);
  });

  it('does not treat a non-InvalidMediaError output-probe failure as a range problem (it stays transient)', async () => {
    const { ctx } = buildContext();
    let calls = 0;
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        calls += 1;
        if (calls === 1) return VIDEO_PROBE;
        throw new Error('ENOSPC');
      },
    };

    const failure = trimVideoHandler.run(ctx);
    await expect(failure).rejects.toThrow('ENOSPC');
    await expect(failure).rejects.not.toBeInstanceOf(TrimRangeError);
  });

  it('accepts an output whose duration is unknown (ffprobe reported none) rather than failing a good trim', async () => {
    const { ctx } = buildContext();
    let calls = 0;
    ctx.mediaService = {
      ...ctx.mediaService,
      probe: async () => {
        calls += 1;
        return calls === 1 ? VIDEO_PROBE : { streams: [{ codecType: 'video' }] };
      },
    };

    await expect(trimVideoHandler.run(ctx)).resolves.toMatchObject({ mimeType: 'video/mp4' });
  });
});

describe('resolveTrimRange', () => {
  it('start + end inside the source is the exact requested window', () => {
    expect(resolveTrimRange({ start: 5, end: 15 }, 60)).toEqual({
      startSeconds: 5,
      durationSeconds: 10,
    });
  });

  it('a duration that fits inside the source is unchanged', () => {
    expect(resolveTrimRange({ start: 5, duration: 10 }, 60)).toEqual({
      startSeconds: 5,
      durationSeconds: 10,
    });
  });

  it('a window that ends exactly at the source end is unchanged', () => {
    expect(resolveTrimRange({ start: 50, end: 60 }, 60)).toEqual({
      startSeconds: 50,
      durationSeconds: 10,
    });
  });

  it('clamps a window that runs past the source end to the remaining length', () => {
    expect(resolveTrimRange({ start: 55, duration: 30 }, 60)).toEqual({
      startSeconds: 55,
      durationSeconds: 5,
    });
  });

  it('rejects a start at the end of the source', () => {
    expect(() => resolveTrimRange({ start: 60, duration: 5 }, 60)).toThrow(TrimRangeError);
  });

  it('rejects a start past the end of the source', () => {
    expect(() => resolveTrimRange({ start: 61, end: 70 }, 60)).toThrow(TrimRangeError);
  });

  it('rejects a start that leaves less than the 0.1 s minimum of video', () => {
    expect(() => resolveTrimRange({ start: 59.95, duration: 5 }, 60)).toThrow(TrimRangeError);
  });

  it('accepts a start that leaves exactly the 0.1 s minimum despite float error (10 - 9.9)', () => {
    const range = resolveTrimRange({ start: 9.9, duration: 5 }, 10);
    expect(range.startSeconds).toBe(9.9);
    expect(range.durationSeconds).toBeCloseTo(0.1, 6);
  });

  it('with an unknown source length, passes the requested window through unchanged', () => {
    expect(resolveTrimRange({ start: 500, end: 900 }, undefined)).toEqual({
      startSeconds: 500,
      durationSeconds: 400,
    });
  });
});
