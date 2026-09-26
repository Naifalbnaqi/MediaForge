import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompressVideoQuality, ExtractMp3Quality, ResizeVideoOptions } from '@media/validation';
import {
  InvalidImageError,
  InvalidMediaError,
  MediaConversionError,
  type MediaProbeResult,
  type MediaService,
  type TrimRange,
} from '../../services/media.service.js';

const execFileAsync = promisify(execFile);

/**
 * FFprobe only reads container/stream metadata (it never decodes/transcodes frame
 * data), so this should be fast even for a large file — 30s is a generous ceiling for
 * a metadata-only read, not a transcode budget.
 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * FFmpeg conversion timeout. This is a real, current limitation, not a
 * dynamically-sized budget: 5 minutes is a conservative ceiling for the "veryfast"
 * libx264 preset used below against the platform's current MAX_UPLOAD_SIZE_BYTES
 * (500 MiB) ceiling on typical hardware. A very long or very high-resolution source
 * file could still legitimately exceed this and be killed — that tradeoff is
 * explicitly accepted for this phase rather than solved with per-file dynamic sizing.
 */
const CONVERT_TIMEOUT_MS = 5 * 60_000;

/**
 * `ffprobe -show_format -show_streams` JSON output can grow with stream/chapter count
 * far past Node's 1 MiB `execFile` default before Node kills the process for exceeding
 * `maxBuffer` — bump both generously so a well-formed (if unusual) file's normal
 * metadata output/FFmpeg log spam is never mistaken for a real failure.
 */
const PROBE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CONVERT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface CompressVideoPreset {
  crf: number;
  preset: string;
  audioBitrate: string;
}

/**
 * The exact, fixed FFmpeg settings behind each `compress-video` quality name —
 * documented here (and asserted directly in `ffmpeg-media.service.test.ts`) since
 * these are a real, load-bearing design choice, not arbitrary numbers:
 *
 * - CRF (libx264's Constant Rate Factor) is the primary quality/size lever: lower
 *   is higher quality and larger output, higher is more compressed and smaller.
 *   18 is commonly considered visually near-lossless, 23 is x264's own documented
 *   default (a reasonable general-purpose balance), 28 is noticeably more
 *   compressed but still acceptable for casual viewing — standard, well-documented
 *   reference points rather than arbitrary picks.
 * - `preset` trades encode *time* for compression *efficiency* at a given CRF
 *   (slower presets extract more quality/size out of the same CRF). "high"
 *   spends more time for the best result since the user explicitly opted into
 *   quality over speed; "small" prioritizes fast turnaround, since most of its
 *   size reduction already comes from the higher CRF, not a slower search.
 * - Audio bitrate is varied in step with the video quality tier for a
 *   consistent "high/balanced/small" feel end to end, not just on the video
 *   track.
 */
const COMPRESS_VIDEO_PRESETS: Record<CompressVideoQuality, CompressVideoPreset> = {
  high: { crf: 18, preset: 'slow', audioBitrate: '192k' },
  balanced: { crf: 23, preset: 'medium', audioBitrate: '128k' },
  small: { crf: 28, preset: 'fast', audioBitrate: '96k' },
};

export function resolveCompressVideoPreset(quality: CompressVideoQuality): CompressVideoPreset {
  return COMPRESS_VIDEO_PRESETS[quality];
}

/**
 * Builds the FFmpeg `-vf scale=...` filter value for `resize-video`, entirely
 * from already-validated numeric dimensions (see `resizeVideoOptionsSchema` —
 * positive integers, capped at `MAX_RESIZE_DIMENSION`), so string interpolation
 * here can never carry anything other than digits.
 *
 * - One dimension only: `-2` (not `-1`) for the other side — FFmpeg's scale
 *   filter treats `-2` as "compute automatically, preserving aspect ratio, and
 *   round to the nearest multiple of 2", which both derives the missing
 *   dimension and satisfies H.264/yuv420p's even-dimension requirement in one
 *   step.
 * - Both dimensions: `force_original_aspect_ratio=decrease` fits the video
 *   inside the requested box without stretching (scales down to whichever of
 *   width/height is the binding constraint, preserving aspect ratio) rather
 *   than forcing an exact, possibly-distorted WxH; `force_divisible_by=2`
 *   rounds the resulting computed dimensions to even, same reason as above.
 */
export function buildResizeScaleFilter(options: ResizeVideoOptions): string {
  const { width, height } = options;
  if (width !== undefined && height !== undefined) {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  }
  if (width !== undefined) {
    return `scale=${width}:-2`;
  }
  // resizeVideoOptionsSchema guarantees at least one of width/height is
  // present, so reaching here means height must be defined.
  return `scale=-2:${height}`;
}

/**
 * The exact, fixed MP3 (libmp3lame) bitrate behind each `extract-mp3` quality
 * name — documented here (and asserted directly in `ffmpeg-media.service.test.ts`)
 * since these are a real, load-bearing design choice, not arbitrary numbers.
 *
 * Fixed CBR bitrates rather than LAME's VBR quality scale (`-q:a`): the three
 * values are standard, widely-recognized MP3 bitrate tiers (320k is the
 * de facto "maximum quality" ceiling for MP3, 192k a very common
 * general-purpose default, 96k a noticeably smaller but still acceptable
 * casual-listening tier) with predictable, easy-to-reason-about output size
 * — a better fit for a simple named "high/balanced/small" preset than an
 * encoder-specific quality-scale number would be.
 */
const EXTRACT_MP3_BITRATES: Record<ExtractMp3Quality, string> = {
  high: '320k',
  balanced: '192k',
  small: '96k',
};

export function resolveExtractMp3Bitrate(quality: ExtractMp3Quality): string {
  return EXTRACT_MP3_BITRATES[quality];
}

/**
 * Formats a validated trim time as a plain decimal for FFmpeg's `-ss`/`-t`:
 * always three fractional digits (millisecond precision, more than a frame at
 * any real frame rate), never exponent notation. The values reaching here are
 * finite and bounded (`0..MAX_TRIM_SECONDS`, see `trimVideoOptionsSchema`), so
 * the result can only ever be digits and one decimal point.
 */
export function formatTrimSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

interface FfprobeStreamJson {
  codec_type?: string;
  codec_name?: string;
}

interface FfprobeOutputJson {
  format?: { duration?: string; format_name?: string };
  streams?: FfprobeStreamJson[];
}

/**
 * `MediaService` implemented against real `ffmpeg`/`ffprobe` binaries via
 * `child_process.execFile` — never `shell: true`, never a string-built command.
 * `inputPath`/`outputPath` are the only caller-supplied arguments to either command,
 * and both are always server-generated temp file paths (see
 * `workers/media-processing.worker.ts`), never derived from client input. Every other
 * argument element below is a hardcoded literal.
 */
export class FfmpegMediaService implements MediaService {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;

  /**
   * @param ffmpegPath Absolute or PATH-resolved path to the `ffmpeg` binary
   *   (`FFMPEG_PATH`, e.g. `/usr/bin/ffmpeg` in the Docker image, which installs both
   *   `ffmpeg` and `ffprobe` together via `apk add ffmpeg`).
   * @param ffprobePath Defaults to `ffprobePath`'s sibling in the same directory as
   *   `ffmpegPath` (same binary name, `ffprobe`) — avoids requiring a second env var
   *   for a binary that's always installed alongside `ffmpeg` in every environment this
   *   runs in today.
   */
  public constructor(ffmpegPath: string, ffprobePath?: string) {
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath ?? deriveFfprobePath(ffmpegPath);
  }

  public async probe(inputPath: string): Promise<MediaProbeResult> {
    // Fixed argument array — inputPath (a server-generated temp path, see the worker)
    // is the only variable element; everything else is a hardcoded literal.
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath];

    let stdout: string;
    try {
      const result = await execFileAsync(this.ffprobePath, args, {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      stdout = result.stdout;
    } catch (error) {
      // Covers a non-zero exit (corrupt/unreadable file), a timeout, or the binary
      // being missing/misconfigured — all treated the same: this input cannot be
      // probed. The raw stderr/exception is kept only on `cause` for server-side
      // diagnostics; it is never included in the thrown error's own `message`.
      throw new InvalidMediaError('ffprobe failed to analyze the input file', error);
    }

    let parsed: FfprobeOutputJson;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutputJson;
    } catch (error) {
      throw new InvalidMediaError('ffprobe produced output that could not be parsed as JSON', error);
    }

    const streams = parsed.streams ?? [];
    if (streams.length === 0) {
      throw new InvalidMediaError('The input file has no media streams');
    }
    // The real, authoritative "is this actually a video?" check — a client can label
    // any upload video/mp4 or video/quicktime regardless of the bytes it actually
    // sends (see the Content-Type-is-unsigned note in s3-storage.service.ts); this is
    // the first point anything inspects real content rather than a declared label.
    const hasVideoStream = streams.some((stream) => stream.codec_type === 'video');
    if (!hasVideoStream) {
      throw new InvalidMediaError('The input file has no video stream');
    }

    const durationSeconds = toFiniteNumber(parsed.format?.duration);
    const format = parsed.format?.format_name;

    return {
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(format ? { format } : {}),
      streams: streams.map((stream) => ({
        codecType: stream.codec_type ?? 'unknown',
        ...(stream.codec_name ? { codecName: stream.codec_name } : {}),
      })),
    };
  }

  public async convertToMp4(inputPath: string, outputPath: string): Promise<void> {
    // Fixed argument array for exactly one operation ("convert to MP4"). inputPath and
    // outputPath (both server-generated temp paths, see the worker) are the only
    // variable elements; no client-supplied flag, preset, or option is ever accepted
    // or forwarded here.
    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      // Non-zero exit or timeout — a permanent failure for this specific input (see
      // MediaConversionError's own doc comment). Raw stderr again kept only on `cause`.
      throw new MediaConversionError('ffmpeg failed to convert the input file to MP4', error);
    }
  }

  public async compressVideo(
    inputPath: string,
    outputPath: string,
    quality: CompressVideoQuality,
  ): Promise<void> {
    const { crf, preset, audioBitrate } = resolveCompressVideoPreset(quality);
    // Fixed argument array for exactly this operation: inputPath/outputPath are
    // server-generated temp paths (see the worker), and crf/preset/audioBitrate
    // come only from the fixed COMPRESS_VIDEO_PRESETS table above, keyed by a
    // Zod-validated enum — no client-supplied FFmpeg flag is ever accepted here.
    // `-c:a aac` is unconditional (same as convertToMp4): FFmpeg simply has
    // nothing to encode on that stream when the source has no audio, so this
    // never needs to branch on audio presence.
    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-c:a',
      'aac',
      '-b:a',
      audioBitrate,
      '-movflags',
      '+faststart',
      outputPath,
    ];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      throw new MediaConversionError('ffmpeg failed to compress the input file', error);
    }
  }

  public async resizeVideo(
    inputPath: string,
    outputPath: string,
    options: ResizeVideoOptions,
  ): Promise<void> {
    // The only variable element is the scale filter, itself built only from
    // already-validated positive integers (see buildResizeScaleFilter) — no
    // client-supplied FFmpeg flag is ever accepted here.
    const args = [
      '-y',
      '-i',
      inputPath,
      '-vf',
      buildResizeScaleFilter(options),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      throw new MediaConversionError('ffmpeg failed to resize the input file', error);
    }
  }

  public async extractMp3(
    inputPath: string,
    outputPath: string,
    quality: ExtractMp3Quality,
  ): Promise<void> {
    // Fixed argument array: inputPath/outputPath are server-generated temp
    // paths (see the worker), and the bitrate comes only from the fixed
    // EXTRACT_MP3_BITRATES table above, keyed by a Zod-validated enum — no
    // client-supplied FFmpeg flag is ever accepted here. `-vn` explicitly
    // drops any video stream so the output is audio-only regardless of
    // container quirks; the caller (extractMp3Handler) is responsible for
    // confirming an audio stream exists before calling this — this method
    // does not itself guard against a source with no audio.
    const args = [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      resolveExtractMp3Bitrate(quality),
      outputPath,
    ];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      throw new MediaConversionError('ffmpeg failed to extract audio from the input file', error);
    }
  }

  public async trimVideo(inputPath: string, outputPath: string, range: TrimRange): Promise<void> {
    // Fixed argument array: inputPath/outputPath are server-generated temp
    // paths (see the worker), and the two times come only from the validated,
    // bounded numbers in `range` via formatTrimSeconds — no client-supplied
    // FFmpeg flag is ever accepted here.
    //
    // `-ss` *before* `-i` seeks the input, then — because the video is
    // re-encoded — FFmpeg decodes from the preceding keyframe and discards
    // frames up to the exact start, so the cut is frame-accurate (a stream copy
    // would snap to a keyframe instead). `-t` is a duration measured from that
    // start. Re-encoded with the same H.264/AAC/faststart settings as
    // convertToMp4 (a MOV source therefore comes out as a normal MP4 too).
    // `-c:a aac` is unconditional: FFmpeg simply has nothing to encode when the
    // source has no audio, so this never needs to branch on audio presence.
    const args = [
      '-y',
      '-ss',
      formatTrimSeconds(range.startSeconds),
      '-i',
      inputPath,
      '-t',
      formatTrimSeconds(range.durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      throw new MediaConversionError('ffmpeg failed to trim the input file', error);
    }
  }

  public async convertImageToPng(inputPath: string, outputPath: string): Promise<void> {
    // Fixed argument array: inputPath/outputPath are server-generated temp paths
    // (see the worker). No client-supplied flag is ever accepted here. A
    // non-zero exit means the input was not decodable as an image at all (for
    // example a declared image/webp upload whose bytes are something else
    // entirely) — a content-based, permanent failure for this specific input,
    // signalled to the caller as `InvalidImageError`, never `MediaConversionError`.
    const args = ['-y', '-i', inputPath, outputPath];

    try {
      await execFileAsync(this.ffmpegPath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      throw new InvalidImageError('ffmpeg failed to convert the input image to PNG', error);
    }
  }
}

function toFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `ffprobe` is installed alongside `ffmpeg` in every environment this runs in today
 * (the Docker image's `apk add ffmpeg` provides both binaries in the same directory;
 * a bare `FFMPEG_PATH=ffmpeg` default similarly resolves `ffprobe` via the same PATH
 * lookup, since `path.join('.', 'ffprobe')` normalizes back down to the bare
 * `'ffprobe'`). Deriving avoids requiring a second required env var for a binary that
 * is never installed or configured independently of `ffmpeg` in practice.
 */
function deriveFfprobePath(ffmpegPath: string): string {
  return path.join(path.dirname(ffmpegPath), 'ffprobe');
}
