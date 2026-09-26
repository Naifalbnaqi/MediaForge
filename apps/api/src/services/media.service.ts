import type { CompressVideoQuality, ExtractMp3Quality, ResizeVideoOptions } from '@media/validation';

export interface MediaProbeResult {
  durationSeconds?: number;
  format?: string;
  streams: ReadonlyArray<{ codecType: string; codecName?: string }>;
}

/**
 * Port for the FFmpeg/FFprobe adapter, implemented by
 * `infrastructure/media/ffmpeg-media.service.ts` and consumed by the standalone
 * media-processing worker (`workers/media-processing.worker.ts`). `probe()` and
 * every operation method below are real, content-based operations — the *only*
 * trustworthy signal of what a file actually is, as opposed to its (client-supplied,
 * unverified) declared MIME type.
 *
 * Every method here is operation-specific and takes only already-validated,
 * narrowly-typed parameters (a quality preset name, validated dimensions) — this
 * interface deliberately has no generic public `runFfmpeg(args: string[])` escape
 * hatch, and implementations must never accept or forward caller-supplied FFmpeg
 * flags.
 */
export interface MediaService {
  probe(inputPath: string): Promise<MediaProbeResult>;
  /**
   * Converts the video at `inputPath` to a standard H.264/AAC MP4 at `outputPath`,
   * using a single fixed, non-configurable encoding preset — the original
   * "convert to MP4" operation, unchanged by later operations being added here.
   */
  convertToMp4(inputPath: string, outputPath: string): Promise<void>;
  /**
   * Re-encodes the video at `inputPath` to a browser-friendly H.264/AAC MP4 at
   * `outputPath` using the fixed CRF/preset/audio-bitrate settings for the given
   * named `quality` preset (see `resolveCompressVideoPreset` in the FFmpeg
   * adapter for the exact values). Audio is preserved when present; the fixed
   * argument array is safe to run against an input with no audio stream at all
   * (FFmpeg simply has nothing to encode on that track), so callers never need
   * to branch on whether the source has audio.
   */
  compressVideo(inputPath: string, outputPath: string, quality: CompressVideoQuality): Promise<void>;
  /**
   * Re-encodes the video at `inputPath` to a browser-friendly H.264/AAC MP4 at
   * `outputPath`, scaled per `options` (already validated to have at least one
   * of `width`/`height` by `resizeVideoOptionsSchema`): a single dimension
   * scales the other automatically preserving aspect ratio, both dimensions
   * fit the video inside that box preserving aspect ratio (never stretching).
   * The adapter always rounds computed dimensions to a multiple of 2, since
   * H.264/yuv420p requires even width and height.
   */
  resizeVideo(inputPath: string, outputPath: string, options: ResizeVideoOptions): Promise<void>;
  /**
   * Extracts/encodes the audio track of the video at `inputPath` to a standalone
   * MP3 file at `outputPath`, using the fixed bitrate/VBR settings for the given
   * named `quality` preset (see `resolveExtractMp3Preset` in the FFmpeg adapter
   * for the exact values). Callers must confirm an audio stream exists (via
   * `probe()`) *before* calling this — unlike `compressVideo`/`resizeVideo`,
   * there is no sensible output for a source with no audio at all, so this
   * method does not itself guard against that case.
   */
  extractMp3(inputPath: string, outputPath: string, quality: ExtractMp3Quality): Promise<void>;
  /**
   * Cuts the section of the video at `inputPath` that starts at
   * `range.startSeconds` and runs for `range.durationSeconds`, re-encoding it to
   * a browser-friendly H.264/AAC MP4 at `outputPath` (re-encoded rather than
   * stream-copied so the cut is frame-accurate, not snapped to a keyframe, and
   * the output codec/container is the same whatever the source was). Audio is
   * preserved when present and simply absent when the source has none.
   *
   * The range must already be validated and resolved by the caller: both values
   * finite, `startSeconds >= 0`, `durationSeconds > 0`, and — because only the
   * caller has probed the file — clamped to the source's real length. This
   * method takes a start and a *duration* (never an end time) so there is a
   * single, unambiguous meaning to pass to FFmpeg.
   */
  trimVideo(inputPath: string, outputPath: string, range: TrimRange): Promise<void>;
  /**
   * Converts a WebP image at `inputPath` to a PNG at `outputPath`. `image-to-pdf`'s
   * only use of this method: PDF embedding (via `pdf-lib`) natively supports JPEG
   * and PNG but not WebP, so a WebP input is transcoded to PNG first. Reuses the
   * FFmpeg binary already installed for every other operation rather than adding a
   * new image-decoding dependency.
   */
  convertImageToPng(inputPath: string, outputPath: string): Promise<void>;
}

/** A resolved trim window: where to start and how long to keep, in seconds. */
export interface TrimRange {
  startSeconds: number;
  durationSeconds: number;
}

/**
 * Thrown by `probe()` when the input file is corrupt, unreadable, has no streams at
 * all, or has no video stream (this phase's only operation requires one). This is a
 * permanent, content-based rejection — retrying the exact same file will fail
 * identically, so callers should record it as a terminal job failure, not retry it.
 * `cause` carries the original error/stderr for server-side diagnostics only; callers
 * must never surface it to a client or persist it as a job's user-facing error message.
 */
export class InvalidMediaError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'InvalidMediaError';
  }
}

/**
 * Thrown by an operation that needs an audio track (`extract-mp3`) when the
 * source video has none. Still a permanent, content-based rejection — it
 * extends `InvalidMediaError`, so any generic `InvalidMediaError` handling
 * keeps working — but distinguished so the worker can persist an accurate,
 * user-actionable message. The generic `InvalidMediaError` message ("could not
 * be processed as a valid video") would be wrong here: the file *is* a valid
 * video, it simply has no audio to extract. Like every media error, this
 * error's own `message` is for server-side diagnostics only; the worker
 * persists a fixed, safe message instead.
 */
export class NoAudioStreamError extends InvalidMediaError {
  public constructor(message = 'The input file has no audio stream', cause?: unknown) {
    super(message, cause);
    this.name = 'NoAudioStreamError';
  }
}

/**
 * Thrown by `trim-video` when the requested window contains no video: the start
 * time is at or past the end of the source, or the trim ran but produced no
 * usable video. Still a permanent, content-based rejection — it extends
 * `InvalidMediaError`, so generic handling keeps working — but distinguished so
 * the worker can persist an accurate, user-actionable message; the generic
 * "not a valid video" text would be wrong for a valid video whose length simply
 * doesn't include the requested start. Like every media error, this error's own
 * `message` is for server-side diagnostics only.
 */
export class TrimRangeError extends InvalidMediaError {
  public constructor(message = 'The requested trim range contains no video', cause?: unknown) {
    super(message, cause);
    this.name = 'TrimRangeError';
  }
}

/**
 * Thrown by `image-to-pdf` when one of the job's input files cannot actually be
 * used as an image: FFmpeg failed to transcode a declared WebP input, or
 * `pdf-lib` rejected the bytes as JPEG/PNG. Still a permanent, content-based
 * rejection — extends `InvalidMediaError` so generic handling keeps working —
 * but distinguished so the worker can persist an accurate, image-specific
 * message rather than the generic "not a valid video" text, which would be
 * wrong here. Like every media error, this error's own `message` is for
 * server-side diagnostics only.
 */
export class InvalidImageError extends InvalidMediaError {
  public constructor(message = 'The input file is not a valid image', cause?: unknown) {
    super(message, cause);
    this.name = 'InvalidImageError';
  }
}

/**
 * Thrown by `convertToMp4()` when FFmpeg exits non-zero or times out. Like
 * `InvalidMediaError`, this is a permanent failure for this specific input — the
 * command is fixed and deterministic, so re-running it against the same file produces
 * the same failure. `cause` is for server-side diagnostics only, same caveat as above.
 */
export class MediaConversionError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'MediaConversionError';
  }
}
