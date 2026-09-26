import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(2).max(100),
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Office/document formats `document-to-pdf` converts (via headless LibreOffice —
 * see `apps/api/src/infrastructure/document/libreoffice-document.service.ts`).
 * The eight primary formats (OOXML, ODF, RTF, plain text) plus three legacy
 * binary formats kept only because they were actually tested and convert
 * reliably with the same converter — never listed on the strength of "should
 * work," only because it was verified through Docker acceptance testing
 */
export const documentMimeTypes = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.oasis.opendocument.text', // .odt
  'application/vnd.oasis.opendocument.spreadsheet', // .ods
  'application/vnd.oasis.opendocument.presentation', // .odp
  'application/rtf', // .rtf
  'text/plain', // .txt
  'application/msword', // .doc (legacy, verified reliable)
  'application/vnd.ms-powerpoint', // .ppt (legacy, verified reliable)
  'application/vnd.ms-excel', // .xls (legacy, verified reliable)
] as const;
export const documentMimeTypeSchema = z.enum(documentMimeTypes);
export type DocumentMimeType = z.infer<typeof documentMimeTypeSchema>;

export const documentMimeTypeExtensions: Record<DocumentMimeType, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/rtf': '.rtf',
  'text/plain': '.txt',
  'application/msword': '.doc',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.ms-excel': '.xls',
};

/**
 * Human-readable label per document type, for the frontend's "detected type"
 * display — never derived from the raw MIME string, which is unreadable.
 */
export const documentMimeTypeLabels: Record<DocumentMimeType, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document (.docx)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation (.pptx)',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel workbook (.xlsx)',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text (.odt)',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet (.ods)',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation (.odp)',
  'application/rtf': 'Rich Text document (.rtf)',
  'text/plain': 'Plain text (.txt)',
  'application/msword': 'Word 97-2003 document (.doc)',
  'application/vnd.ms-powerpoint': 'PowerPoint 97-2003 presentation (.ppt)',
  'application/vnd.ms-excel': 'Excel 97-2003 workbook (.xls)',
};

/**
 * `document-to-pdf`'s own size ceiling — tighter than the platform's general
 * upload cap (`MAX_UPLOAD_SIZE_BYTES`, sized for video): a 500 MiB office
 * document isn't a realistic input, and LibreOffice conversion time scales
 * with document complexity, not just byte size, so keeping the source small
 * bounds worst-case conversion time too.
 */
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * MIME types accepted for direct-to-storage uploads. Kept intentionally
 * narrow — these are the only source formats the media-processing pipeline is
 * expected to understand. Document formats share this single-file upload path
 * (unlike `image-to-pdf`, `document-to-pdf` is single-input, so it needs no
 * separate upload-initiation path of its own — see the note on
 * `processingOperations` below).
 */
export const uploadMimeTypes = [
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'image/jpeg',
  'image/png',
  ...documentMimeTypes,
] as const;

export const uploadMimeTypeSchema = z.enum(uploadMimeTypes);
export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>;

/**
 * Canonical file extension for each accepted MIME type. Used server-side to build a
 * storage object key that carries a sane extension without ever trusting the
 * client-supplied file name.
 */
export const mimeTypeExtensions: Record<UploadMimeType, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  ...documentMimeTypeExtensions,
};

export const initiateUploadSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  contentType: uploadMimeTypeSchema,
  contentLength: z.number().int().positive(),
});

export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;

export const jobIdParamsSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
});

export type JobIdParams = z.infer<typeof jobIdParamsSchema>;

/**
 * The only job statuses an owner may delete (single delete and bulk cleanup):
 * finished jobs that hold nothing the user still depends on. Active jobs,
 * still-usable uploads and completed outputs are never deletable. The API's own
 * `DELETABLE_JOB_STATUSES` is the enforcing copy; this one exists so the bulk
 * cleanup request body can be validated (and the web client typed) against the
 * same two names.
 */
export const deletableJobStatuses = ['FAILED', 'CANCELLED'] as const;
export const deletableJobStatusSchema = z.enum(deletableJobStatuses);
export type DeletableJobStatus = z.infer<typeof deletableJobStatusSchema>;

/** Body of `POST /uploads/cleanup`: which finished states to clear. */
export const cleanupUploadsSchema = z.strictObject({
  statuses: z.array(deletableJobStatusSchema).min(1).max(deletableJobStatuses.length),
});
export type CleanupUploadsInput = z.infer<typeof cleanupUploadsSchema>;

/**
 * Per-operation options schema for `convert-to-mp4` — currently empty (the
 * operation takes no configurable parameters), but a real `strictObject` rather
 * than `z.undefined()` so it has the same shape every future operation's options
 * schema will have, and so an unrecognised key in a client-supplied `options`
 * object is rejected rather than silently ignored.
 */
export const convertToMp4OptionsSchema = z.strictObject({});
export type ConvertToMp4Options = z.infer<typeof convertToMp4OptionsSchema>;

/**
 * `compress-video`'s only option: a named preset rather than raw FFmpeg
 * parameters (CRF/preset/audio bitrate) — the actual FFmpeg settings per
 * preset live in `FfmpegMediaService`/`resolveCompressVideoPreset`, not here.
 * Keeping the client-facing surface to three names means the server can freely
 * retune the underlying encode settings later without a client-facing schema
 * change.
 */
export const compressVideoQualities = ['high', 'balanced', 'small'] as const;
export const compressVideoQualitySchema = z.enum(compressVideoQualities);
export type CompressVideoQuality = z.infer<typeof compressVideoQualitySchema>;

export const compressVideoOptionsSchema = z.strictObject({
  quality: compressVideoQualitySchema.default('balanced'),
});
export type CompressVideoOptions = z.infer<typeof compressVideoOptionsSchema>;

/**
 * `resize-video`'s options. `MAX_RESIZE_DIMENSION` is exported so the frontend
 * can validate/word its own form messaging against the exact same ceiling the
 * server enforces, rather than a second hardcoded copy of the number.
 */
export const MAX_RESIZE_DIMENSION = 7680;

const resizeDimensionSchema = z.number().int().positive().max(MAX_RESIZE_DIMENSION);

export const resizeVideoOptionsSchema = z
  .strictObject({
    width: resizeDimensionSchema.optional(),
    height: resizeDimensionSchema.optional(),
  })
  .refine((data) => data.width !== undefined || data.height !== undefined, {
    message: 'At least one of width or height must be provided',
  });
export type ResizeVideoOptions = z.infer<typeof resizeVideoOptionsSchema>;

/**
 * `extract-mp3`'s only option: a named preset, same pattern as
 * `compress-video`'s `quality` — the actual bitrate/VBR settings per preset
 * live in `FfmpegMediaService`/`resolveExtractMp3Preset`, not here.
 */
export const extractMp3Qualities = ['high', 'balanced', 'small'] as const;
export const extractMp3QualitySchema = z.enum(extractMp3Qualities);
export type ExtractMp3Quality = z.infer<typeof extractMp3QualitySchema>;

export const extractMp3OptionsSchema = z.strictObject({
  quality: extractMp3QualitySchema.default('balanced'),
});
export type ExtractMp3Options = z.infer<typeof extractMp3OptionsSchema>;

/**
 * `trim-video`'s options: a start time plus *either* an end time *or* a
 * duration, all in seconds (fractions allowed). Two strict-object union
 * members rather than one object with two optional fields, so "both" and
 * "neither" are rejected structurally (an unrecognised key / a missing key)
 * instead of by a hand-written refinement, and the parsed type is a real
 * discriminable union (`'end' in options`).
 *
 * The constants are exported so the frontend form can word and validate its
 * own messages against the exact same limits the server enforces.
 * - `MAX_TRIM_SECONDS` (24 h) caps every timestamp: the platform's upload
 *   ceiling makes anything longer meaningless, and a bound keeps the values
 *   FFmpeg is handed small, plain decimals.
 * - `MIN_TRIM_DURATION_SECONDS` keeps the kept section at least a few frames
 *   long, so a request can never ask for a zero/near-zero-length output.
 */
export const MAX_TRIM_SECONDS = 86_400;
export const MIN_TRIM_DURATION_SECONDS = 0.1;

/** Float slack for `end - start >= MIN_TRIM_DURATION_SECONDS` (0.3 - 0.2 is
 * 0.09999999999999998 in IEEE 754, which must still count as 0.1). */
const TRIM_DURATION_EPSILON = 1e-9;

const trimStartSchema = z.number().min(0).max(MAX_TRIM_SECONDS);
const trimEndSchema = z.number().min(0).max(MAX_TRIM_SECONDS);
const trimDurationSchema = z.number().min(MIN_TRIM_DURATION_SECONDS).max(MAX_TRIM_SECONDS);

export const trimVideoByEndOptionsSchema = z
  .strictObject({ start: trimStartSchema, end: trimEndSchema })
  .refine((data) => data.end - data.start >= MIN_TRIM_DURATION_SECONDS - TRIM_DURATION_EPSILON, {
    message: `End must be at least ${MIN_TRIM_DURATION_SECONDS} seconds after start`,
    path: ['end'],
  });

export const trimVideoByDurationOptionsSchema = z.strictObject({
  start: trimStartSchema,
  duration: trimDurationSchema,
});

export const trimVideoOptionsSchema = z.union([
  trimVideoByEndOptionsSchema,
  trimVideoByDurationOptionsSchema,
]);
export type TrimVideoOptions = z.infer<typeof trimVideoOptionsSchema>;

/**
 * `image-to-pdf` takes no configurable parameters (page order comes entirely
 * from the request's ordered `images` array / the persisted `JobInput` rows) —
 * a real `strictObject` rather than `z.undefined()`, same reasoning as
 * `convertToMp4OptionsSchema`.
 */
export const imageToPdfOptionsSchema = z.strictObject({});
export type ImageToPdfOptions = z.infer<typeof imageToPdfOptionsSchema>;

/**
 * MIME types accepted as `image-to-pdf` inputs. A separate list from
 * `uploadMimeTypes` (which has no `image/webp` and is used by the unrelated
 * single-file upload path) — image-to-pdf gets its own multi-file upload path
 * entirely, so widening this list never touches single-file uploads.
 */
export const imageToPdfMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const imageToPdfMimeTypeSchema = z.enum(imageToPdfMimeTypes);
export type ImageToPdfMimeType = z.infer<typeof imageToPdfMimeTypeSchema>;

export const imageToPdfMimeTypeExtensions: Record<ImageToPdfMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * `image-to-pdf` file-count and size limits. Exported so the frontend can word
 * and enforce its own messaging against the exact same ceilings the server
 * enforces (same pattern as `MAX_TRIM_SECONDS` etc.).
 * - `MAX_IMAGES_PER_PDF`: generous for a real multi-page document, bounded
 *   against one request queuing an unreasonably long-running conversion.
 * - `MAX_IMAGE_SIZE_BYTES` (25 MiB): far more than a photo needs even at high
 *   resolution; tighter than the platform's general upload ceiling
 *   (`MAX_UPLOAD_SIZE_BYTES`, sized for video) because nothing about a PDF
 *   page needs a 500 MiB source image.
 * - `MAX_TOTAL_IMAGE_TO_PDF_BYTES` (200 MiB): a real aggregate ceiling tighter
 *   than `MAX_IMAGES_PER_PDF * MAX_IMAGE_SIZE_BYTES`, so a request cannot use
 *   the maximum count and the maximum per-file size at once.
 */
export const MAX_IMAGES_PER_PDF = 40;
export const MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_TO_PDF_BYTES = 200 * 1024 * 1024;

const imageToPdfImageSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  contentType: imageToPdfMimeTypeSchema,
  contentLength: z.number().int().positive().max(MAX_IMAGE_SIZE_BYTES),
});

/**
 * Body of `POST /uploads/image-to-pdf`: the ordered list of images to combine —
 * order here is page order, and is what becomes each `JobInput.order`. This is
 * image-to-pdf's own, separate multi-input request path (see the note on
 * `processingOperations` below) — not a variant of `requestProcessingSchema`.
 */
export const initiateImageToPdfSchema = z
  .strictObject({
    images: z.array(imageToPdfImageSchema).min(1).max(MAX_IMAGES_PER_PDF),
  })
  .refine(
    (data) => data.images.reduce((sum, image) => sum + image.contentLength, 0) <= MAX_TOTAL_IMAGE_TO_PDF_BYTES,
    {
      message: `Combined image size must not exceed ${MAX_TOTAL_IMAGE_TO_PDF_BYTES} bytes`,
      path: ['images'],
    },
  );
export type InitiateImageToPdfInput = z.infer<typeof initiateImageToPdfSchema>;

/**
 * `document-to-pdf` takes no configurable parameters — same reasoning as
 * `convertToMp4OptionsSchema`/`imageToPdfOptionsSchema`.
 */
export const documentToPdfOptionsSchema = z.strictObject({});
export type DocumentToPdfOptions = z.infer<typeof documentToPdfOptionsSchema>;

/**
 * Operations the processing pipeline can actually execute. `z.enum` rather
 * than `z.literal` purely so adding a real operation later is additive here,
 * not a restructure.
 *
 * Planned future single-input operations, listed here for reference only —
 * none of these are valid values of this schema, and requesting any of them
 * is rejected exactly like any other unrecognised string, the same as before
 * they existed as a plan at all:
 *   generate-thumbnail, mute-video, convert-format
 * (all three are cancelled — see the owner's locked roadmap — and remain only
 * as a record of names deliberately never wired up).
 * `image-to-pdf` **is** a real, dispatchable operation (registered in
 * `OPERATION_HANDLERS`, and a real `Job.operation` value) — but it is
 * deliberately never a variant of `requestProcessingSchema` below. It is
 * multi-input, submitted through its own request path
 * (`initiateImageToPdfSchema` / `POST /uploads/image-to-pdf`, then
 * `POST /uploads/:id/process-image-to-pdf`), never through
 * `POST /:id/process`.
 * `document-to-pdf` is single-input like every operation above it, so unlike
 * `image-to-pdf` it *is* a normal `requestProcessingSchema` variant, submitted
 * through the existing single-file upload path (`POST /uploads`, then
 * `POST /:id/process`) — no separate request path needed.
 */
export const processingOperations = [
  'convert-to-mp4',
  'compress-video',
  'resize-video',
  'extract-mp3',
  'trim-video',
  'image-to-pdf',
  'document-to-pdf',
] as const;
export const processingOperationSchema = z.enum(processingOperations);
export type ProcessingOperation = z.infer<typeof processingOperationSchema>;

/**
 * Discriminated union keyed by `operation`, each variant carrying exactly the
 * options shape that operation accepts — the foundation new operations plug into
 * (add one `z.strictObject({ operation: z.literal(...), options: ... })` member,
 * no restructuring of this type or its callers). `options` is optional on every
 * variant that takes no *required* parameters (convert-to-mp4 takes none;
 * compress-video's `quality` defaults to `'balanced'`), defaulting to `{}`
 * server-side, so the existing `{ operation: 'convert-to-mp4' }` request body
 * (no `options` key at all) keeps validating exactly as it did before this type
 * existed. `resize-video`'s `options` is deliberately *not* `.optional()` — at
 * least one of width/height is always required, so there is no sensible
 * all-defaults fallback to omit it in favour of; the same holds for
 * `trim-video`, which always needs a start time.
 */
export const requestProcessingSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['convert-to-mp4']),
    options: convertToMp4OptionsSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['compress-video']),
    options: compressVideoOptionsSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['resize-video']),
    options: resizeVideoOptionsSchema,
  }),
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['extract-mp3']),
    options: extractMp3OptionsSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['trim-video']),
    // Required, like resize-video: a start time is always needed, so there is
    // no all-defaults fallback to omit `options` in favour of.
    options: trimVideoOptionsSchema,
  }),
  z.strictObject({
    operation: z.literal(processingOperationSchema.enum['document-to-pdf']),
    options: documentToPdfOptionsSchema.optional(),
  }),
]);

export type RequestProcessingInput = z.infer<typeof requestProcessingSchema>;

/**
 * How a processed output should be served: `inline` so the browser plays it in a
 * preview, `attachment` so it downloads to disk. This value is bound into the
 * presigned URL's signature server-side (as S3's `ResponseContentDisposition`), so a
 * client cannot alter how the object is served after the URL is issued.
 */
export const outputDispositions = ['inline', 'attachment'] as const;
export const outputDispositionSchema = z.enum(outputDispositions);
export type OutputDisposition = z.infer<typeof outputDispositionSchema>;

/**
 * Non-strict (unlike the request-body schemas above) on purpose: query strings pick
 * up stray parameters outside the application's control, and failing a whole
 * output request over an unrecognised one is a worse failure mode than ignoring it.
 * `disposition` itself is still validated strictly when present.
 */
export const outputQuerySchema = z.object({
  disposition: outputDispositionSchema.default('attachment'),
});

export type OutputQuery = z.infer<typeof outputQuerySchema>;
