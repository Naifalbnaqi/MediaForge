import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as FfmpegMediaServiceModule from '../src/infrastructure/media/ffmpeg-media.service.js';

/**
 * Mocks `node:child_process`'s `execFile` so these tests exercise the *real*
 * `FfmpegMediaService` argument-construction logic (not a hand-rolled fake of
 * the class itself) without needing a real `ffmpeg`/`ffprobe` binary on the
 * test host. Each test captures the exact argument array FfmpegMediaService
 * would hand to `child_process.execFile` — the actual FFmpeg invocation is
 * verified separately against real binaries during Docker acceptance testing.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

let FfmpegMediaService: typeof FfmpegMediaServiceModule.FfmpegMediaService;
let resolveCompressVideoPreset: typeof FfmpegMediaServiceModule.resolveCompressVideoPreset;
let buildResizeScaleFilter: typeof FfmpegMediaServiceModule.buildResizeScaleFilter;
let resolveExtractMp3Bitrate: typeof FfmpegMediaServiceModule.resolveExtractMp3Bitrate;
let formatTrimSeconds: typeof FfmpegMediaServiceModule.formatTrimSeconds;

beforeEach(async () => {
  execFileMock.mockReset();
  // promisify(execFile) expects a Node-style (err, stdout, stderr) callback as
  // the last argument — succeed immediately with empty output by default.
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
    const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
    (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
  });
  const mod = await import('../src/infrastructure/media/ffmpeg-media.service.js');
  FfmpegMediaService = mod.FfmpegMediaService;
  resolveCompressVideoPreset = mod.resolveCompressVideoPreset;
  buildResizeScaleFilter = mod.buildResizeScaleFilter;
  resolveExtractMp3Bitrate = mod.resolveExtractMp3Bitrate;
  formatTrimSeconds = mod.formatTrimSeconds;
});

describe('resolveCompressVideoPreset', () => {
  it('maps "high" to a low CRF, slow preset, and the highest audio bitrate', () => {
    expect(resolveCompressVideoPreset('high')).toEqual({ crf: 18, preset: 'slow', audioBitrate: '192k' });
  });

  it('maps "balanced" to x264\'s own default CRF and a medium preset', () => {
    expect(resolveCompressVideoPreset('balanced')).toEqual({ crf: 23, preset: 'medium', audioBitrate: '128k' });
  });

  it('maps "small" to a high CRF, fast preset, and the lowest audio bitrate', () => {
    expect(resolveCompressVideoPreset('small')).toEqual({ crf: 28, preset: 'fast', audioBitrate: '96k' });
  });

  it('orders CRF strictly high < balanced < small (higher CRF = smaller/more compressed)', () => {
    const high = resolveCompressVideoPreset('high');
    const balanced = resolveCompressVideoPreset('balanced');
    const small = resolveCompressVideoPreset('small');
    expect(high.crf).toBeLessThan(balanced.crf);
    expect(balanced.crf).toBeLessThan(small.crf);
  });
});

describe('buildResizeScaleFilter', () => {
  it('width only: scales width, derives height automatically with even rounding', () => {
    expect(buildResizeScaleFilter({ width: 1280 })).toBe('scale=1280:-2');
  });

  it('height only: scales height, derives width automatically with even rounding', () => {
    expect(buildResizeScaleFilter({ height: 720 })).toBe('scale=-2:720');
  });

  it('width + height: fits inside the box preserving aspect ratio, rounded to even', () => {
    expect(buildResizeScaleFilter({ width: 1280, height: 720 })).toBe(
      'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
    );
  });

  it('never uses a plain WxH scale that would stretch/distort the video', () => {
    const filter = buildResizeScaleFilter({ width: 1920, height: 1080 });
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(filter).not.toBe('scale=1920:1080');
  });
});

describe('FfmpegMediaService.compressVideo', () => {
  it('builds fixed args for the requested preset, preserving audio unconditionally', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.compressVideo('/tmp/in.mp4', '/tmp/out.mp4', 'balanced');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual([
      '-y',
      '-i',
      '/tmp/in.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);
  });

  it.each(['high', 'balanced', 'small'] as const)(
    'uses the exact resolved crf/preset/audioBitrate for the %s quality',
    async (quality) => {
      const service = new FfmpegMediaService('/usr/bin/ffmpeg');
      await service.compressVideo('/tmp/in.mp4', '/tmp/out.mp4', quality);

      const [, args] = execFileMock.mock.calls[0] as [string, string[]];
      const preset = resolveCompressVideoPreset(quality);
      expect(args).toContain(String(preset.crf));
      expect(args).toContain(preset.preset);
      expect(args).toContain(preset.audioBitrate);
    },
  );

  it('produces identical, unconditional args regardless of whether the source has audio — no branching on audio presence', async () => {
    // compressVideo takes no "has audio" signal at all: `-c:a aac` is always
    // present, and FFmpeg itself is what safely no-ops when there is nothing
    // to encode on the audio track. This test documents that contract.
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.compressVideo('/tmp/silent.mp4', '/tmp/out.mp4', 'high');
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
  });

  it('throws MediaConversionError, not a raw error, when ffmpeg exits non-zero', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
      const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
      (cb as (err: Error) => void)(new Error('ffmpeg exited with code 1'));
    });
    const { MediaConversionError } = await import('../src/services/media.service.js');
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');

    await expect(service.compressVideo('/tmp/in.mp4', '/tmp/out.mp4', 'balanced')).rejects.toThrow(
      MediaConversionError,
    );
  });

  it('never builds a shell-interpretable command string — only a structured argument array', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.compressVideo('/tmp/in; rm -rf /.mp4', '/tmp/out.mp4', 'balanced');

    // execFile (never exec/spawn with shell:true) receives each argument as a
    // distinct array element — a malicious-looking path is passed through
    // verbatim as one argument, never concatenated into a shell string.
    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args).toContain('/tmp/in; rm -rf /.mp4');
    expect(opts).not.toHaveProperty('shell', true);
  });
});

describe('FfmpegMediaService.resizeVideo', () => {
  it('builds fixed args with the computed scale filter for width-only', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.resizeVideo('/tmp/in.mp4', '/tmp/out.mp4', { width: 1280 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      '-y',
      '-i',
      '/tmp/in.mp4',
      '-vf',
      'scale=1280:-2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);
  });

  it('builds fixed args with the computed scale filter for height-only', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.resizeVideo('/tmp/in.mp4', '/tmp/out.mp4', { height: 720 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('scale=-2:720');
  });

  it('builds fixed args with the bounded-fit scale filter for width+height', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.resizeVideo('/tmp/in.mp4', '/tmp/out.mp4', { width: 1280, height: 720 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2');
  });

  it('preserves audio unconditionally, same as compressVideo/convertToMp4', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.resizeVideo('/tmp/in.mp4', '/tmp/out.mp4', { width: 640 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
  });

  it('throws MediaConversionError, not a raw error, when ffmpeg exits non-zero', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
      const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
      (cb as (err: Error) => void)(new Error('ffmpeg exited with code 1'));
    });
    const { MediaConversionError } = await import('../src/services/media.service.js');
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');

    await expect(service.resizeVideo('/tmp/in.mp4', '/tmp/out.mp4', { width: 1280 })).rejects.toThrow(
      MediaConversionError,
    );
  });
});

describe('resolveExtractMp3Bitrate', () => {
  it('maps "high" to 320k (the de facto MP3 maximum-quality ceiling)', () => {
    expect(resolveExtractMp3Bitrate('high')).toBe('320k');
  });

  it('maps "balanced" to 192k (a common general-purpose default)', () => {
    expect(resolveExtractMp3Bitrate('balanced')).toBe('192k');
  });

  it('maps "small" to 96k (a smaller, casual-listening tier)', () => {
    expect(resolveExtractMp3Bitrate('small')).toBe('96k');
  });

  it('orders bitrates strictly high > balanced > small', () => {
    const parse = (bitrate: string) => Number(bitrate.replace('k', ''));
    expect(parse(resolveExtractMp3Bitrate('high'))).toBeGreaterThan(parse(resolveExtractMp3Bitrate('balanced')));
    expect(parse(resolveExtractMp3Bitrate('balanced'))).toBeGreaterThan(parse(resolveExtractMp3Bitrate('small')));
  });
});

describe('FfmpegMediaService.extractMp3', () => {
  it('builds fixed args for the requested quality, dropping any video stream', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.extractMp3('/tmp/in.mp4', '/tmp/out.mp3', 'balanced');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual(['-y', '-i', '/tmp/in.mp4', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '/tmp/out.mp3']);
  });

  it.each(['high', 'balanced', 'small'] as const)(
    'uses the exact resolved bitrate for the %s quality',
    async (quality) => {
      const service = new FfmpegMediaService('/usr/bin/ffmpeg');
      await service.extractMp3('/tmp/in.mp4', '/tmp/out.mp3', quality);

      const [, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(args).toContain(resolveExtractMp3Bitrate(quality));
      expect(args).toContain('libmp3lame');
      expect(args).toContain('-vn');
    },
  );

  it('always includes -vn so the output is audio-only regardless of the source', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.extractMp3('/tmp/in.mp4', '/tmp/out.mp3', 'high');

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('-vn');
  });

  it('throws MediaConversionError, not a raw error, when ffmpeg exits non-zero', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
      const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
      (cb as (err: Error) => void)(new Error('ffmpeg exited with code 1'));
    });
    const { MediaConversionError } = await import('../src/services/media.service.js');
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');

    await expect(service.extractMp3('/tmp/in.mp4', '/tmp/out.mp3', 'balanced')).rejects.toThrow(
      MediaConversionError,
    );
  });

  it('never builds a shell-interpretable command string — only a structured argument array', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.extractMp3('/tmp/in; rm -rf /.mp4', '/tmp/out.mp3', 'balanced');

    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args).toContain('/tmp/in; rm -rf /.mp4');
    expect(opts).not.toHaveProperty('shell', true);
  });

  it('respects the given output path, preserving its extension', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.extractMp3('/tmp/in.mp4', '/tmp/custom-output.mp3', 'balanced');

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[args.length - 1]).toBe('/tmp/custom-output.mp3');
  });
});

describe('formatTrimSeconds', () => {
  it.each([
    [0, '0.000'],
    [10, '10.000'],
    [12.5, '12.500'],
    [0.1, '0.100'],
    [1.2346, '1.235'],
    [86_400, '86400.000'],
  ])('formats %s as the plain decimal %s', (seconds, expected) => {
    expect(formatTrimSeconds(seconds)).toBe(expected);
  });

  it('never produces exponent notation for a tiny or very large finite value', () => {
    expect(formatTrimSeconds(1e-7)).not.toMatch(/e/i);
    expect(formatTrimSeconds(1e21 / 1e6)).not.toMatch(/e/i);
  });
});

describe('FfmpegMediaService.trimVideo', () => {
  it('builds fixed args: seek before the input, then a duration, re-encoding to H.264/AAC MP4', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in.mp4', '/tmp/out.mp4', { startSeconds: 12.5, durationSeconds: 7 });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual([
      '-y',
      '-ss',
      '12.500',
      '-i',
      '/tmp/in.mp4',
      '-t',
      '7.000',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);
  });

  it('places -ss before -i (frame-accurate input seek when re-encoding) and -t after it', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in.mp4', '/tmp/out.mp4', { startSeconds: 3, durationSeconds: 4 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'));
  });

  it('re-encodes rather than stream-copying, so cuts are not snapped to a keyframe', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in.mp4', '/tmp/out.mp4', { startSeconds: 0, durationSeconds: 5 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('copy');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
  });

  it('never lets a caller-supplied value reach FFmpeg as anything but a formatted number', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in.mp4', '/tmp/out.mp4', { startSeconds: 1.5, durationSeconds: 2.25 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('-ss') + 1]).toMatch(/^\d+\.\d{3}$/);
    expect(args[args.indexOf('-t') + 1]).toMatch(/^\d+\.\d{3}$/);
  });

  it('throws MediaConversionError, not a raw error, when ffmpeg exits non-zero', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
      const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
      (cb as (err: Error) => void)(new Error('ffmpeg exited with code 1'));
    });
    const { MediaConversionError } = await import('../src/services/media.service.js');
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');

    await expect(
      service.trimVideo('/tmp/in.mp4', '/tmp/out.mp4', { startSeconds: 1, durationSeconds: 2 }),
    ).rejects.toThrow(MediaConversionError);
  });

  it('never builds a shell-interpretable command string — only a structured argument array', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in; rm -rf /.mp4', '/tmp/out.mp4', { startSeconds: 1, durationSeconds: 2 });

    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args).toContain('/tmp/in; rm -rf /.mp4');
    expect(opts).not.toHaveProperty('shell', true);
  });

  it('respects the given output path, preserving its extension', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.trimVideo('/tmp/in.mp4', '/tmp/custom-output.mp4', { startSeconds: 0, durationSeconds: 1 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[args.length - 1]).toBe('/tmp/custom-output.mp4');
  });
});

describe('FfmpegMediaService.convertImageToPng', () => {
  it('builds a fixed argument array: only -y, -i <input>, <output>', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.convertImageToPng('/tmp/in.webp', '/tmp/out.png');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual(['-y', '-i', '/tmp/in.webp', '/tmp/out.png']);
  });

  it('never builds a shell-interpretable command string — only a structured argument array', async () => {
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');
    await service.convertImageToPng('/tmp/in; rm -rf /.webp', '/tmp/out.png');

    const [, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args).toContain('/tmp/in; rm -rf /.webp');
    expect(opts).not.toHaveProperty('shell', true);
  });

  it('throws InvalidImageError, not MediaConversionError, when ffmpeg exits non-zero', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: unknown) => {
      const cb = typeof callback === 'function' ? callback : (_opts as (...cbArgs: unknown[]) => void);
      (cb as (err: Error) => void)(new Error('ffmpeg exited with code 1'));
    });
    const { InvalidImageError, MediaConversionError } = await import('../src/services/media.service.js');
    const service = new FfmpegMediaService('/usr/bin/ffmpeg');

    const error = await service
      .convertImageToPng('/tmp/in.webp', '/tmp/out.png')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidImageError);
    expect(error).not.toBeInstanceOf(MediaConversionError);
  });
});
