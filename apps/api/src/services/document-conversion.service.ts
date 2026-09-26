/**
 * Port for the headless-LibreOffice adapter, implemented by
 * `infrastructure/document/libreoffice-document.service.ts` and consumed only by
 * `document-to-pdf`'s handler. A separate port from `MediaService` — LibreOffice
 * and FFmpeg are unrelated external tools, so this stays its own small interface
 * rather than growing `MediaService` (which several docstrings there already
 * describe specifically as "the FFmpeg/FFprobe adapter") to cover a second one.
 */
export interface DocumentConversionService {
  /**
   * Converts the document at `inputPath` (a server-generated temp path that
   * already carries the correct extension for its declared MIME type — see
   * `documentMimeTypeExtensions` in `@media/validation` — LibreOffice's format
   * detection relies on it) to a PDF, writing it under `outputDir`. Returns the
   * produced PDF's local path.
   *
   * Every input format this converts is real, content-based, and headless
   * `soffice --convert-to` is unconditionally used the same way for all of
   * them — this method deliberately has no per-format branch or client-facing
   * option, matching `MediaService`'s "no generic escape hatch" posture.
   */
  convertToPdf(inputPath: string, outputDir: string): Promise<string>;
}

/**
 * Thrown when a document could not be converted to a usable PDF: LibreOffice
 * produced no output file, an empty one, or one that isn't actually a PDF.
 *
 * Verified directly against the installed LibreOffice binary (25.8, headless
 * `--convert-to`) rather than assumed: it exits `0` even when conversion
 * genuinely fails (for example a truncated/corrupted OOXML zip prints
 * "Error: source file could not be loaded" to stderr but still exits 0 and
 * writes no output file) — so the *only* reliable success signal is whether
 * the expected output file actually exists and looks like a PDF, never the
 * process's exit code. A permanent, content-based failure, like
 * `InvalidMediaError`/`InvalidImageError` — retrying the exact same file
 * would fail identically. Like every media/document error in this codebase,
 * this error's own `message` is for server-side diagnostics only; the worker
 * persists a fixed, safe message instead.
 */
export class InvalidDocumentError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'InvalidDocumentError';
  }
}
