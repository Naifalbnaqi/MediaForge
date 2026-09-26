import { describe, expect, it } from 'vitest';
import {
  compressVideoOptionsSchema,
  documentMimeTypes,
  documentMimeTypeExtensions,
  documentMimeTypeLabels,
  documentToPdfOptionsSchema,
  extractMp3OptionsSchema,
  imageToPdfOptionsSchema,
  initiateImageToPdfSchema,
  initiateUploadSchema,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_PDF,
  MAX_RESIZE_DIMENSION,
  MAX_TOTAL_IMAGE_TO_PDF_BYTES,
  MAX_TRIM_SECONDS,
  MIN_TRIM_DURATION_SECONDS,
  processingOperationSchema,
  processingOperations,
  requestProcessingSchema,
  resizeVideoOptionsSchema,
  trimVideoOptionsSchema,
} from '@media/validation';

describe('processingOperations / processingOperationSchema', () => {
  it('accepts exactly the seven executable operations after Documents to PDF', () => {
    expect([...processingOperations].sort()).toEqual(
      [
        'compress-video',
        'convert-to-mp4',
        'document-to-pdf',
        'extract-mp3',
        'image-to-pdf',
        'resize-video',
        'trim-video',
      ].sort(),
    );
  });

  it.each(['generate-thumbnail', 'mute-video', 'convert-format'])(
    'rejects the cancelled/never-built operation name %s',
    (operation) => {
      expect(() => processingOperationSchema.parse(operation)).toThrow();
    },
  );

  it('accepts image-to-pdf as a real ProcessingOperation, even though it is never a requestProcessingSchema variant', () => {
    expect(processingOperationSchema.parse('image-to-pdf')).toBe('image-to-pdf');
    expect(() => requestProcessingSchema.parse({ operation: 'image-to-pdf' })).toThrow();
    expect(() => requestProcessingSchema.parse({ operation: 'image-to-pdf', options: {} })).toThrow();
  });

  it('accepts document-to-pdf as a normal requestProcessingSchema variant (unlike image-to-pdf, it is single-input)', () => {
    expect(requestProcessingSchema.parse({ operation: 'document-to-pdf' })).toEqual({
      operation: 'document-to-pdf',
    });
    expect(requestProcessingSchema.parse({ operation: 'document-to-pdf', options: {} })).toEqual({
      operation: 'document-to-pdf',
      options: {},
    });
  });

  it('rejects document-to-pdf with an unrecognised option', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'document-to-pdf', options: { ocr: true } }),
    ).toThrow();
  });
});

describe('compressVideoOptionsSchema', () => {
  it.each(['high', 'balanced', 'small'] as const)('accepts the valid preset %s', (quality) => {
    expect(compressVideoOptionsSchema.parse({ quality })).toEqual({ quality });
  });

  it('defaults quality to "balanced" when omitted', () => {
    expect(compressVideoOptionsSchema.parse({})).toEqual({ quality: 'balanced' });
  });

  it('rejects an invalid preset name', () => {
    expect(() => compressVideoOptionsSchema.parse({ quality: 'ultra' })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => compressVideoOptionsSchema.parse({ quality: 'high', crf: 10 })).toThrow();
  });
});

describe('resizeVideoOptionsSchema', () => {
  it('accepts width only', () => {
    expect(resizeVideoOptionsSchema.parse({ width: 1280 })).toEqual({ width: 1280 });
  });

  it('accepts height only', () => {
    expect(resizeVideoOptionsSchema.parse({ height: 720 })).toEqual({ height: 720 });
  });

  it('accepts width and height together', () => {
    expect(resizeVideoOptionsSchema.parse({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it('rejects when neither width nor height is supplied', () => {
    expect(() => resizeVideoOptionsSchema.parse({})).toThrow();
  });

  it.each([0, -1, -1000])('rejects a non-positive width (%s)', (width) => {
    expect(() => resizeVideoOptionsSchema.parse({ width })).toThrow();
  });

  it('rejects a width above the configured maximum', () => {
    expect(() => resizeVideoOptionsSchema.parse({ width: MAX_RESIZE_DIMENSION + 1 })).toThrow();
  });

  it('accepts a width exactly at the configured maximum', () => {
    expect(resizeVideoOptionsSchema.parse({ width: MAX_RESIZE_DIMENSION })).toEqual({ width: MAX_RESIZE_DIMENSION });
  });

  it('rejects a non-integer dimension', () => {
    expect(() => resizeVideoOptionsSchema.parse({ width: 1280.25 })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => resizeVideoOptionsSchema.parse({ width: 1280, stretch: true })).toThrow();
  });
});

describe('extractMp3OptionsSchema', () => {
  it.each(['high', 'balanced', 'small'] as const)('accepts the valid preset %s', (quality) => {
    expect(extractMp3OptionsSchema.parse({ quality })).toEqual({ quality });
  });

  it('defaults quality to "balanced" when omitted', () => {
    expect(extractMp3OptionsSchema.parse({})).toEqual({ quality: 'balanced' });
  });

  it('rejects an invalid preset name', () => {
    expect(() => extractMp3OptionsSchema.parse({ quality: 'ultra' })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => extractMp3OptionsSchema.parse({ quality: 'high', bitrate: '500k' })).toThrow();
  });
});

describe('trimVideoOptionsSchema', () => {
  it('accepts start + end', () => {
    expect(trimVideoOptionsSchema.parse({ start: 10, end: 20 })).toEqual({ start: 10, end: 20 });
  });

  it('accepts start + duration', () => {
    expect(trimVideoOptionsSchema.parse({ start: 10, duration: 5 })).toEqual({ start: 10, duration: 5 });
  });

  it('accepts fractional seconds', () => {
    expect(trimVideoOptionsSchema.parse({ start: 1.25, end: 3.75 })).toEqual({ start: 1.25, end: 3.75 });
  });

  it('accepts a start of exactly 0', () => {
    expect(trimVideoOptionsSchema.parse({ start: 0, duration: 1 })).toEqual({ start: 0, duration: 1 });
  });

  it('rejects when neither end nor duration is given', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10 })).toThrow();
  });

  it('rejects when both end and duration are given (ambiguous)', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10, end: 20, duration: 10 })).toThrow();
  });

  it('rejects a missing start', () => {
    expect(() => trimVideoOptionsSchema.parse({ end: 20 })).toThrow();
    expect(() => trimVideoOptionsSchema.parse({ duration: 5 })).toThrow();
  });

  it.each([-1, -0.001])('rejects a negative start (%s)', (start) => {
    expect(() => trimVideoOptionsSchema.parse({ start, end: 20 })).toThrow();
  });

  it('rejects an end equal to the start', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10, end: 10 })).toThrow();
  });

  it('rejects an end before the start', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10, end: 5 })).toThrow();
  });

  it('rejects an end less than the minimum duration after the start', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10, end: 10.05 })).toThrow();
  });

  it('accepts an end exactly the minimum duration after the start, despite float error (0.3 - 0.2)', () => {
    expect(trimVideoOptionsSchema.parse({ start: 0.2, end: 0.3 })).toEqual({ start: 0.2, end: 0.3 });
  });

  it.each([0, -5, MIN_TRIM_DURATION_SECONDS / 2])('rejects a duration below the minimum (%s)', (duration) => {
    expect(() => trimVideoOptionsSchema.parse({ start: 0, duration })).toThrow();
  });

  it('accepts a duration exactly at the minimum', () => {
    expect(trimVideoOptionsSchema.parse({ start: 0, duration: MIN_TRIM_DURATION_SECONDS })).toEqual({
      start: 0,
      duration: MIN_TRIM_DURATION_SECONDS,
    });
  });

  it('rejects a start above the maximum, and accepts one exactly at it', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: MAX_TRIM_SECONDS + 1, duration: 5 })).toThrow();
    expect(trimVideoOptionsSchema.parse({ start: MAX_TRIM_SECONDS, duration: 5 })).toEqual({
      start: MAX_TRIM_SECONDS,
      duration: 5,
    });
  });

  it('rejects an end or duration above the maximum', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 0, end: MAX_TRIM_SECONDS + 1 })).toThrow();
    expect(() => trimVideoOptionsSchema.parse({ start: 0, duration: MAX_TRIM_SECONDS + 1 })).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite number (%s)',
    (value) => {
      expect(() => trimVideoOptionsSchema.parse({ start: value, end: 20 })).toThrow();
      expect(() => trimVideoOptionsSchema.parse({ start: 0, end: value })).toThrow();
      expect(() => trimVideoOptionsSchema.parse({ start: 0, duration: value })).toThrow();
    },
  );

  it('rejects numeric strings rather than coercing them', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: '10', end: '20' })).toThrow();
  });

  it('rejects an unrecognised option key', () => {
    expect(() => trimVideoOptionsSchema.parse({ start: 10, end: 20, codec: 'copy' })).toThrow();
    expect(() => trimVideoOptionsSchema.parse({ start: 10, duration: 5, args: ['-vf', 'x'] })).toThrow();
  });
});

describe('requestProcessingSchema — trim-video', () => {
  it('requires an options object (no all-defaults fallback)', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'trim-video' })).toThrow();
  });

  it('accepts trim-video with start + end', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'trim-video', options: { start: 1, end: 9 } });
    expect(parsed).toEqual({ operation: 'trim-video', options: { start: 1, end: 9 } });
  });

  it('accepts trim-video with start + duration', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'trim-video', options: { start: 1, duration: 8 } });
    expect(parsed).toEqual({ operation: 'trim-video', options: { start: 1, duration: 8 } });
  });

  it('rejects trim-video with an invalid range', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'trim-video', options: { start: 9, end: 1 } }),
    ).toThrow();
  });

  it('rejects trim-video with both end and duration', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'trim-video', options: { start: 1, end: 9, duration: 8 } }),
    ).toThrow();
  });
});

describe('requestProcessingSchema — discriminated union over all five operations', () => {
  it('accepts convert-to-mp4 with options omitted (existing behavior unchanged)', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'convert-to-mp4' });
    expect(parsed).toEqual({ operation: 'convert-to-mp4' });
  });

  it('accepts compress-video with options omitted, deferring the default to the options schema', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'compress-video' });
    expect(parsed).toEqual({ operation: 'compress-video' });
  });

  it('accepts compress-video with an explicit quality', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'compress-video', options: { quality: 'small' } });
    expect(parsed).toEqual({ operation: 'compress-video', options: { quality: 'small' } });
  });

  it('rejects compress-video with an invalid quality', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'compress-video', options: { quality: 'ultra' } }),
    ).toThrow();
  });

  it('requires an options object for resize-video (no all-defaults fallback)', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'resize-video' })).toThrow();
  });

  it('accepts resize-video with width only', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'resize-video', options: { width: 1280 } });
    expect(parsed).toEqual({ operation: 'resize-video', options: { width: 1280 } });
  });

  it('rejects resize-video with neither width nor height', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'resize-video', options: {} })).toThrow();
  });

  it('accepts extract-mp3 with options omitted, deferring the default to the options schema', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'extract-mp3' });
    expect(parsed).toEqual({ operation: 'extract-mp3' });
  });

  it('accepts extract-mp3 with an explicit quality', () => {
    const parsed = requestProcessingSchema.parse({ operation: 'extract-mp3', options: { quality: 'high' } });
    expect(parsed).toEqual({ operation: 'extract-mp3', options: { quality: 'high' } });
  });

  it('rejects extract-mp3 with an invalid quality', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'extract-mp3', options: { quality: 'ultra' } })).toThrow();
  });

  it('rejects an unknown operation name entirely', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'sharpen-video' })).toThrow();
  });

  it('rejects a still-future, listed-for-reference-only operation name', () => {
    expect(() => requestProcessingSchema.parse({ operation: 'mute-video' })).toThrow();
  });

  it('rejects arbitrary unrecognised top-level keys', () => {
    expect(() =>
      requestProcessingSchema.parse({ operation: 'convert-to-mp4', ffmpegFlags: ['-vf', 'evil'] }),
    ).toThrow();
  });
});

describe('imageToPdfOptionsSchema', () => {
  it('accepts an empty object — image-to-pdf takes no configurable options', () => {
    expect(imageToPdfOptionsSchema.parse({})).toEqual({});
  });

  it('rejects an unrecognised key', () => {
    expect(() => imageToPdfOptionsSchema.parse({ pageSize: 'A4' })).toThrow();
  });
});

describe('initiateImageToPdfSchema', () => {
  function image(overrides: Partial<{ fileName: string; contentType: string; contentLength: number }> = {}) {
    return { fileName: 'photo.jpg', contentType: 'image/jpeg', contentLength: 1000, ...overrides };
  }

  it('accepts one image', () => {
    const parsed = initiateImageToPdfSchema.parse({ images: [image()] });
    expect(parsed.images).toHaveLength(1);
  });

  it('accepts multiple images of every supported type, preserving order', () => {
    const parsed = initiateImageToPdfSchema.parse({
      images: [
        image({ fileName: 'a.jpg', contentType: 'image/jpeg' }),
        image({ fileName: 'b.png', contentType: 'image/png' }),
        image({ fileName: 'c.webp', contentType: 'image/webp' }),
      ],
    });
    expect(parsed.images.map((i) => i.fileName)).toEqual(['a.jpg', 'b.png', 'c.webp']);
  });

  it('rejects an empty images array', () => {
    expect(() => initiateImageToPdfSchema.parse({ images: [] })).toThrow();
  });

  it('rejects more than MAX_IMAGES_PER_PDF images', () => {
    const images = Array.from({ length: MAX_IMAGES_PER_PDF + 1 }, () => image());
    expect(() => initiateImageToPdfSchema.parse({ images })).toThrow();
  });

  it('accepts exactly MAX_IMAGES_PER_PDF images', () => {
    const images = Array.from({ length: MAX_IMAGES_PER_PDF }, (_, i) => image({ fileName: `${i}.jpg` }));
    expect(initiateImageToPdfSchema.parse({ images }).images).toHaveLength(MAX_IMAGES_PER_PDF);
  });

  it('rejects an unsupported image MIME type', () => {
    expect(() =>
      initiateImageToPdfSchema.parse({ images: [image({ contentType: 'image/gif' })] }),
    ).toThrow();
    expect(() =>
      initiateImageToPdfSchema.parse({ images: [image({ contentType: 'video/mp4' })] }),
    ).toThrow();
  });

  it('rejects a single image over MAX_IMAGE_SIZE_BYTES', () => {
    expect(() =>
      initiateImageToPdfSchema.parse({ images: [image({ contentLength: MAX_IMAGE_SIZE_BYTES + 1 })] }),
    ).toThrow();
  });

  it('accepts a single image at exactly MAX_IMAGE_SIZE_BYTES', () => {
    expect(
      initiateImageToPdfSchema.parse({ images: [image({ contentLength: MAX_IMAGE_SIZE_BYTES })] }),
    ).toBeTruthy();
  });

  it('rejects a combined total over MAX_TOTAL_IMAGE_TO_PDF_BYTES even when each image is individually within MAX_IMAGE_SIZE_BYTES', () => {
    // Enough max-per-image-size images to exceed the aggregate cap while each
    // one individually stays at (never over) MAX_IMAGE_SIZE_BYTES, and the
    // count stays well under MAX_IMAGES_PER_PDF — isolates the aggregate check
    // from the per-image and per-count ones.
    const count = Math.ceil(MAX_TOTAL_IMAGE_TO_PDF_BYTES / MAX_IMAGE_SIZE_BYTES) + 1;
    expect(count).toBeLessThan(MAX_IMAGES_PER_PDF);
    const images = Array.from({ length: count }, (_, i) =>
      image({ fileName: `${i}.jpg`, contentLength: MAX_IMAGE_SIZE_BYTES }),
    );
    expect(() => initiateImageToPdfSchema.parse({ images })).toThrow();
  });

  it('rejects a negative or zero contentLength', () => {
    expect(() => initiateImageToPdfSchema.parse({ images: [image({ contentLength: 0 })] })).toThrow();
    expect(() => initiateImageToPdfSchema.parse({ images: [image({ contentLength: -1 })] })).toThrow();
  });

  it('rejects an empty fileName', () => {
    expect(() => initiateImageToPdfSchema.parse({ images: [image({ fileName: '' })] })).toThrow();
  });

  it('rejects an unrecognised top-level key', () => {
    expect(() => initiateImageToPdfSchema.parse({ images: [image()], pageSize: 'A4' })).toThrow();
  });

  it('rejects an unrecognised key on an individual image', () => {
    expect(() =>
      initiateImageToPdfSchema.parse({ images: [{ ...image(), rotate: 90 }] }),
    ).toThrow();
  });
});

describe('documentToPdfOptionsSchema', () => {
  it('accepts an empty object — document-to-pdf takes no configurable options', () => {
    expect(documentToPdfOptionsSchema.parse({})).toEqual({});
  });

  it('rejects an unrecognised key', () => {
    expect(() => documentToPdfOptionsSchema.parse({ ocr: true })).toThrow();
  });
});

describe('document MIME types', () => {
  it('lists exactly the eleven supported document formats', () => {
    expect([...documentMimeTypes].sort()).toEqual(
      [
        'application/msword',
        'application/rtf',
        'application/vnd.ms-excel',
        'application/vnd.ms-powerpoint',
        'application/vnd.oasis.opendocument.presentation',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
      ].sort(),
    );
  });

  it('has an extension and a human-readable label for every supported type', () => {
    for (const mimeType of documentMimeTypes) {
      expect(documentMimeTypeExtensions[mimeType]).toMatch(/^\.[a-z]+$/);
      expect(documentMimeTypeLabels[mimeType].length).toBeGreaterThan(0);
    }
  });

  it('is accepted by the shared single-file initiateUploadSchema (document-to-pdf is single-input)', () => {
    for (const contentType of documentMimeTypes) {
      const parsed = initiateUploadSchema.parse({
        fileName: `report${documentMimeTypeExtensions[contentType]}`,
        contentType,
        contentLength: 1000,
      });
      expect(parsed.contentType).toBe(contentType);
    }
  });

  it('rejects a document contentLength over MAX_DOCUMENT_SIZE_BYTES only insofar as the schema allows any positive length — the tighter document-specific cap is enforced by UploadsService.initiate, not this schema', () => {
    // initiateUploadSchema itself has no per-MIME-type ceiling (that would need
    // a refinement keyed on contentType); MAX_DOCUMENT_SIZE_BYTES is enforced in
    // UploadsService.initiate (see uploads.service.test.ts) precisely because it
    // depends on which MIME type was sent.
    expect(MAX_DOCUMENT_SIZE_BYTES).toBeGreaterThan(0);
    expect(() =>
      initiateUploadSchema.parse({
        fileName: 'huge.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentLength: MAX_DOCUMENT_SIZE_BYTES + 1,
      }),
    ).not.toThrow();
  });
});
