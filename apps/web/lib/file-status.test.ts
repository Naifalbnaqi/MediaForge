import type { UploadedFileSummary, UploadStatus } from '@media/types';
import { describe, expect, it } from 'vitest';
import {
  FILE_FILTERS,
  countByFilter,
  getCleanupTarget,
  matchesFilter,
  type FileFilter,
} from './file-status';

function file(status: UploadStatus, id = `job-${status}`): UploadedFileSummary {
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: '100',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const ALL_STATUSES: UploadStatus[] = [
  'PENDING',
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

describe('FILE_FILTERS', () => {
  it('lists All first (the default) and then the four groups, in a stable order', () => {
    expect(FILE_FILTERS.map((entry) => entry.value)).toEqual([
      'all',
      'active',
      'completed',
      'failed',
      'cancelled',
    ]);
  });
});

describe('matchesFilter', () => {
  it('All shows every status', () => {
    for (const status of ALL_STATUSES) expect(matchesFilter(status, 'all')).toBe(true);
  });

  it('Active is every non-terminal state: pending, uploaded, queued, processing', () => {
    const active = ALL_STATUSES.filter((status) => matchesFilter(status, 'active'));
    expect(active).toEqual(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING']);
  });

  it.each([
    ['completed', 'COMPLETED'],
    ['failed', 'FAILED'],
    ['cancelled', 'CANCELLED'],
  ] as const)('%s matches only %s', (filter, status) => {
    expect(ALL_STATUSES.filter((entry) => matchesFilter(entry, filter))).toEqual([status]);
  });

  it('every status is shown by All and by exactly one of the other filters', () => {
    const others: FileFilter[] = ['active', 'completed', 'failed', 'cancelled'];
    for (const status of ALL_STATUSES) {
      expect(matchesFilter(status, 'all')).toBe(true);
      expect(others.filter((filter) => matchesFilter(status, filter))).toHaveLength(1);
    }
  });
});

describe('countByFilter', () => {
  it('counts each group and the total, and the groups add up to the total', () => {
    const files = [
      file('PENDING'),
      file('UPLOADED'),
      file('QUEUED'),
      file('PROCESSING'),
      file('COMPLETED', 'c1'),
      file('COMPLETED', 'c2'),
      file('FAILED'),
      file('CANCELLED', 'x1'),
      file('CANCELLED', 'x2'),
      file('CANCELLED', 'x3'),
    ];

    const counts = countByFilter(files);

    expect(counts).toEqual({ all: 10, active: 4, completed: 2, failed: 1, cancelled: 3 });
    expect(counts.active + counts.completed + counts.failed + counts.cancelled).toBe(counts.all);
  });

  it('is all zeros for an empty list', () => {
    expect(countByFilter([])).toEqual({ all: 0, active: 0, completed: 0, failed: 0, cancelled: 0 });
  });
});

describe('getCleanupTarget', () => {
  const files = [
    file('FAILED', 'f1'),
    file('FAILED', 'f2'),
    file('CANCELLED', 'c1'),
    file('COMPLETED'),
    file('UPLOADED'),
    file('PROCESSING'),
  ];

  it('on All, offers both finished states with their combined count', () => {
    expect(getCleanupTarget(files, 'all')).toEqual({
      statuses: ['FAILED', 'CANCELLED'],
      count: 3,
      label: 'Clean up',
      noun: 'failed and cancelled files',
    });
  });

  it('on Failed, offers only failed files', () => {
    expect(getCleanupTarget(files, 'failed')).toMatchObject({
      statuses: ['FAILED'],
      count: 2,
      label: 'Clear failed',
    });
  });

  it('on Cancelled, offers only cancelled files', () => {
    expect(getCleanupTarget(files, 'cancelled')).toMatchObject({
      statuses: ['CANCELLED'],
      count: 1,
      label: 'Clear cancelled',
    });
  });

  it('offers nothing on Active or Completed — those are never cleanable', () => {
    expect(getCleanupTarget(files, 'active')).toBeNull();
    expect(getCleanupTarget(files, 'completed')).toBeNull();
  });

  it('offers nothing when there is nothing to clear', () => {
    const clean = [file('COMPLETED'), file('UPLOADED'), file('QUEUED')];
    expect(getCleanupTarget(clean, 'all')).toBeNull();
    expect(getCleanupTarget(clean, 'failed')).toBeNull();
    expect(getCleanupTarget(clean, 'cancelled')).toBeNull();
  });

  it('never names a status other than FAILED or CANCELLED, for any filter', () => {
    for (const { value } of FILE_FILTERS) {
      const target = getCleanupTarget(files, value);
      for (const status of target?.statuses ?? []) {
        expect(['FAILED', 'CANCELLED']).toContain(status);
      }
    }
  });
});
