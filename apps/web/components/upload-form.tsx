'use client';

import { useAuth } from '@media/auth-client';
import { Button, ErrorState } from '@media/ui';
import { type UploadMimeType } from '@media/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { formatBytes } from '@/lib/format';
import { completeUpload, initiateUpload, uploadFileToPresignedUrl } from '@/lib/uploads-api';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';

/**
 * Deliberately narrower than the full `uploadMimeTypeSchema` (which also
 * covers `document-to-pdf`'s formats, sharing this same single-file upload
 * path server-side): documents belong in the dedicated "Documents to PDF"
 * panel (`DocumentToPdfPanel`), which shows their detected type and starts
 * conversion as one action, not this general form, which offers no tool for
 * them at all once uploaded.
 */
const ACCEPTED_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'image/jpeg',
  'image/png',
] as const satisfies readonly UploadMimeType[];

type UploadState =
  | { phase: 'idle' }
  | { phase: 'selected'; file: File; contentType: UploadMimeType }
  | { phase: 'uploading'; file: File; progress: number }
  | { phase: 'success'; fileName: string }
  | { phase: 'error'; message: string; file?: File; contentType?: UploadMimeType };

export function UploadForm() {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState<UploadState>({ phase: 'idle' });

  // Clear any pending "return to idle" timer if the panel unmounts mid-timer.
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0];
    if (!selected) return;

    const contentType = (ACCEPTED_MIME_TYPES as readonly string[]).includes(selected.type)
      ? (selected.type as UploadMimeType)
      : null;
    if (!contentType) {
      setState({
        phase: 'error',
        message: `"${selected.type || 'unknown type'}" isn't a supported file type. Allowed: MP4, MOV, MP3, WAV, JPEG, PNG.`,
      });
      return;
    }

    setState({ phase: 'selected', file: selected, contentType });
  }

  function reset(): void {
    setState({ phase: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  }

  async function runUpload(file: File, contentType: UploadMimeType): Promise<void> {
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

      await completeUpload(accessToken, initiated.id);

      setState({ phase: 'success', fileName: file.name });
      if (inputRef.current) inputRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });

      successTimeoutRef.current = setTimeout(() => {
        setState((prev) => (prev.phase === 'success' ? { phase: 'idle' } : prev));
      }, 2500);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The upload failed. Please try again.';
      setState({ phase: 'error', message, file, contentType });
    }
  }

  function handleUploadClick(): void {
    if (state.phase !== 'selected') return;
    void runUpload(state.file, state.contentType);
  }

  function handleRetry(): void {
    if (state.phase === 'error' && state.file && state.contentType) {
      void runUpload(state.file, state.contentType);
      return;
    }
    reset();
  }

  const isUploading = state.phase === 'uploading';
  const canRetryDirectly = state.phase === 'error' && Boolean(state.file && state.contentType);

  return (
    <div>
      <h2 className="text-lg font-semibold">Upload a file</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        MP4, MOV, MP3, WAV, JPEG, or PNG.
      </p>

      <div className="mt-4">
        <label htmlFor="upload-file-input" className="block text-sm font-medium">
          Choose a file
        </label>
        <input
          id="upload-file-input"
          ref={inputRef}
          type="file"
          onChange={handleFileChange}
          disabled={isUploading}
          accept={ACCEPTED_MIME_TYPES.join(',')}
          className="mt-1.5 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:file:bg-indigo-950 dark:file:text-indigo-300"
        />
      </div>

      {(state.phase === 'selected' || state.phase === 'uploading') && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-800/50">
          <p className="font-medium">{state.file.name}</p>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            {formatBytes(state.file.size)} · {state.file.type}
          </p>
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

      {state.phase === 'success' && (
        <p
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          role="status"
        >
          &ldquo;{state.fileName}&rdquo; uploaded successfully.
        </p>
      )}

      {state.phase === 'error' && (
        <div className="mt-4">
          <ErrorState title="Upload failed">{state.message}</ErrorState>
        </div>
      )}

      <div className="mt-4 flex gap-3">
        {state.phase === 'selected' && (
          <>
            <Button type="button" onClick={handleUploadClick}>
              Upload
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
        {state.phase === 'error' && (
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {canRetryDirectly ? 'Retry upload' : 'Choose a different file'}
          </button>
        )}
      </div>
    </div>
  );
}
