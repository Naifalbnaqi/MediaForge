import type { ProcessingOperation } from '@media/validation';
import { compressVideoHandler } from './compress-video.handler.js';
import { convertToMp4Handler } from './convert-to-mp4.handler.js';
import { documentToPdfHandler } from './document-to-pdf.handler.js';
import { extractMp3Handler } from './extract-mp3.handler.js';
import { imageToPdfHandler } from './image-to-pdf.handler.js';
import type { OperationHandler } from './operation-handler.js';
import { resizeVideoHandler } from './resize-video.handler.js';
import { trimVideoHandler } from './trim-video.handler.js';

/**
 * The operation registry — a plain lookup table, not a branch. Adding a real
 * operation is: add its literal to `processingOperations` in `@media/validation`,
 * write its handler file, add one entry here. Nothing in `processMediaJob` (or
 * anywhere else that dispatches by operation) ever grows an
 * `if (operation === ...)`/`switch` — this table is the only place that maps an
 * operation name to executable code.
 *
 * Typed as `Record<ProcessingOperation, OperationHandler>` (exhaustive over the
 * *validated* operation type) rather than a partial/loose map — TypeScript
 * itself refuses to compile if a real operation is ever added to
 * `processingOperations` without a corresponding handler entry here.
 */
export const OPERATION_HANDLERS: Record<ProcessingOperation, OperationHandler> = {
  'convert-to-mp4': convertToMp4Handler,
  'compress-video': compressVideoHandler,
  'resize-video': resizeVideoHandler,
  'extract-mp3': extractMp3Handler,
  'trim-video': trimVideoHandler,
  'image-to-pdf': imageToPdfHandler,
  'document-to-pdf': documentToPdfHandler,
};

/**
 * Looks up the handler for a job's raw, persisted `operation` string — which is
 * `string | null` at the type level (an untyped column), not necessarily a
 * valid `ProcessingOperation`, regardless of what the API's own validation
 * guarantees for freshly-submitted jobs. Returns `undefined` for `null`, an
 * empty string, or any operation name this registry doesn't recognise
 * (including every Phase 7B+ name that's merely *planned*, not yet real) —
 * the caller treats that as a permanent, safe "unsupported operation" failure,
 * never a crash or a silent no-op.
 */
export function lookupOperationHandler(operation: string | null): OperationHandler | undefined {
  if (operation === null) return undefined;
  return Object.prototype.hasOwnProperty.call(OPERATION_HANDLERS, operation)
    ? OPERATION_HANDLERS[operation as ProcessingOperation]
    : undefined;
}
