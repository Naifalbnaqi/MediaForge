import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { documentMimeTypeExtensions, documentToPdfOptionsSchema, type DocumentMimeType } from '@media/validation';
import { InvalidDocumentError } from '../../services/document-conversion.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * `document-to-pdf`: converts a single office/text document (DOCX, PPTX, XLSX,
 * ODT, ODS, ODP, RTF, TXT, and the legacy DOC/PPT/XLS — see `documentMimeTypes`
 * in `@media/validation`) to a PDF via headless LibreOffice
 * (`DocumentConversionService`). Single-input, so unlike `image-to-pdf` it is a
 * normal `requestProcessingSchema` variant submitted through the existing
 * single-file upload path — see the note on `processingOperations`.
 *
 * The worker's generic download step writes every input to an extensionless
 * temp path (`input-0`, etc. — every other handler is fine with that, since
 * FFmpeg/pdf-lib are told the format via content probing or an explicit embed
 * call, never the filename). LibreOffice's format detection, unlike those,
 * relies on the file extension, so this handler's first job is to copy the
 * already-downloaded input to a path that carries the correct extension for
 * its declared MIME type before handing it to `DocumentConversionService`.
 */
export const documentToPdfHandler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    return documentToPdfOptionsSchema.parse(raw ?? {});
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    const input = ctx.inputs[0];
    if (!input) {
      throw new InvalidDocumentError('No input file was provided for this job');
    }

    const extension = documentMimeTypeExtensions[input.mimeType as DocumentMimeType];
    if (!extension) {
      // Unreachable given uploadMimeTypeSchema only ever persists one of
      // documentMimeTypes for a document-to-pdf job — kept as a safe, explicit
      // fallback rather than an unchecked cast, matching this codebase's
      // posture of never trusting persisted data blindly (see image-to-pdf's
      // identical fallback for its own MIME-type check).
      throw new InvalidDocumentError(`Unsupported document type: ${input.mimeType}`);
    }

    const renamedInputPath = path.join(ctx.outputDir, `input${extension}`);
    await copyFile(input.path, renamedInputPath);

    const outputPath = await ctx.documentConversionService.convertToPdf(renamedInputPath, ctx.outputDir);

    return {
      outputPath,
      mimeType: 'application/pdf',
      fileName: deriveConvertedFileName(input.fileName),
    };
  },
};

/** Same safe-display-name derivation as every other handler, suffixed to make
 * the operation that produced this file obvious to the user. */
function deriveConvertedFileName(sourceFileName: string): string {
  const { name } = path.parse(path.basename(sourceFileName));
  return `${name || 'document'}.pdf`;
}
