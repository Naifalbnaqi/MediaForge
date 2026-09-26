import type { DocumentConversionService } from '../../services/document-conversion.service.js';
import type { MediaService } from '../../services/media.service.js';

/** One already-downloaded source file, ready for an operation handler to read
 * from local disk. Always normalized via `resolveJobInputs` before a handler
 * ever sees it — a handler must never read `Job.sourceObjectKey`/`sourceFileName`/
 * etc. directly, only this. */
export interface OperationInput {
  /** Local temp-file path the input was downloaded to — never the storage
   * object key itself. */
  path: string;
  mimeType: string;
  fileName: string;
}

export interface OperationHandlerContext {
  /** This job's normalized, ordered inputs, already downloaded to local temp
   * paths. Exactly one element for every operation Phase 7A supports — a
   * future multi-input operation (image-to-pdf) will see more, but nothing
   * about this shape has to change for that to work. */
  inputs: readonly OperationInput[];
  /** This job's `options`, already re-validated by this same handler's
   * `parseOptions` — never raw, untyped JSON by the time `run` sees it. */
  options: unknown;
  /** Directory the handler should write its output file into. Already
   * created; cleaned up by the caller on every path (success, permanent
   * failure, or a propagating transient error) — a handler never needs to
   * clean up anything itself. */
  outputDir: string;
  mediaService: MediaService;
  /** Only used by `document-to-pdf` (headless LibreOffice) — every other
   * handler ignores this, same as `mediaService` being present on every
   * context even though most handlers only ever call a fraction of its
   * methods. */
  documentConversionService: DocumentConversionService;
}

export interface OperationOutput {
  /** Local path to the produced output file — the caller uploads exactly
   * this path to storage under a server-generated key. */
  outputPath: string;
  mimeType: string;
  /** Display file name for the produced output (what `ProcessedFile.fileName`
   * is set to, and what a Download action ultimately offers the browser) —
   * never a path, never trusted to be safe for a storage key. */
  fileName: string;
}

/**
 * One entry in `OPERATION_HANDLERS`. Each operation owns exactly its own
 * options shape and its own media-processing steps — the generic worker
 * lifecycle (`processMediaJob`) never branches on *which* operation it's
 * running; it only calls these two methods through the registry lookup.
 */
export interface OperationHandler {
  /**
   * Re-validates this job's persisted `options` (an untyped JSON column) against
   * this operation's own schema. Called before `run`, and `run` is never called
   * if this throws — the caller treats a throw here as a permanent, safe
   * "invalid options" failure, never a crash.
   *
   * This is a type-safety recovery step, not a second security boundary: the
   * same shape was already validated once at the API before being persisted
   * (see `requestProcessingSchema` in `@media/validation`). Re-parsing here
   * defends against `Job.options` being read back from an untyped column, and
   * against a row a future data change/bug left in an unexpected shape.
   */
  parseOptions(raw: unknown): unknown;
  /**
   * Runs the operation against already-downloaded local inputs and returns the
   * produced output's local path and metadata. Must never perform its own
   * storage I/O (inputs are already local; download/upload is the caller's
   * job) and must never mutate Job state directly (transitions stay centralized
   * in `processMediaJob`).
   *
   * Content-based permanent failures (a corrupt/unsupported input, a fixed
   * command that will fail identically on retry) should be signalled by
   * throwing `InvalidMediaError`/`MediaConversionError` (from
   * `services/media.service.ts`) — the caller maps those to a safe, fixed
   * `Job.errorCode`/`errorMessage`. Any other thrown error is treated as
   * transient and left to propagate so BullMQ retries the whole job.
   */
  run(ctx: OperationHandlerContext): Promise<OperationOutput>;
}
