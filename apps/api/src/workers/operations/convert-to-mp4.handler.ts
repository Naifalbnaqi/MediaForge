import path from 'node:path';
import { convertToMp4OptionsSchema } from '@media/validation';
import { InvalidMediaError } from '../../services/media.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * The one operation Phase 7A actually executes — behavior is unchanged from
 * before this refactor, just relocated out of `processMediaJob` and behind the
 * `OperationHandler` interface: probe the (single) input for a real video
 * stream, convert it to a standard H.264/AAC MP4, and hand back its local path
 * plus display metadata. `mediaService.probe`/`convertToMp4` already throw
 * `InvalidMediaError`/`MediaConversionError` natively on failure — this handler
 * deliberately does not catch and rewrap them, since `processMediaJob` is what
 * maps those to the job's persisted `errorCode`/`errorMessage`.
 */
export const convertToMp4Handler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    return convertToMp4OptionsSchema.parse(raw);
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      // Structurally unreachable today (resolveJobInputs always returns at
      // least one element), but a handler must never silently proceed with
      // `undefined` — fail the same safe, permanent way an unreadable file
      // would.
      throw new InvalidMediaError('No input file was provided for this job');
    }

    const outputPath = path.join(ctx.outputDir, 'output.mp4');
    await ctx.mediaService.probe(input.path);
    await ctx.mediaService.convertToMp4(input.path, outputPath);

    return {
      outputPath,
      mimeType: 'video/mp4',
      fileName: deriveProcessedFileName(input.fileName),
    };
  },
};

/**
 * Derives a safe *display* name for the processed output — just DB metadata,
 * never a path — by swapping whatever extension the input's own (client-
 * supplied) file name has for `.mp4`. `path.basename` first so a pathological
 * file name containing separators still yields a single, sane file name.
 */
function deriveProcessedFileName(sourceFileName: string): string {
  const { name } = path.parse(path.basename(sourceFileName));
  return `${name || 'converted'}.mp4`;
}
