'use client';

import { ApiError, useAuth } from '@media/auth-client';
import { Button } from '@media/ui';
import type { ProcessedOutputResponse, UploadedFileSummary, UploadStatus } from '@media/types';
import {
  documentMimeTypeLabels,
  documentMimeTypes,
  type OutputDisposition,
  type ProcessingOperation,
} from '@media/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDate } from '@/lib/format';
import { getAvailableTools, type MediaToolDefinition } from '@/lib/media-tools';
import { ConfirmDialog } from './confirm-dialog';
import { OperationOptionsForm } from './operation-options-form';
import { ToolsMenu } from './tools-menu';
import {
  cancelUpload,
  deleteUpload,
  getJobStatus,
  getProcessedOutput,
  requestProcessing,
  retryProcessing,
} from '@/lib/uploads-api';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';

/**
 * Navigates to a presigned URL to start a download. The `Content-Disposition:
 * attachment` that actually forces the save is signed into the URL server-side; the
 * `download` attribute here is only a same-origin hint and is ignored cross-origin.
 */
function startBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

const MIME_LABELS: Record<string, string> = {
  'video/mp4': 'MP4 video',
  'video/quicktime': 'MOV video',
  'audio/mpeg': 'MP3 audio',
  'audio/wav': 'WAV audio',
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'image/webp': 'WebP image',
  'application/pdf': 'PDF document',
  ...documentMimeTypeLabels,
};

/**
 * Visual treatment per `UploadStatus`, deliberately distinct per state so
 * "Queued" and "Processing" (the two active/in-flight states) never look
 * identical to each other or to the terminal states. The text label always
 * carries the meaning — color is only reinforcement.
 */
const STATUS_BADGES: Record<UploadStatus, { label: string; className: string }> = {
  PENDING: {
    label: 'Pending',
    className:
      'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  UPLOADED: {
    label: 'Uploaded',
    className:
      'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300',
  },
  QUEUED: {
    label: 'Queued',
    className:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  },
  PROCESSING: {
    label: 'Processing',
    className:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  },
  COMPLETED: {
    label: 'Completed',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  },
  FAILED: {
    label: 'Failed',
    className:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  },
  CANCELLED: {
    label: 'Cancelled',
    className:
      'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
};

function StatusBadge({ status }: { status: UploadStatus }) {
  const { label, className } = STATUS_BADGES[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}
    >
      {status === 'QUEUED' && (
        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      )}
      {status === 'PROCESSING' && (
        <span
          className="size-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent"
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
}

/** A small glyph for the kind of file, next to its name — purely decorative. */
function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const kind = mimeType.startsWith('video/')
    ? 'video'
    : mimeType.startsWith('audio/')
      ? 'audio'
      : mimeType === 'application/pdf' || (documentMimeTypes as readonly string[]).includes(mimeType)
        ? 'document'
        : 'image';
  const path =
    kind === 'video'
      ? 'M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.5v-9Zm5.75 1.6a.5.5 0 0 0-.75.43v5.94a.5.5 0 0 0 .75.43l5.1-2.97a.5.5 0 0 0 0-.86L8.75 7.1Z'
      : kind === 'audio'
        ? 'M17.72 1.6a.75.75 0 0 1 .28.58v11.29a2.25 2.25 0 0 1-1.77 2.2l-2.04.44a2.22 2.22 0 0 1-.94-4.33l2.66-.58a.75.75 0 0 0 .59-.73V6.11l-8 1.73v7.69a2.25 2.25 0 0 1-1.77 2.2l-2.04.44a2.22 2.22 0 1 1-.94-4.33l2.66-.57A.75.75 0 0 0 7 12.53V4.24a.75.75 0 0 1 .59-.74l9.5-2.05a.75.75 0 0 1 .63.15Z'
        : kind === 'document'
          ? 'M5.5 2A1.5 1.5 0 0 0 4 3.5v13A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5V7.06a1.5 1.5 0 0 0-.44-1.06l-3.56-3.56A1.5 1.5 0 0 0 10.94 2H5.5ZM11 3.25 14.75 7H11.5a.5.5 0 0 1-.5-.5V3.25ZM6.5 10.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1Zm0 3h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1Z'
          : 'M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.5v-9Zm2 8.5h10l-3.2-4.3-2.3 3-1.5-1.9L5 14Zm2.25-6.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z';
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd" className="size-5">
        <path d={path} clipRule="evenodd" />
      </svg>
    </span>
  );
}

/** The wording for a failed request: the API's own message when it sent one (always
 * safe, human-readable text), otherwise a plain fallback — never a raw error. */
function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function FileRow({ file }: { file: UploadedFileSummary }) {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ProcessedOutputResponse | null>(null);
  // The tool whose options-collection form is currently expanded, if any — a
  // tool with `optionsKind: 'none'` (Convert to MP4) never sets this; it fires
  // immediately when picked from the menu, same as every Phase 7A tool did.
  const [activeOptionsTool, setActiveOptionsTool] = useState<MediaToolDefinition | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Set when the <video> element itself fails to load (most likely an expired URL).
  // Recovery is deliberately user-initiated — never an automatic refetch — so a
  // persistently broken object can't spin into an unbounded retry loop.
  const [previewFailed, setPreviewFailed] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  // Move focus into the options form as it opens, so a keyboard user who picked a
  // tool from the menu lands on its first field instead of being left on the button.
  useEffect(() => {
    if (!activeOptionsTool) return;
    const region = optionsRef.current;
    const firstControl = region?.querySelector<HTMLElement>('input, select, textarea');
    (firstControl ?? region)?.focus();
  }, [activeOptionsTool]);

  function requireAccessToken(): string {
    const accessToken = getAccessToken();
    if (!accessToken) {
      throw new Error('Your session has expired. Please log in again.');
    }
    return accessToken;
  }

  async function fetchOutput(disposition: OutputDisposition): Promise<ProcessedOutputResponse> {
    // Always fetched fresh per action: these URLs are short-lived by design.
    return getProcessedOutput(requireAccessToken(), file.id, disposition);
  }

  const previewMutation = useMutation({
    mutationFn: () => fetchOutput('inline'),
    onSuccess: (output) => {
      setPreview(output);
      setPreviewFailed(false);
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () => fetchOutput('attachment'),
    onSuccess: (output) => startBrowserDownload(output.url, output.fileName),
  });

  // Optimistically reflects a job's new status immediately (so the list's
  // `refetchInterval` sees an active job and resumes polling right away),
  // then reconciles with the server on the next interval-driven refetch.
  function applyOptimisticStatus(status: UploadedFileSummary['status']): void {
    queryClient.setQueryData<{ files: UploadedFileSummary[] }>(UPLOADS_QUERY_KEY, (previous) => {
      if (!previous) return previous;
      return {
        files: previous.files.map((entry) => (entry.id === file.id ? { ...entry, status } : entry)),
      };
    });
    void queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });
  }

  const statusQueryKey = ['uploads', file.id, 'status'] as const;

  const mutation = useMutation({
    mutationFn: async ({
      operation,
      options,
    }: {
      operation: ProcessingOperation;
      options?: Record<string, unknown>;
    }) => requestProcessing(requireAccessToken(), file.id, operation, options),
    onSuccess: (result) => {
      applyOptimisticStatus(result.status);
      setActiveOptionsTool(null);
    },
  });

  const retryMutation = useMutation({
    mutationFn: async () => retryProcessing(requireAccessToken(), file.id),
    onSuccess: (result) => {
      // Drop the cached failure text so a second failure shows its own message,
      // not the first one's.
      queryClient.removeQueries({ queryKey: statusQueryKey });
      applyOptimisticStatus(result.status);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => cancelUpload(requireAccessToken(), file.id),
    onSuccess: (result) => applyOptimisticStatus(result.status),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      try {
        await deleteUpload(requireAccessToken(), file.id);
      } catch (error) {
        // 404 means it is already gone (a double click, or removed in another tab) —
        // exactly the outcome the user asked for, so treat it as success.
        if (error instanceof ApiError && error.status === 404) return;
        throw error;
      }
    },
    onSuccess: () => {
      setConfirmingDelete(false);
      queryClient.setQueryData<{ files: UploadedFileSummary[] }>(UPLOADS_QUERY_KEY, (previous) =>
        previous ? { files: previous.files.filter((entry) => entry.id !== file.id) } : previous,
      );
      queryClient.removeQueries({ queryKey: statusQueryKey });
      void queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });
    },
  });

  function handleToolSelected(tool: MediaToolDefinition): void {
    if (tool.optionsKind === 'none') {
      setActiveOptionsTool(null);
      mutation.mutate({ operation: tool.operation });
      return;
    }
    setActiveOptionsTool(tool);
  }

  const availableTools = getAvailableTools(file.mimeType);
  const isPending = file.status === 'PENDING';
  const isUploaded = file.status === 'UPLOADED';
  const isActive = file.status === 'QUEUED' || file.status === 'PROCESSING';
  const isCompleted = file.status === 'COMPLETED';
  const isFailed = file.status === 'FAILED';
  const isCancelled = file.status === 'CANCELLED';

  // `UploadedFileSummary` (the list row shape) has no `errorMessage` field —
  // only the single-job `JobStatusResponse` does. FAILED/CANCELLED are terminal
  // states, so this is a one-shot detail fetch, not part of the list's
  // ongoing polling (no `refetchInterval` here). A CANCELLED job's reason covers
  // both a user-initiated cancel and the background stale-upload sweep expiring an
  // abandoned one — the server picks the message either way.
  const failureDetail = useQuery({
    queryKey: statusQueryKey,
    queryFn: async () => getJobStatus(requireAccessToken(), file.id),
    enabled: isFailed || isCancelled,
    staleTime: Infinity,
    retry: false,
  });
  const failureMessage = failureDetail.data?.errorMessage;

  // One place for "something the user just tried didn't work", shown next to the
  // actions it concerns.
  const actionError = mutation.isError
    ? errorText(mutation.error, 'Could not start processing. Please try again.')
    : retryMutation.isError
      ? errorText(retryMutation.error, 'Could not retry processing. Please try again.')
      : cancelMutation.isError
        ? errorText(cancelMutation.error, 'Could not cancel this upload. Please try again.')
        : isCompleted && previewMutation.isError
          ? errorText(previewMutation.error, 'Could not prepare the processed file. Please try again.')
          : isCompleted && downloadMutation.isError
            ? errorText(downloadMutation.error, 'Could not prepare the processed file. Please try again.')
            : null;

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/40">
      <div className="flex items-start gap-3">
        <FileTypeIcon mimeType={file.mimeType} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
            <p className="min-w-[min(10rem,100%)] flex-1 truncate text-sm font-semibold" title={file.fileName}>
              {file.fileName}
            </p>
            <StatusBadge status={file.status} />
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {isCompleted && <span className="font-medium">Original · </span>}
            {MIME_LABELS[file.mimeType] ?? file.mimeType} · {formatBytes(Number(file.sizeBytes))} ·{' '}
            {formatDate(file.createdAt)}
          </p>
        </div>
      </div>

      {isPending && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Waiting for the upload to finish. If it was interrupted, you can cancel it.
        </p>
      )}

      {isUploaded && availableTools.length === 0 && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          There are no processing tools for this file type yet.
        </p>
      )}

      {isActive && (
        <div className="mt-3" role="status">
          <div
            className="h-1 rounded-full bg-sky-500/60 motion-safe:animate-pulse dark:bg-sky-400/50"
            aria-hidden="true"
          />
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            {file.status === 'QUEUED'
              ? 'Waiting for a free worker. This updates automatically.'
              : 'Processing in the background. This updates automatically.'}
          </p>
        </div>
      )}

      {isFailed && (
        <div className="mt-3 flex gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm dark:border-red-900/70 dark:bg-red-950/30">
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-4.5a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 10 5.5Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
          <div className="min-w-0">
            <p className="font-medium text-red-800 dark:text-red-200">Processing failed</p>
            <p className="mt-0.5 break-words text-red-700 dark:text-red-300">
              {failureMessage ??
                (failureDetail.isPending
                  ? 'Loading details…'
                  : 'Something went wrong while processing this file.')}
            </p>
          </div>
        </div>
      )}

      {isCancelled && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {failureMessage ?? 'This upload was cancelled.'}
        </p>
      )}

      {actionError && (
        <p className="mt-3 text-xs font-medium text-red-700 dark:text-red-400" role="alert">
          {actionError}
        </p>
      )}

      {(isPending || isUploaded || isCompleted || isFailed || isCancelled) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isPending && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel upload'}
            </Button>
          )}

          {isUploaded && availableTools.length > 0 && (
            <ToolsMenu
              tools={availableTools}
              onSelect={handleToolSelected}
              disabled={mutation.isPending}
              busy={mutation.isPending}
            />
          )}

          {isCompleted && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-expanded={preview !== null}
                onClick={() => {
                  if (preview) {
                    setPreview(null);
                    setPreviewFailed(false);
                  } else {
                    previewMutation.mutate();
                  }
                }}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? 'Preparing…' : preview ? 'Hide preview' : 'Preview'}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => downloadMutation.mutate()}
                disabled={downloadMutation.isPending}
              >
                {downloadMutation.isPending ? 'Preparing…' : 'Download'}
              </Button>
            </>
          )}

          {isFailed && (
            <Button
              type="button"
              size="sm"
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
            >
              {retryMutation.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          )}

          {(isFailed || isCancelled) && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                deleteMutation.reset();
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          )}
        </div>
      )}

      {activeOptionsTool && activeOptionsTool.optionsKind !== 'none' && isUploaded && (
        <div
          ref={optionsRef}
          tabIndex={-1}
          role="group"
          aria-label={`${activeOptionsTool.label} options`}
          className="mt-3 outline-none"
        >
          <OperationOptionsForm
            optionsKind={activeOptionsTool.optionsKind}
            isSubmitting={mutation.isPending}
            onSubmit={(options) => mutation.mutate({ operation: activeOptionsTool.operation, options })}
            onCancel={() => setActiveOptionsTool(null)}
          />
        </div>
      )}

      {preview && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
            Result
          </p>
          <p className="mt-1 truncate text-sm font-medium" title={preview.fileName}>
            {preview.fileName}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {MIME_LABELS[preview.mimeType] ?? preview.mimeType} · {formatBytes(Number(preview.sizeBytes))}
          </p>
          {previewFailed ? (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                This preview link could not be loaded — it may have expired.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? 'Preparing…' : 'Get a fresh link'}
              </Button>
            </div>
          ) : preview.mimeType.startsWith('audio/') ? (
            // Minimal native audio preview for MP3 output — not the full
            // generic multi-MIME preview system (later phase), just reusing
            // the same already-fetched preview URL/error handling as video.
            <audio
              key={preview.url}
              src={preview.url}
              controls
              preload="metadata"
              onError={() => setPreviewFailed(true)}
              className="mt-2.5 w-full max-w-md"
            >
              Your browser cannot play this audio. Use Download instead.
            </audio>
          ) : preview.mimeType === 'application/pdf' ? (
            // Most desktop browsers render a PDF inline in an <iframe> via their
            // built-in viewer; where that isn't supported (notably some mobile
            // browsers), the link below still opens or downloads it directly —
            // "preview where supported", never a dead end either way.
            <div className="mt-2.5">
              <iframe
                key={preview.url}
                src={preview.url}
                title={`Preview of ${preview.fileName}`}
                className="h-[32rem] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-700"
              />
              <a
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open in a new tab
              </a>
            </div>
          ) : (
            // Keyed on the URL so a freshly-issued link remounts the element rather
            // than leaving the browser sitting on the previously-failed source. Height
            // is capped so a tall or portrait video never turns the row into a wall.
            <video
              key={preview.url}
              src={preview.url}
              controls
              preload="metadata"
              onError={() => setPreviewFailed(true)}
              className="mt-2.5 max-h-72 w-full max-w-md rounded-lg bg-black object-contain"
            >
              Your browser cannot play this video. Use Download instead.
            </video>
          )}
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this file?"
          confirmLabel="Delete file"
          busyLabel="Deleting…"
          busy={deleteMutation.isPending}
          error={
            deleteMutation.isError
              ? errorText(deleteMutation.error, 'Could not delete this file. Please try again.')
              : null
          }
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => {
            deleteMutation.reset();
            setConfirmingDelete(false);
          }}
        >
          <p>
            <span className="font-medium">{file.fileName}</span> and its stored data will be
            permanently deleted. This can&apos;t be undone.
          </p>
        </ConfirmDialog>
      )}
    </li>
  );
}
