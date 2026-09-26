import path from 'node:path';
import { resizeVideoOptionsSchema, type ResizeVideoOptions } from '@media/validation';
import { InvalidMediaError } from '../../services/media.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * `resize-video`: probe the (single) input for a real video stream, then scale
 * it per the requested width/height (at least one always present — see
 * `resizeVideoOptionsSchema`), producing an H.264/AAC MP4 that fits the
 * requested bounds without distortion. Mirrors `convertToMp4Handler`'s shape
 * exactly — this handler owns only the resize-specific option and
 * output-naming details.
 */
export const resizeVideoHandler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    return resizeVideoOptionsSchema.parse(raw);
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      throw new InvalidMediaError('No input file was provided for this job');
    }
    const options = ctx.options as ResizeVideoOptions;

    const outputPath = path.join(ctx.outputDir, 'output.mp4');
    await ctx.mediaService.probe(input.path);
    await ctx.mediaService.resizeVideo(input.path, outputPath, options);

    return {
      outputPath,
      mimeType: 'video/mp4',
      fileName: deriveResizedFileName(input.fileName, options),
    };
  },
};

/**
 * Names the output after the *requested* dimensions, not the actual computed
 * ones — the actual output is always verifiable by viewing/probing the file
 * itself, and computing the true final dimensions here would need a second
 * ffprobe pass purely for a cosmetic file name. Still fully deterministic and
 * sanitized: derived only from the source's own base name plus already-validated
 * positive integers.
 */
function deriveResizedFileName(sourceFileName: string, options: ResizeVideoOptions): string {
  const { name } = path.parse(path.basename(sourceFileName));
  const base = name || 'video';
  if (options.width !== undefined && options.height !== undefined) {
    return `${base}-${options.width}x${options.height}.mp4`;
  }
  if (options.width !== undefined) {
    return `${base}-w${options.width}.mp4`;
  }
  return `${base}-h${options.height}.mp4`;
}
