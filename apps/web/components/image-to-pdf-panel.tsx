'use client';

import { useAuth } from '@media/auth-client';
import { Button, ErrorState } from '@media/ui';
import {
  imageToPdfMimeTypes,
  MAX_IMAGES_PER_PDF,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_IMAGE_TO_PDF_BYTES,
  type ImageToPdfMimeType,
} from '@media/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { formatBytes } from '@/lib/format';
import {
  completeUpload,
  initiateImageToPdf,
  processImageToPdf,
  uploadFileToPresignedUrl,
} from '@/lib/uploads-api';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';

const ACCEPTED_MIME_TYPES: readonly string[] = imageToPdfMimeTypes;

interface SelectedImage {
  /** Stable client-side key for React and for reordering — never sent to the API. */
  id: string;
  file: File;
  /** `file.type` narrowed once at selection time (only accepted files are ever
   * added), so the submit path never needs to re-validate or re-cast it. */
  contentType: ImageToPdfMimeType;
  previewUrl: string;
}

type SubmitStatus =
  | { kind: 'idle' }
  | { kind: 'uploading'; completed: number; total: number }
  | { kind: 'processing' }
  | { kind: 'success' }
  | { kind: 'error'; message: string; recoverableJobId?: string };

function asImageToPdfMimeType(mimeType: string): ImageToPdfMimeType | null {
  return (ACCEPTED_MIME_TYPES as string[]).includes(mimeType) ? (mimeType as ImageToPdfMimeType) : null;
}

function totalBytes(images: readonly SelectedImage[]): number {
  return images.reduce((sum, image) => sum + image.file.size, 0);
}

/**
 * Image-to-pdf's own dedicated flow: choose multiple images, preview
 * thumbnails, reorder and remove before anything is uploaded, then generate
 * one PDF in the chosen order. Deliberately separate from `UploadForm` (single
 * file, immediate upload) — see the note on `processingOperations` in
 * `@media/validation` for why image-to-pdf has its own upload-initiation and
 * processing-trigger endpoints.
 *
 * Selection is entirely client-side (object URLs, never uploaded) until
 * "Generate PDF" is pressed, at which point: initiate (one Job + one presigned
 * URL per image) -> PUT every image -> complete (verifies them all) -> start
 * processing. The resulting job then appears in the file list like any other.
 */
export function ImageToPdfPanel() {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<SubmitStatus>({ kind: 'idle' });

  // Mirrors `images` so the unmount-only effect below always revokes whatever is
  // *currently* selected, not a stale closure over the empty array from the
  // first render (which an empty dependency array would otherwise capture).
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    };
  }, []);

  const isBusy = status.kind === 'uploading' || status.kind === 'processing';

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = Array.from(event.target.files ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (chosen.length === 0) return;

    const accepted = chosen
      .map((file) => ({ file, contentType: asImageToPdfMimeType(file.type) }))
      .filter((entry): entry is { file: File; contentType: ImageToPdfMimeType } => entry.contentType !== null);
    const rejectedCount = chosen.length - accepted.length;

    const room = MAX_IMAGES_PER_PDF - images.length;
    const overflow = Math.max(0, accepted.length - room);
    const toAdd = accepted.slice(0, room);

    const messages: string[] = [];
    if (rejectedCount > 0) {
      messages.push(
        `${rejectedCount} ${rejectedCount === 1 ? 'file was' : 'files were'} skipped: only JPG, PNG, and WebP images are supported.`,
      );
    }
    if (overflow > 0) {
      messages.push(`Only ${MAX_IMAGES_PER_PDF} images are allowed per PDF; ${overflow} more were not added.`);
    }
    const oversized = toAdd.filter(({ file }) => file.size > MAX_IMAGE_SIZE_BYTES);
    if (oversized.length > 0) {
      messages.push(
        `${oversized.length} ${oversized.length === 1 ? 'image is' : 'images are'} too large (max ${formatBytes(MAX_IMAGE_SIZE_BYTES)} each) and were not added.`,
      );
    }
    const withinSize = toAdd.filter(({ file }) => file.size <= MAX_IMAGE_SIZE_BYTES);

    setImages((prev) => [
      ...prev,
      ...withinSize.map(({ file, contentType }) => ({
        id: crypto.randomUUID(),
        file,
        contentType,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
    setSelectionWarning(messages.length > 0 ? messages.join(' ') : null);
    if (status.kind === 'error' || status.kind === 'success') setStatus({ kind: 'idle' });
  }

  function removeImage(id: string): void {
    setImages((prev) => {
      const target = prev.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((image) => image.id !== id);
    });
  }

  function moveImage(id: string, direction: -1 | 1): void {
    setImages((prev) => {
      const index = prev.findIndex((image) => image.id === id);
      const targetIndex = index + direction;
      if (index === -1 || targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved!);
      return next;
    });
  }

  function resetAfterSuccess(): void {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    setSelectionWarning(null);
  }

  /**
   * Runs the whole flow: initiate -> PUT every image -> complete -> start
   * processing. If `resumeJobId` is given, everything up to and including
   * `complete` already succeeded for that job (a previous attempt failed only
   * at the final "start processing" step) — only that last call is retried,
   * since re-initiating would create a second, orphaned Job.
   */
  async function runGeneratePdf(resumeJobId?: string): Promise<void> {
    const accessToken = getAccessToken();
    if (!accessToken) {
      setStatus({ kind: 'error', message: 'Your session has expired. Please log in again.' });
      return;
    }

    // Only ever set once every image is uploaded AND verified (`completeUpload`
    // has succeeded) — that is the one point at which "retry just the final
    // processing step, without re-uploading anything" is actually safe. A
    // failure any earlier (initiate, an upload, or complete itself) must fall
    // through to a full retry from scratch, so `jobId` stays undefined for the
    // catch handler below until then.
    let jobId: string | undefined;
    try {
      if (resumeJobId) {
        jobId = resumeJobId;
        setStatus({ kind: 'processing' });
      } else {
        setStatus({ kind: 'uploading', completed: 0, total: images.length });
        const initiated = await initiateImageToPdf(accessToken, {
          images: images.map((image) => ({
            fileName: image.file.name,
            contentType: image.contentType,
            contentLength: image.file.size,
          })),
        });

        for (const [index, image] of images.entries()) {
          await uploadFileToPresignedUrl(
            initiated.uploads[index]!.uploadUrl,
            image.file,
            image.contentType,
            () => {},
          );
          setStatus((prev) =>
            prev.kind === 'uploading' ? { ...prev, completed: index + 1 } : prev,
          );
        }

        setStatus({ kind: 'processing' });
        await completeUpload(accessToken, initiated.id);
        jobId = initiated.id;
      }

      await processImageToPdf(accessToken, jobId);

      setStatus({ kind: 'success' });
      resetAfterSuccess();
      await queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });
      successTimeoutRef.current = setTimeout(() => {
        setStatus((prev) => (prev.kind === 'success' ? { kind: 'idle' } : prev));
      }, 2500);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Something went wrong. Please try again.';
      setStatus({ kind: 'error', message, ...(jobId ? { recoverableJobId: jobId } : {}) });
    }
  }

  const combinedBytes = totalBytes(images);
  const overTotalSize = combinedBytes > MAX_TOTAL_IMAGE_TO_PDF_BYTES;
  const canGenerate = images.length > 0 && !isBusy && !overTotalSize;

  return (
    <div>
      <h3 className="text-base font-semibold">Combine images into a PDF</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        JPG, PNG, or WebP — choose several, put them in order, then generate one PDF.
      </p>

      <div className="mt-4">
        <label htmlFor="image-to-pdf-input" className="block text-sm font-medium">
          Choose images
        </label>
        <input
          id="image-to-pdf-input"
          ref={inputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          disabled={isBusy}
          accept={ACCEPTED_MIME_TYPES.join(',')}
          className="mt-1.5 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:file:bg-indigo-950 dark:file:text-indigo-300"
        />
      </div>

      {selectionWarning && (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          role="status"
        >
          {selectionWarning}
        </p>
      )}

      {images.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {images.length} {images.length === 1 ? 'image' : 'images'} selected
            </p>
            <p
              className={`text-xs ${overTotalSize ? 'font-semibold text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}
            >
              {formatBytes(combinedBytes)} total{overTotalSize ? ` — over the ${formatBytes(MAX_TOTAL_IMAGE_TO_PDF_BYTES)} limit` : ''}
            </p>
          </div>

          <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {images.map((image, index) => (
              <li
                key={image.id}
                className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="relative aspect-square bg-slate-100 dark:bg-slate-800">
                  {/* A local blob: URL for a not-yet-uploaded selection — never a
                      remote image next/image's optimizer could do anything with. */}
                  <img src={image.previewUrl} alt="" className="size-full object-cover" />
                  <span className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  <p className="truncate text-xs font-medium" title={image.file.name}>
                    {image.file.name}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {formatBytes(image.file.size)}
                  </p>
                  <div className="mt-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveImage(image.id, -1)}
                      disabled={index === 0 || isBusy}
                      aria-label={`Move ${image.file.name} earlier`}
                      className="flex size-7 items-center justify-center rounded-md border border-slate-300 text-xs hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveImage(image.id, 1)}
                      disabled={index === images.length - 1 || isBusy}
                      aria-label={`Move ${image.file.name} later`}
                      className="flex size-7 items-center justify-center rounded-md border border-slate-300 text-xs hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeImage(image.id)}
                      disabled={isBusy}
                      aria-label={`Remove ${image.file.name}`}
                      className="ml-auto flex size-7 items-center justify-center rounded-md border border-red-300 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {status.kind === 'uploading' && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400" aria-live="polite" role="status">
          Uploading image {Math.min(status.completed + 1, status.total)} of {status.total}…
        </p>
      )}
      {status.kind === 'processing' && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400" aria-live="polite" role="status">
          Starting the PDF conversion…
        </p>
      )}
      {status.kind === 'success' && (
        <p
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          role="status"
        >
          PDF started — see it in your files below.
        </p>
      )}
      {status.kind === 'error' && (
        <div className="mt-4">
          <ErrorState title="Could not create the PDF">{status.message}</ErrorState>
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <Button
          type="button"
          onClick={() => void runGeneratePdf(status.kind === 'error' ? status.recoverableJobId : undefined)}
          disabled={!canGenerate && status.kind !== 'error'}
        >
          {status.kind === 'error' && status.recoverableJobId ? 'Try processing again' : 'Generate PDF'}
        </Button>
        {images.length > 0 && !isBusy && (
          <button
            type="button"
            onClick={resetAfterSuccess}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
