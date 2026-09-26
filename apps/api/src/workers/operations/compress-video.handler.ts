import path from 'node:path';
import { compressVideoOptionsSchema, type CompressVideoOptions } from '@media/validation';
import { InvalidMediaError } from '../../services/media.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * `compress-video`: probe the (single) input for a real video stream, then
 * re-encode it at the requested quality preset (defaulting to `'balanced'`),
 * producing a smaller/re-encoded H.264/AAC MP4. Mirrors `convertToMp4Handler`'s
 * shape exactly — this handler owns only the compress-specific option and
 * output-naming details; the generic worker lifecycle (download/upload/record)
 * never changes for a new operation.
 */
export const compressVideoHandler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    // `raw` is `{}` when a request omitted `options` entirely (see
    // requestProcessingSchema) — the schema's own `.default('balanced')` on
    // `quality` resolves that to a concrete preset here, not in the caller.
    return compressVideoOptionsSchema.parse(raw ?? {});
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      throw new InvalidMediaError('No input file was provided for this job');
    }
    // Already validated by parseOptions before the worker ever calls run() —
    // see OperationHandlerContext's own doc comment for why a plain cast is
    // the correct, documented contract here rather than re-parsing.
    const { quality } = ctx.options as CompressVideoOptions;

    const outputPath = path.join(ctx.outputDir, 'output.mp4');
    await ctx.mediaService.probe(input.path);
    await ctx.mediaService.compressVideo(input.path, outputPath, quality);

    return {
      outputPath,
      mimeType: 'video/mp4',
      fileName: deriveCompressedFileName(input.fileName),
    };
  },
};

/** Same safe-display-name derivation as convertToMp4Handler, suffixed to make
 * the operation that produced this file obvious to the user. */
function deriveCompressedFileName(sourceFileName: string): string {
  const { name } = path.parse(path.basename(sourceFileName));
  return `${name || 'video'}-compressed.mp4`;
}
