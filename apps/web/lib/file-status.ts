import type { UploadedFileSummary, UploadStatus } from '@media/types';
import type { DeletableJobStatus } from '@media/validation';

/**
 * The file list's filter tabs. `active` is every non-terminal state — a file that
 * is still waiting, ready to process, or being worked on — so "Active" answers
 * "what still needs attention or is in flight". The terminal states each have
 * their own tab, and `all` (the default) hides nothing.
 */
export type FileFilter = 'all' | 'active' | 'completed' | 'failed' | 'cancelled';

export const FILE_FILTERS: readonly { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const ACTIVE_STATUSES: ReadonlySet<UploadStatus> = new Set([
  'PENDING',
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
]);

export function matchesFilter(status: UploadStatus, filter: FileFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return ACTIVE_STATUSES.has(status);
    case 'completed':
      return status === 'COMPLETED';
    case 'failed':
      return status === 'FAILED';
    case 'cancelled':
      return status === 'CANCELLED';
  }
}

/** How many of `files` each filter would show — drives the counts on the tabs. */
export function countByFilter(files: readonly UploadedFileSummary[]): Record<FileFilter, number> {
  const counts: Record<FileFilter, number> = {
    all: files.length,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const file of files) {
    if (matchesFilter(file.status, 'active')) counts.active += 1;
    else if (file.status === 'COMPLETED') counts.completed += 1;
    else if (file.status === 'FAILED') counts.failed += 1;
    else if (file.status === 'CANCELLED') counts.cancelled += 1;
  }
  return counts;
}

/** A pending bulk cleanup: which finished states it would clear, how many files
 * that is right now, and the wording the UI uses for it. */
export interface CleanupTarget {
  statuses: readonly DeletableJobStatus[];
  count: number;
  /** Button label, e.g. "Clear failed". */
  label: string;
  /** Noun phrase for the confirmation, e.g. "failed files". */
  noun: string;
}

/**
 * What a cleanup control should offer for the current filter, or `null` when there
 * is nothing it may delete: only FAILED and CANCELLED files are ever cleanable, so
 * the Active and Completed tabs (and an empty result) offer nothing. On All it
 * covers both finished states; on Failed / Cancelled just that one.
 */
export function getCleanupTarget(
  files: readonly UploadedFileSummary[],
  filter: FileFilter,
): CleanupTarget | null {
  const counts = countByFilter(files);
  const target: CleanupTarget | null =
    filter === 'failed'
      ? { statuses: ['FAILED'], count: counts.failed, label: 'Clear failed', noun: 'failed files' }
      : filter === 'cancelled'
        ? {
            statuses: ['CANCELLED'],
            count: counts.cancelled,
            label: 'Clear cancelled',
            noun: 'cancelled files',
          }
        : filter === 'all'
          ? {
              statuses: ['FAILED', 'CANCELLED'],
              count: counts.failed + counts.cancelled,
              label: 'Clean up',
              noun: 'failed and cancelled files',
            }
          : null;
  return target && target.count > 0 ? target : null;
}
