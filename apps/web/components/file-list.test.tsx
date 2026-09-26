import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as AuthClient from '@media/auth-client';
import type { UploadedFileSummary, UploadStatus } from '@media/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileList } from './file-list';
import * as uploadsApi from '@/lib/uploads-api';

vi.mock('@media/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthClient>();
  return {
    ...actual,
    useAuth: () => ({ getAccessToken: () => 'test-access-token' }),
  };
});

vi.mock('@/lib/uploads-api', () => ({
  cancelUpload: vi.fn(),
  cleanupUploads: vi.fn(),
  deleteUpload: vi.fn(),
  getJobStatus: vi.fn(),
  getProcessedOutput: vi.fn(),
  listUploads: vi.fn(),
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
}));

function file(status: UploadStatus, name: string): UploadedFileSummary {
  return {
    id: `id-${name}`,
    fileName: `${name}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: '100',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const FILES: UploadedFileSummary[] = [
  file('UPLOADED', 'ready'),
  file('PENDING', 'pending'),
  file('QUEUED', 'queued'),
  file('PROCESSING', 'processing'),
  file('COMPLETED', 'done-1'),
  file('COMPLETED', 'done-2'),
  file('FAILED', 'broken-1'),
  file('FAILED', 'broken-2'),
  file('CANCELLED', 'dropped'),
];

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FileList />
    </QueryClientProvider>,
  );
}

const names = () =>
  screen
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('p[title]')?.getAttribute('title'))
    .filter(Boolean);

const filterButton = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}\\b`, 'i') });

beforeEach(() => {
  vi.mocked(uploadsApi.listUploads).mockResolvedValue({ files: FILES });
  vi.mocked(uploadsApi.getJobStatus).mockResolvedValue({
    id: 'x',
    status: 'FAILED',
    progress: 0,
    fileName: 'x.mp4',
    mimeType: 'video/mp4',
    createdAt: '2026-01-01T00:00:00.000Z',
    errorMessage: 'The uploaded file could not be converted.',
  });
});

describe('FileList — states', () => {
  it('shows a loading state, then the files', async () => {
    renderList();
    expect(screen.getByRole('status')).toHaveTextContent(/loading your files/i);

    expect(await screen.findByText('ready.mp4')).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no files, with no filters or cleanup', async () => {
    vi.mocked(uploadsApi.listUploads).mockResolvedValue({ files: [] });
    renderList();

    expect(await screen.findByText(/haven.t uploaded any files yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /filter files/i })).not.toBeInTheDocument();
  });

  it('shows the API error in an alert when the list cannot be loaded', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.listUploads).mockRejectedValue(
      new ApiError(500, { error: { code: 'INTERNAL', message: 'Something broke on our side.' } }),
    );
    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke on our side.');
  });
});

describe('FileList — filters', () => {
  it('defaults to All and shows every file, hiding nothing', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    expect(filterButton('All')).toHaveAttribute('aria-pressed', 'true');
    expect(names()).toHaveLength(FILES.length);
  });

  it('shows a count on every filter, and the groups add up to the total', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    const count = (label: string) => within(filterButton(label)).getByText(/\d+/).textContent;
    expect(count('All')).toBe('9');
    expect(count('Active')).toBe('4');
    expect(count('Completed')).toBe('2');
    expect(count('Failed')).toBe('2');
    expect(count('Cancelled')).toBe('1');
  });

  it('is exposed as a labelled group of toggle buttons, with one pressed at a time', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    const group = screen.getByRole('group', { name: /filter files by status/i });
    expect(within(group).getAllByRole('button')).toHaveLength(5);
    await userEvent.click(filterButton('Failed'));
    expect(within(group).getAllByRole('button', { pressed: true })).toEqual([
      filterButton('Failed'),
    ]);
  });

  it.each([
    ['Active', ['ready.mp4', 'pending.mp4', 'queued.mp4', 'processing.mp4']],
    ['Completed', ['done-1.mp4', 'done-2.mp4']],
    ['Failed', ['broken-1.mp4', 'broken-2.mp4']],
    ['Cancelled', ['dropped.mp4']],
  ])('%s shows exactly the matching files', async (label, expected) => {
    renderList();
    await screen.findByText('ready.mp4');

    await userEvent.click(filterButton(label));

    expect(names()).toEqual(expected);
  });

  it('returns to every file when All is chosen again', async () => {
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(filterButton('Failed'));

    await userEvent.click(filterButton('All'));

    expect(names()).toHaveLength(FILES.length);
  });

  it('explains an empty filter and offers a way back to all files', async () => {
    vi.mocked(uploadsApi.listUploads).mockResolvedValue({ files: [file('COMPLETED', 'only')] });
    renderList();
    await screen.findByText('only.mp4');

    await userEvent.click(filterButton('Failed'));

    expect(screen.getByText(/no failed files/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show all files/i }));
    expect(screen.getByText('only.mp4')).toBeInTheDocument();
  });
});

describe('FileList — bulk cleanup', () => {
  it('offers "Clean up" on All, counting only failed + cancelled files', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    expect(screen.getByRole('button', { name: 'Clean up (3)' })).toBeInTheDocument();
  });

  it('offers "Clear failed" on Failed and "Clear cancelled" on Cancelled, with their own counts', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    await userEvent.click(filterButton('Failed'));
    expect(screen.getByRole('button', { name: 'Clear failed (2)' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /clear cancelled|clean up/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(filterButton('Cancelled'));
    expect(screen.getByRole('button', { name: 'Clear cancelled (1)' })).toBeInTheDocument();
  });

  it('offers no cleanup on Active or Completed — those files can never be bulk-deleted', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    for (const label of ['Active', 'Completed']) {
      await userEvent.click(filterButton(label));
      expect(screen.queryByRole('button', { name: /clean up|clear/i })).not.toBeInTheDocument();
    }
  });

  it('offers no cleanup when nothing is failed or cancelled', async () => {
    vi.mocked(uploadsApi.listUploads).mockResolvedValue({
      files: [file('COMPLETED', 'a'), file('UPLOADED', 'b'), file('PROCESSING', 'c')],
    });
    renderList();
    await screen.findByText('a.mp4');

    expect(screen.queryByRole('button', { name: /clean up|clear/i })).not.toBeInTheDocument();
  });

  it('asks for confirmation first, in plain words, and deletes nothing yet', async () => {
    renderList();
    await screen.findByText('ready.mp4');

    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Delete failed and cancelled files?');
    expect(dialog).toHaveTextContent(/3 files \(failed and cancelled files\)/i);
    expect(dialog).toHaveTextContent(/permanently deletes/i);
    expect(dialog).toHaveTextContent(
      /completed files, files being processed, and files ready to process are never deleted/i,
    );
    expect(uploadsApi.cleanupUploads).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel closes the confirmation without deleting anything', async () => {
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(uploadsApi.cleanupUploads).not.toHaveBeenCalled();
  });

  it('confirming clears failed AND cancelled files (only those two), reports the result, and refreshes the list', async () => {
    vi.mocked(uploadsApi.cleanupUploads).mockResolvedValue({
      deleted: 3,
      skipped: 0,
      remaining: 0,
    });
    vi.mocked(uploadsApi.listUploads)
      .mockResolvedValueOnce({ files: FILES })
      .mockResolvedValue({
        files: FILES.filter((entry) => entry.status !== 'FAILED' && entry.status !== 'CANCELLED'),
      });
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete 3 files' }),
    );

    await waitFor(() =>
      expect(uploadsApi.cleanupUploads).toHaveBeenCalledWith('test-access-token', [
        'FAILED',
        'CANCELLED',
      ]),
    );
    expect(await screen.findByText('Deleted 3 files.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('broken-1.mp4')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // Everything that was not failed/cancelled is still there.
    expect(screen.getByText('done-1.mp4')).toBeInTheDocument();
    expect(screen.getByText('ready.mp4')).toBeInTheDocument();
  });

  it('on the Failed filter, sends only FAILED', async () => {
    vi.mocked(uploadsApi.cleanupUploads).mockResolvedValue({
      deleted: 2,
      skipped: 0,
      remaining: 0,
    });
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(filterButton('Failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear failed (2)' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Delete failed files?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 files' }));

    await waitFor(() =>
      expect(uploadsApi.cleanupUploads).toHaveBeenCalledWith('test-access-token', ['FAILED']),
    );
  });

  it('on the Cancelled filter, sends only CANCELLED (and says "1 file")', async () => {
    vi.mocked(uploadsApi.cleanupUploads).mockResolvedValue({
      deleted: 1,
      skipped: 0,
      remaining: 0,
    });
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(filterButton('Cancelled'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear cancelled (1)' }));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete 1 file' }),
    );

    await waitFor(() =>
      expect(uploadsApi.cleanupUploads).toHaveBeenCalledWith('test-access-token', ['CANCELLED']),
    );
    expect(await screen.findByText('Deleted 1 file.')).toBeInTheDocument();
  });

  it('says what was skipped and what remains, so nothing looks silently missed', async () => {
    vi.mocked(uploadsApi.cleanupUploads).mockResolvedValue({
      deleted: 1,
      skipped: 2,
      remaining: 4,
    });
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));

    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete 3 files' }),
    );

    // Queued/processing rows carry their own status regions, so find this one by its text.
    const notice = (await screen.findByText(/Deleted 1 file./)).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(notice).toHaveTextContent('Deleted 1 file.');
    expect(notice).toHaveTextContent(/2 files were skipped/i);
    expect(notice).toHaveTextContent(/4 files more match/i);
  });

  it('keeps the confirmation open and shows the reason when the request fails', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.cleanupUploads).mockRejectedValue(
      new ApiError(429, {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' },
      }),
    );
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 3 files' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Too many requests. Please wait a moment.',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('lets the result message be dismissed', async () => {
    vi.mocked(uploadsApi.cleanupUploads).mockResolvedValue({
      deleted: 3,
      skipped: 0,
      remaining: 0,
    });
    renderList();
    await screen.findByText('ready.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Clean up (3)' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete 3 files' }),
    );
    await screen.findByText('Deleted 3 files.');

    await userEvent.click(screen.getByRole('button', { name: /dismiss message/i }));

    expect(screen.queryByText('Deleted 3 files.')).not.toBeInTheDocument();
  });
});
