'use client';

import { useAuth } from '@media/auth-client';
import { Button, ErrorState } from '@media/ui';
import {
  documentMimeTypeExtensions,
  documentMimeTypeLabels,
  documentMimeTypes,
  MAX_DOCUMENT_SIZE_BYTES,
  type DocumentMimeType,
} from '@media/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { formatBytes } from '@/lib/format';
import {
  completeUpload,
  initiateUpload,
  requestProcessing,
  uploadFileToPresignedUrl,
} from '@/lib/uploads-api';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';

/** File-extension lookup, not `file.type`: browsers are unreliable at
 * reporting a MIME type for office documents (some report a generic
 * `application/octet-stream`, some nothing at all, depending on OS/browser),
 * whereas the extension the user themselves gave the file is what they
 * actually expect to be respected — and it's what "clearly show the detected
 * type" means in practice. The *server* still only ever trusts its own
 * fixed enum (`initiateUploadSchema`'s `contentType`), never a client claim
 * beyond selecting one of these exact values. */
const EXTENSION_TO_MIME_TYPE: Record<string, DocumentMimeType> = Object.fromEntries(
  documentMimeTypes.map((mimeType) => [documentMimeTypeExtensions[mimeType], mimeType]),
);

function detectDocumentType(fileName: string): DocumentMimeType | null {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = fileName.slice(dot).toLowerCase();
  return EXTENSION_TO_MIME_TYPE[ext] ?? null;
}

type DocumentState =
  | { phase: 'idle' }
  | { phase: 'selected'; file: File; contentType: DocumentMimeType }
  | { phase: 'invalid'; file: File; message: string }
  | { phase: 'uploading'; file: File; progress: number }
  | { phase: 'processing'; file: File }
  | { phase: 'success'; fileName: string }
  | { phase: 'error'; message: string; file?: File; contentType?: DocumentMimeType };

/**
 * Documents-to-PDF's own flow: choose one supported office/text document,
 * see its detected type (or a clear validation error), convert, then preview/
 * download the resulting PDF from the file list below like any other job.
 * Single-input, so unlike `ImageToPdfPanel` this reuses the existing
 * single-file upload path end to end (`initiateUpload`/`completeUpload`/
 * `requestProcessing`) rather than needing any dedicated endpoint — see the
 * note on `processingOperations` in `@media/validation`.
 */
export function DocumentToPdfPanel() {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState<DocumentState>({ phase: 'idle' });

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  function reset(): void {
    setState({ phase: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0];
    if (!selected) return;

    const contentType = detectDocumentType(selected.name);
    if (!contentType) {
      setState({
        phase: 'invalid',
        file: selected,
        message: `"${selected.name}" isn't a supported document type. Allowed: DOCX, PPTX, XLSX, ODT, ODS, ODP, RTF, TXT, and the legacy DOC/PPT/XLS formats.`,
      });
      return;
    }
    if (selected.size > MAX_DOCUMENT_SIZE_BYTES) {
      setState({
        phase: 'invalid',
        file: selected,
        message: `This file is ${formatBytes(selected.size)}, over the ${formatBytes(MAX_DOCUMENT_SIZE_BYTES)} limit for document conversion.`,
      });
      return;
    }

    setState({ phase: 'selected', file: selected, contentType });
  }

  async function runConvert(file: File, contentType: DocumentMimeType): Promise<void> {
    const accessToken = getAccessToken();
    if (!accessToken) {
      setState({ phase: 'error', message: 'Your session has expired. Please log in again.' });
      return;
    }

    setState({ phase: 'uploading', file, progress: 0 });
    try {
      const initiated = await initiateUpload(accessToken, {
        fileName: file.name,
        contentType,
        contentLength: file.size,
      });

      await uploadFileToPresignedUrl(initiated.uploadUrl, file, contentType, (progress) => {
        setState((prev) => (prev.phase === 'uploading' ? { ...prev, progress } : prev));
      });

      setState({ phase: 'processing', file });
      await completeUpload(accessToken, initiated.id);
      await requestProcessing(accessToken, initiated.id, 'document-to-pdf');

      setState({ phase: 'success', fileName: file.name });
      if (inputRef.current) inputRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });

      successTimeoutRef.current = setTimeout(() => {
        setState((prev) => (prev.phase === 'success' ? { phase: 'idle' } : prev));
      }, 2500);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The conversion failed. Please try again.';
      setState({ phase: 'error', message, file, contentType });
    }
  }

  function handleConvertClick(): void {
    if (state.phase !== 'selected') return;
    void runConvert(state.file, state.contentType);
  }

  function handleRetry(): void {
    if (state.phase === 'error' && state.file && state.contentType) {
      void runConvert(state.file, state.contentType);
      return;
    }
    reset();
  }

  const isBusy = state.phase === 'uploading' || state.phase === 'processing';
  const canRetryDirectly = state.phase === 'error' && Boolean(state.file && state.contentType);

  return (
    <div>
      <h3 className="text-base font-semibold">Convert a document to PDF</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Word, PowerPoint, Excel, OpenDocument, RTF, or plain text.
      </p>

      <div className="mt-4">
        <label htmlFor="document-to-pdf-input" className="block text-sm font-medium">
          Choose a document
        </label>
        <input
          id="document-to-pdf-input"
          ref={inputRef}
          type="file"
          onChange={handleFileChange}
          disabled={isBusy}
          accept={[...documentMimeTypes, ...Object.values(documentMimeTypeExtensions)].join(',')}
          className="mt-1.5 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:file:bg-indigo-950 dark:file:text-indigo-300"
        />
      </div>

      {(state.phase === 'selected' || state.phase === 'uploading' || state.phase === 'processing') && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-800/50">
          <p className="font-medium">{state.file.name}</p>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {formatBytes(state.file.size)} ·{' '}
            {state.phase === 'selected'
              ? documentMimeTypeLabels[state.contentType]
              : 'Converting…'}
          </p>
        </div>
      )}

      {state.phase === 'invalid' && (
        <div className="mt-4">
          <ErrorState title="Unsupported file">{state.message}</ErrorState>
        </div>
      )}

      {state.phase === 'uploading' && (
        <div className="mt-4">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
            role="progressbar"
            aria-valuenow={state.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Upload progress"
          >
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${state.progress}%` }}
            />
          </div>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
            Uploading… {state.progress}%
          </p>
        </div>
      )}

      {state.phase === 'processing' && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400" aria-live="polite" role="status">
          Starting the PDF conversion…
        </p>
      )}

      {state.phase === 'success' && (
        <p
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          role="status"
        >
          &ldquo;{state.fileName}&rdquo; is converting — see it in your files below.
        </p>
      )}

      {state.phase === 'error' && (
        <div className="mt-4">
          <ErrorState title="Conversion failed">{state.message}</ErrorState>
        </div>
      )}

      <div className="mt-4 flex gap-3">
        {state.phase === 'selected' && (
          <>
            <Button type="button" onClick={handleConvertClick}>
              Convert to PDF
            </Button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </>
        )}
        {(state.phase === 'invalid' || state.phase === 'error') && (
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {canRetryDirectly ? 'Retry conversion' : 'Choose a different file'}
          </button>
        )}
      </div>
    </div>
  );
}
