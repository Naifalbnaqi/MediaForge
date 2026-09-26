import path from 'node:path';
import {
  MIN_TRIM_DURATION_SECONDS,
  trimVideoOptionsSchema,
  type TrimVideoOptions,
} from '@media/validation';
import { InvalidMediaError, TrimRangeError, type TrimRange } from '../../services/media.service.js';
import type {
  OperationHandler,
  OperationHandlerContext,
  OperationOutput,
} from './operation-handler.js';

/** Float slack when comparing a resolved duration against the minimum (10 - 9.9
 * is 0.0999999999999996, which must still count as 0.1 of video). */
const RANGE_EPSILON = 1e-6;

/**
 * `trim-video`: probe the (single) input for a real video stream, resolve the
 * requested window against the source's real length, cut it with
 * `MediaService.trimVideo`, and confirm the result is real video. Mirrors
 * `resizeVideoHandler`'s shape — this handler owns only the trim-specific
 * option handling, range resolution and output naming; the generic worker
 * lifecycle (download/upload/record) never changes for a new operation.
 *
 * The request carries a start plus either an end or a duration (see
 * `trimVideoOptionsSchema`); everything below the option parsing works in
 * terms of one resolved `{ startSeconds, durationSeconds }` window, which is
 * also the only thing `MediaService` ever sees.
 *
 * Range policy (decided here because only this step has probed the file):
 * - an end/duration that runs past the source's end is *clamped* to the end of
 *   the video — "trim from 10 s to the end" needs no exact length from the
 *   user, and a permanently failed job is a dead end in the UI;
 * - a start at or beyond the end (or leaving less than the minimum duration)
 *   fails permanently with `TrimRangeError` — there is nothing to keep.
 * - if the source's length is unknown, the requested window is passed through
 *   unchanged and the output check below is the safety net.
 */
export const trimVideoHandler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    return trimVideoOptionsSchema.parse(raw);
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      throw new InvalidMediaError('No input file was provided for this job');
    }
    // Already validated by parseOptions before the worker ever calls run().
    const options = ctx.options as TrimVideoOptions;

    const probeResult = await ctx.mediaService.probe(input.path);
    const range = resolveTrimRange(options, probeResult.durationSeconds);

    const outputPath = path.join(ctx.outputDir, 'output.mp4');
    await ctx.mediaService.trimVideo(input.path, outputPath, range);
    await assertOutputHasVideo(ctx, outputPath);

    return {
      outputPath,
      mimeType: 'video/mp4',
      fileName: deriveTrimmedFileName(input.fileName),
    };
  },
};

/**
 * Turns the validated request (start + end *or* duration) and the source's
 * probed length (when known) into the one window FFmpeg is asked to cut.
 */
export function resolveTrimRange(
  options: TrimVideoOptions,
  sourceDurationSeconds: number | undefined,
): TrimRange {
  const startSeconds = options.start;
  const requestedSeconds = 'end' in options ? options.end - options.start : options.duration;

  if (sourceDurationSeconds === undefined) {
    return { startSeconds, durationSeconds: requestedSeconds };
  }

  const remainingSeconds = sourceDurationSeconds - startSeconds;
  if (remainingSeconds < MIN_TRIM_DURATION_SECONDS - RANGE_EPSILON) {
    throw new TrimRangeError(
      `Trim start ${startSeconds}s leaves ${Math.max(remainingSeconds, 0)}s of a ${sourceDurationSeconds}s source`,
    );
  }
  return { startSeconds, durationSeconds: Math.min(requestedSeconds, remainingSeconds) };
}

/**
 * FFmpeg can exit 0 having encoded nothing (a window that lands after the last
 * frame), so a clean exit alone doesn't prove the output is usable. The output
 * must probe as real video with a positive length; anything else means the
 * requested window held no video, which is the same permanent, user-actionable
 * `TrimRangeError` as a start past the end — never a "COMPLETED" job pointing
 * at an empty file.
 */
async function assertOutputHasVideo(
  ctx: OperationHandlerContext,
  outputPath: string,
): Promise<void> {
  let outputDurationSeconds: number | undefined;
  try {
    outputDurationSeconds = (await ctx.mediaService.probe(outputPath)).durationSeconds;
  } catch (error) {
    if (error instanceof InvalidMediaError) {
      throw new TrimRangeError('The trimmed output is not a valid video', error);
    }
    throw error;
  }
  if (outputDurationSeconds !== undefined && outputDurationSeconds <= 0) {
    throw new TrimRangeError('The trimmed output has no duration');
  }
}

/** Same safe-display-name derivation as the other handlers, suffixed to make
 * the operation that produced this file obvious to the user. */
function deriveTrimmedFileName(sourceFileName: string): string {
  const { name } = path.parse(path.basename(sourceFileName));
  return `${name || 'video'}-trimmed.mp4`;
}
