import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, type PDFImage } from 'pdf-lib';
import { imageToPdfOptionsSchema } from '@media/validation';
import { InvalidImageError, InvalidMediaError } from '../../services/media.service.js';
import type { OperationHandler, OperationHandlerContext, OperationOutput } from './operation-handler.js';

/**
 * Caps how large a single PDF page can be, in PDF points (1/72 inch), when an
 * image's own pixel dimensions are used 1:1. Without this, a single
 * high-resolution photo (e.g. 6000x4000 px) would produce a page of the same
 * size in points — about 83x56 inches, absurd for a document meant to be
 * viewed or printed. 1000pt (~13.9 in) comfortably fits any normal photo or
 * scanned page while staying a sensible physical size. Never upscaled: an
 * image already smaller than this on both sides keeps its own pixel
 * dimensions as points, unchanged.
 */
const MAX_PAGE_POINTS = 1000;

/**
 * `image-to-pdf`: the only multi-input operation. `ctx.inputs` is the job's
 * full ordered list of images (already downloaded to local temp paths by the
 * generic worker loop — nothing about that loop is specific to this
 * operation, see `operation-handler.ts`'s own doc). Each becomes one PDF page,
 * in the same order, sized to that image's own aspect ratio so nothing is
 * cropped, stretched, or letterboxed.
 *
 * `pdf-lib` natively embeds JPEG and PNG but not WebP, so a WebP input is
 * transcoded to PNG first via the FFmpeg binary already installed for every
 * other operation (`MediaService.convertImageToPng`) rather than adding a new
 * image-decoding dependency — see the note on `MediaService.convertImageToPng`.
 *
 * Content-based validation here works the same way probing does for video:
 * the client's declared MIME type is never trusted on its own. Attempting to
 * actually decode each image (via FFmpeg for WebP, via `pdf-lib`'s embed calls
 * for JPEG/PNG) *is* the real check — a failure at either step throws
 * `InvalidImageError`, a permanent, content-based failure naming which image
 * could not be used.
 */
export const imageToPdfHandler: OperationHandler = {
  parseOptions(raw: unknown): unknown {
    return imageToPdfOptionsSchema.parse(raw ?? {});
  },

  async run(ctx: OperationHandlerContext): Promise<OperationOutput> {
    if (ctx.inputs.length === 0) {
      throw new InvalidMediaError('No input files were provided for this job');
    }

    const pdfDoc = await PDFDocument.create();

    for (const [index, input] of ctx.inputs.entries()) {
      const image = await embedImage(pdfDoc, ctx, input, index);
      const { width, height } = fitToMaxPoints(image.width, image.height);
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
    }

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(ctx.outputDir, 'output.pdf');
    await writeFile(outputPath, pdfBytes);

    return {
      outputPath,
      mimeType: 'application/pdf',
      fileName: 'images.pdf',
    };
  },
};

/**
 * Embeds one already-downloaded input into `pdfDoc`, converting a WebP source
 * to PNG first (via FFmpeg) since `pdf-lib` cannot embed WebP directly. Any
 * failure to decode — a corrupt file, or one whose bytes don't actually match
 * its declared MIME type — is a permanent, per-image `InvalidImageError`
 * naming the offending file, never a crash or a silent skip.
 */
async function embedImage(
  pdfDoc: PDFDocument,
  ctx: OperationHandlerContext,
  input: OperationHandlerContext['inputs'][number],
  index: number,
): Promise<PDFImage> {
  try {
    if (input.mimeType === 'image/webp') {
      const pngPath = path.join(ctx.outputDir, `webp-${index}.png`);
      await ctx.mediaService.convertImageToPng(input.path, pngPath);
      return await pdfDoc.embedPng(await readFile(pngPath));
    }
    if (input.mimeType === 'image/png') {
      return await pdfDoc.embedPng(await readFile(input.path));
    }
    if (input.mimeType === 'image/jpeg') {
      return await pdfDoc.embedJpg(await readFile(input.path));
    }
  } catch (error) {
    if (error instanceof InvalidImageError) throw error;
    throw new InvalidImageError(
      `"${input.fileName}" could not be read as a ${input.mimeType} image`,
      error,
    );
  }
  // Unreachable given initiateImageToPdfSchema only ever persists one of the
  // three MIME types above into JobInput rows — kept as a safe, explicit
  // fallback rather than an unchecked cast, matching this codebase's posture
  // of never trusting persisted data blindly.
  throw new InvalidImageError(`"${input.fileName}" has an unsupported image type: ${input.mimeType}`);
}

/** Scales `width`x`height` down (never up) so neither side exceeds `MAX_PAGE_POINTS`,
 * preserving aspect ratio; rounds to whole points since PDF page sizes need not be
 * sub-pixel precise. */
export function fitToMaxPoints(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_PAGE_POINTS / width, MAX_PAGE_POINTS / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
