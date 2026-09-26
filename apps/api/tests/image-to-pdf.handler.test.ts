import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fitToMaxPoints,
  imageToPdfHandler,
} from '../src/workers/operations/image-to-pdf.handler.js';
import { InvalidImageError, InvalidMediaError, type MediaService } from '../src/services/media.service.js';
import type { OperationHandlerContext, OperationInput } from '../src/workers/operations/operation-handler.js';

/** Real, tiny, valid 1x1 pixel fixtures (generated via `sharp`, verified to embed
 * successfully via `pdf-lib` before being hardcoded here) — real content-based
 * decoding is exactly what this handler is meant to exercise, not a mocked-away
 * format check. */
const JPEG_1X1 = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'base64',
);
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
/** A structurally-invalid JPEG (a valid header truncated, then arbitrary bytes) —
 * proves the handler actually decodes content rather than trusting the declared
 * MIME type or a magic-number prefix alone. */
const CORRUPT_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwZub3QgYSByZWFsIGpwZWcgYm9keSBhdCBhbGwsIGp1c3QgZ2FyYmFnZSBieXRlcw==',
  'base64',
);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-to-pdf-handler-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function fakeMediaService(overrides: Partial<MediaService> = {}): MediaService {
  return {
    probe: async () => {
      throw new Error('image-to-pdf must never call probe');
    },
    convertToMp4: async () => {
      throw new Error('image-to-pdf must never call convertToMp4');
    },
    compressVideo: async () => {
      throw new Error('image-to-pdf must never call compressVideo');
    },
    resizeVideo: async () => {
      throw new Error('image-to-pdf must never call resizeVideo');
    },
    extractMp3: async () => {
      throw new Error('image-to-pdf must never call extractMp3');
    },
    trimVideo: async () => {
      throw new Error('image-to-pdf must never call trimVideo');
    },
    // Default: behave like real FFmpeg converting a WebP source, by actually
    // writing real, embeddable PNG bytes to outputPath.
    convertImageToPng: async (_inputPath, outputPath) => {
      await writeFile(outputPath, PNG_1X1);
    },
    ...overrides,
  };
}

async function writeInput(fileName: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(tempDir, fileName);
  await writeFile(filePath, bytes);
  return filePath;
}

function buildContext(inputs: OperationInput[], mediaService: MediaService): OperationHandlerContext {
  return {
    inputs,
    options: {},
    outputDir: tempDir,
    mediaService,
    documentConversionService: {
      convertToPdf: async () => {
        throw new Error('image-to-pdf must never call convertToPdf');
      },
    },
  };
}

describe('imageToPdfHandler.parseOptions', () => {
  it('accepts an empty/undefined options object', () => {
    expect(imageToPdfHandler.parseOptions({})).toEqual({});
    expect(imageToPdfHandler.parseOptions(undefined)).toEqual({});
  });

  it('rejects an unrecognised key', () => {
    expect(() => imageToPdfHandler.parseOptions({ pageSize: 'A4' })).toThrow();
  });
});

describe('imageToPdfHandler.run', () => {
  it('throws InvalidMediaError when no inputs are provided', async () => {
    const ctx = buildContext([], fakeMediaService());
    await expect(imageToPdfHandler.run(ctx)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('produces a one-page PDF from a single JPEG input', async () => {
    const jpegPath = await writeInput('photo.jpg', JPEG_1X1);
    const ctx = buildContext(
      [{ path: jpegPath, mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
      fakeMediaService(),
    );

    const output = await imageToPdfHandler.run(ctx);

    expect(output.mimeType).toBe('application/pdf');
    expect(output.fileName).toBe('images.pdf');
    const pdfBytes = await readFile(output.outputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(1);
  });

  it('produces a one-page PDF from a single PNG input', async () => {
    const pngPath = await writeInput('photo.png', PNG_1X1);
    const ctx = buildContext(
      [{ path: pngPath, mimeType: 'image/png', fileName: 'photo.png' }],
      fakeMediaService(),
    );

    const output = await imageToPdfHandler.run(ctx);

    const pdfBytes = await readFile(output.outputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(1);
  });

  it('produces a one-page PDF from a single WebP input, converting it to PNG first via MediaService', async () => {
    const webpPath = await writeInput('photo.webp', Buffer.from('fake-webp-bytes'));
    const convertCalls: Array<{ inputPath: string; outputPath: string }> = [];
    const mediaService = fakeMediaService({
      convertImageToPng: async (inputPath, outputPath) => {
        convertCalls.push({ inputPath, outputPath });
        await writeFile(outputPath, PNG_1X1);
      },
    });
    const ctx = buildContext([{ path: webpPath, mimeType: 'image/webp', fileName: 'photo.webp' }], mediaService);

    const output = await imageToPdfHandler.run(ctx);

    expect(convertCalls).toHaveLength(1);
    expect(convertCalls[0]?.inputPath).toBe(webpPath);
    const pdfBytes = await readFile(output.outputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(1);
  });

  it('combines multiple images of mixed formats into one PDF, one page per image, in the given order', async () => {
    const jpegPath = await writeInput('a.jpg', JPEG_1X1);
    const pngPath = await writeInput('b.png', PNG_1X1);
    const webpPath = await writeInput('c.webp', Buffer.from('fake-webp-bytes'));
    const ctx = buildContext(
      [
        { path: jpegPath, mimeType: 'image/jpeg', fileName: 'a.jpg' },
        { path: pngPath, mimeType: 'image/png', fileName: 'b.png' },
        { path: webpPath, mimeType: 'image/webp', fileName: 'c.webp' },
      ],
      fakeMediaService(),
    );

    const output = await imageToPdfHandler.run(ctx);

    const pdfBytes = await readFile(output.outputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(3);
  });

  it('throws InvalidImageError, naming the file, when an image is corrupt (declared JPEG, invalid bytes)', async () => {
    const corruptPath = await writeInput('bad.jpg', CORRUPT_JPEG);
    const ctx = buildContext(
      [{ path: corruptPath, mimeType: 'image/jpeg', fileName: 'bad.jpg' }],
      fakeMediaService(),
    );

    const error = await imageToPdfHandler.run(ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidImageError);
    expect((error as Error).message).toContain('bad.jpg');
  });

  it('throws InvalidImageError, never a crash, when the WebP-to-PNG conversion itself fails', async () => {
    const webpPath = await writeInput('bad.webp', Buffer.from('not really webp'));
    const mediaService = fakeMediaService({
      convertImageToPng: async () => {
        throw new InvalidImageError('ffmpeg failed to convert the input image to PNG');
      },
    });
    const ctx = buildContext([{ path: webpPath, mimeType: 'image/webp', fileName: 'bad.webp' }], mediaService);

    await expect(imageToPdfHandler.run(ctx)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it('a valid image earlier in the order does not mask a corrupt one later in the order', async () => {
    const goodPath = await writeInput('good.jpg', JPEG_1X1);
    const badPath = await writeInput('bad.png', CORRUPT_JPEG);
    const ctx = buildContext(
      [
        { path: goodPath, mimeType: 'image/jpeg', fileName: 'good.jpg' },
        { path: badPath, mimeType: 'image/png', fileName: 'bad.png' },
      ],
      fakeMediaService(),
    );

    const error = await imageToPdfHandler.run(ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidImageError);
    expect((error as Error).message).toContain('bad.png');
  });
});

describe('fitToMaxPoints', () => {
  it('leaves an image already within the cap unchanged', () => {
    expect(fitToMaxPoints(400, 300)).toEqual({ width: 400, height: 300 });
  });

  it('never upscales a small image', () => {
    expect(fitToMaxPoints(10, 5)).toEqual({ width: 10, height: 5 });
  });

  it('scales a too-wide image down so width caps at MAX_PAGE_POINTS, preserving aspect ratio', () => {
    const result = fitToMaxPoints(4000, 2000);
    expect(result.width).toBe(1000);
    expect(result.height).toBe(500);
  });

  it('scales a too-tall image down so height caps at MAX_PAGE_POINTS, preserving aspect ratio', () => {
    const result = fitToMaxPoints(2000, 4000);
    expect(result.width).toBe(500);
    expect(result.height).toBe(1000);
  });

  it('a square image over the cap scales down to exactly the cap on both sides', () => {
    expect(fitToMaxPoints(5000, 5000)).toEqual({ width: 1000, height: 1000 });
  });
});
