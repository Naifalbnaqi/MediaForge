import path from 'node:path';
import { extractMp3OptionsSchema, type ExtractMp3Options } from '@media/validation';
import { InvalidMediaError, NoAudioStreamError } from '../../services/media.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * `extract-mp3`: probe the (single) input for a real video stream *and* an
 * audio stream, then encode that audio track to a standalone MP3 at the
 * requested quality preset (defaulting to `'balanced'`). Mirrors
 * `compressVideoHandler`'s shape exactly — this handler owns only the
 * extract-specific option, the no-audio guard, and output-naming details; the
 * generic worker lifecycle (download/upload/record) never changes for a new
 * operation.
 *
 * The no-audio case is deliberately checked *here*, not inside
 * `MediaService.extractMp3` — `probe()`'s existing result already carries
 * every stream's `codecType`, so no new MediaService method is needed just to
 * answer "does this have audio?". Failing safe with a permanent
 * `NoAudioStreamError` (never a fake/empty MP3) — a subclass of
 * `InvalidMediaError`, so it is still a permanent, non-retried failure — lets
 * `processMediaJob` persist an accurate "no audio track" message rather than
 * the generic "not a valid video" one, which would be wrong for a valid video
 * that merely has no audio.
 */
export const extractMp3Handler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    // `raw` is `{}` when a request omitted `options` entirely (see
    // requestProcessingSchema) — the schema's own `.default('balanced')` on
    // `quality` resolves that to a concrete preset here, not in the caller.
    return extractMp3OptionsSchema.parse(raw ?? {});
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      throw new InvalidMediaError('No input file was provided for this job');
    }
    // Already validated by parseOptions before the worker ever calls run() —
    // see OperationHandlerContext's own doc comment for why a plain cast is
    // the correct, documented contract here rather than re-parsing.
    const { quality } = ctx.options as ExtractMp3Options;

    const probeResult = await ctx.mediaService.probe(input.path);
    const hasAudioStream = probeResult.streams.some((stream) => stream.codecType === 'audio');
    if (!hasAudioStream) {
      throw new NoAudioStreamError();
    }

    const outputPath = path.join(ctx.outputDir, 'output.mp3');
    await ctx.mediaService.extractMp3(input.path, outputPath, quality);

    return {
      outputPath,
      mimeType: 'audio/mpeg',
      fileName: deriveExtractedAudioFileName(input.fileName),
    };
  },
};

/** Same safe-display-name derivation as the other handlers, suffixed to make
 * the operation that produced this file obvious to the user. */
function deriveExtractedAudioFileName(sourceFileName: string): string {
  const { name } = path.parse(path.basename(sourceFileName));
  return `${name || 'audio'}-audio.mp3`;
}
