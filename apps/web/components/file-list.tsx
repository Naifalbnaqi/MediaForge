'use client';

import { ApiError, useAuth } from '@media/auth-client';
import { Button, ErrorState, LoadingState } from '@media/ui';
import type { CleanupUploadsResponse, UploadedFileSummary } from '@media/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FileRow } from '@/components/file-row';
import {
  FILE_FILTERS,
  countByFilter,
  getCleanupTarget,
  matchesFilter,
  type CleanupTarget,
  type FileFilter,
} from '@/lib/file-status';
import { cleanupUploads, listUploads } from '@/lib/uploads-api';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';

/** Files still in flight — while any file is in one of these states, the list polls. */
function hasActiveJob(files: UploadedFileSummary[]): boolean {
  return files.some((file) => file.status === 'QUEUED' || file.status === 'PROCESSING');
}

function pluralFiles(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** The one-line outcome shown after a bulk cleanup, in plain words. */
function describeCleanupResult({ deleted, skipped, remaining }: CleanupUploadsResponse): string {
  const parts = [`Deleted ${pluralFiles(deleted)}.`];
  if (skipped > 0) {
    parts.push(
      `${pluralFiles(skipped)} ${skipped === 1 ? 'was' : 'were'} skipped because ${skipped === 1 ? 'it is' : 'they are'} still being cleaned up or changed state. Try again in a few minutes.`,
    );
  }
  if (remaining > 0) {
    parts.push(`${pluralFiles(remaining)} more match — run the cleanup again to clear them.`);
  }
  return parts.join(' ');
}

export function FileList() {
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FileFilter>('all');
  const [confirmingCleanup, setConfirmingCleanup] = useState<CleanupTarget | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: UPLOADS_QUERY_KEY,
    queryFn: async () => {
      const accessToken = getAccessToken();
      if (!accessToken) {
        throw new Error('Your session has expired. Please log in again.');
      }
      return listUploads(accessToken);
    },
    // Poll only while at least one file is actively queued/processing; stop
    // (return `false`) the moment nothing is in flight, so this never runs
    // indefinitely or faster than necessary.
    refetchInterval: (currentQuery) => {
      const files = currentQuery.state.data?.files;
      return files && hasActiveJob(files) ? 4000 : false;
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: async (target: CleanupTarget) => {
      const accessToken = getAccessToken();
      if (!accessToken) {
        throw new Error('Your session has expired. Please log in again.');
      }
      return cleanupUploads(accessToken, target.statuses);
    },
    onSuccess: (result) => {
      setConfirmingCleanup(null);
      setCleanupNotice(describeCleanupResult(result));
      void queryClient.invalidateQueries({ queryKey: UPLOADS_QUERY_KEY });
    },
  });

  if (query.isPending) {
    return <LoadingState label="Loading your files" />;
  }

  if (query.isError) {
    return (
      <ErrorState title="Could not load your files">
        {query.error instanceof ApiError
          ? query.error.message
          : 'Something went wrong. Please try again.'}
      </ErrorState>
    );
  }

  const files = query.data.files;

  if (files.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        You haven&apos;t uploaded any files yet.
      </p>
    );
  }

  const counts = countByFilter(files);
  const visibleFiles = files.filter((file) => matchesFilter(file.status, filter));
  const cleanupTarget = getCleanupTarget(files, filter);
  const activeFilterLabel = FILE_FILTERS.find((entry) => entry.value === filter)?.label ?? '';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="group" aria-label="Filter files by status" className="flex flex-wrap gap-1.5">
          {FILE_FILTERS.map(({ value, label }) => {
            const selected = filter === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setFilter(value)}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
                  selected
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {label}{' '}
                <span
                  className={`tabular-nums ${selected ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-500'}`}
                >
                  {counts[value]}
                </span>
              </button>
            );
          })}
        </div>

        {cleanupTarget && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              cleanupMutation.reset();
              setConfirmingCleanup(cleanupTarget);
            }}
          >
            {cleanupTarget.label} ({cleanupTarget.count})
          </Button>
        )}
      </div>

      {cleanupNotice && (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300"
        >
          <p>{cleanupNotice}</p>
          <button
            type="button"
            onClick={() => setCleanupNotice(null)}
            aria-label="Dismiss message"
            className="-m-1 shrink-0 rounded p-1 text-slate-500 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:text-slate-100"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      )}

      {visibleFiles.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <p>No {activeFilterLabel.toLowerCase()} files.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setFilter('all')}
          >
            Show all files
          </Button>
        </div>
      ) : (
        <ul className="mt-4 space-y-3" aria-label="Your files">
          {visibleFiles.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
        </ul>
      )}

      {confirmingCleanup && (
        <ConfirmDialog
          title={`Delete ${confirmingCleanup.noun}?`}
          confirmLabel={`Delete ${pluralFiles(confirmingCleanup.count)}`}
          busyLabel="Deleting…"
          busy={cleanupMutation.isPending}
          error={
            cleanupMutation.isError
              ? cleanupMutation.error instanceof ApiError
                ? cleanupMutation.error.message
                : 'Could not clear these files. Please try again.'
              : null
          }
          onConfirm={() => cleanupMutation.mutate(confirmingCleanup)}
          onCancel={() => {
            cleanupMutation.reset();
            setConfirmingCleanup(null);
          }}
        >
          <p>
            This permanently deletes{' '}
            <span className="font-medium">
              {pluralFiles(confirmingCleanup.count)} ({confirmingCleanup.noun})
            </span>{' '}
            and their stored data. This can&apos;t be undone.
          </p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Completed files, files being processed, and files ready to process are never deleted.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
