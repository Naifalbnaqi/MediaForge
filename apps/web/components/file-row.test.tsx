import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as AuthClient from '@media/auth-client';
import type { UploadedFileSummary, UploadStatus } from '@media/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileRow } from './file-row';
import { UPLOADS_QUERY_KEY } from '@/lib/uploads-query-key';
import * as uploadsApi from '@/lib/uploads-api';

// Keeps the real `ApiError` class (so `error instanceof ApiError` checks inside
// FileRow still work against whatever the mocked uploads-api functions reject
// with below) while replacing `useAuth` so no real `AuthProvider`/network call is
// needed — every test just needs a stable, truthy access token.
vi.mock('@media/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthClient>();
  return {
    ...actual,
    useAuth: () => ({ getAccessToken: () => 'test-access-token' }),
  };
});

vi.mock('@/lib/uploads-api', () => ({
  cancelUpload: vi.fn(),
  deleteUpload: vi.fn(),
  getJobStatus: vi.fn(),
  getProcessedOutput: vi.fn(),
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
}));

function makeFile(overrides: Partial<UploadedFileSummary> = {}): UploadedFileSummary {
  return {
    id: 'job-1',
    fileName: 'holiday.mov',
    mimeType: 'video/quicktime',
    sizeBytes: '1000',
    status: 'PENDING',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderRow(file: UploadedFileSummary, queryClient: QueryClient = makeClient()) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ul>
          <FileRow file={file} />
        </ul>
      </QueryClientProvider>,
    ),
  };
}

const QUEUED_RESPONSE = {
  id: 'job-1',
  status: 'QUEUED',
  progress: 0,
  fileName: 'holiday.mov',
  mimeType: 'video/quicktime',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

/** Opens the Process menu and picks a tool, exactly as a user would. */
async function chooseTool(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /^process$/i }));
  await userEvent.click(screen.getByRole('menuitem', { name }));
}

beforeEach(() => {
  vi.mocked(uploadsApi.getJobStatus).mockResolvedValue({
    id: 'job-1',
    status: 'FAILED',
    progress: 0,
    fileName: 'holiday.mov',
    mimeType: 'video/quicktime',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

const ACTION_NAMES = [
  /^process$/i,
  /^cancel upload$/i,
  /^preview$/i,
  /^hide preview$/i,
  /^download$/i,
  /^retry$/i,
  /^delete$/i,
];

function visibleActions(): string[] {
  return ACTION_NAMES.filter((name) => screen.queryByRole('button', { name })).map((name) =>
    String(name),
  );
}

describe('FileRow — actions depend on status', () => {
  it.each([
    ['PENDING', ['Cancel upload']],
    ['UPLOADED', ['Process']],
    ['COMPLETED', ['Preview', 'Download']],
    ['FAILED', ['Retry', 'Delete']],
    ['CANCELLED', ['Delete']],
    ['QUEUED', []],
    ['PROCESSING', []],
  ] as const)('a %s file offers exactly these actions: %j', (status, expected) => {
    renderRow(makeFile({ status }));

    for (const label of ['Process', 'Cancel upload', 'Preview', 'Download', 'Retry', 'Delete']) {
      const present = screen.queryByRole('button', { name: new RegExp(`^${label}$`, 'i') }) !== null;
      expect(present, `${label} for ${status}`).toBe(expected.includes(label as never));
    }
  });

  it('never shows a tool button directly in the row — tools live only in the Process menu', () => {
    renderRow(makeFile({ status: 'UPLOADED', mimeType: 'video/mp4' }));

    for (const tool of ['Convert to MP4', 'Compress Video', 'Resize Video', 'Extract MP3', 'Trim Video']) {
      expect(screen.queryByRole('button', { name: tool })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: tool })).not.toBeInTheDocument();
    }
    expect(visibleActions()).toHaveLength(1);
  });

  it.each(['QUEUED', 'PROCESSING'] as const)(
    'a %s file shows a live status message instead of any operation or file action',
    (status) => {
      renderRow(makeFile({ status }));

      expect(screen.getByRole('status')).toHaveTextContent(/updates automatically/i);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );

  it('shows View/Download only for COMPLETED files', () => {
    const nonCompleted: UploadStatus[] = ['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'FAILED', 'CANCELLED'];
    for (const status of nonCompleted) {
      const { unmount } = renderRow(makeFile({ status, id: `job-${status}` }));
      expect(screen.queryByRole('button', { name: /^preview$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^download$/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it.each(['audio/mpeg', 'audio/wav', 'image/jpeg', 'image/png'])(
    'an UPLOADED %s file has no Process menu (no tool applies) and says so',
    (mimeType) => {
      renderRow(makeFile({ status: 'UPLOADED', mimeType }));

      expect(screen.queryByRole('button', { name: /^process$/i })).not.toBeInTheDocument();
      expect(screen.getByText(/no processing tools for this file type/i)).toBeInTheDocument();
    },
  );

  it.each(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'labels a %s file with a visible status word, not colour alone',
    (status) => {
      renderRow(makeFile({ status }));
      const label = status.charAt(0) + status.slice(1).toLowerCase();
      expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument();
    },
  );
});

describe('FileRow — layout structure', () => {
  it('renders the file name, type, size and date, with the full name available as a tooltip', () => {
    renderRow(makeFile({ fileName: 'a-really-long-holiday-video-name.mov', sizeBytes: '2048' }));

    const name = screen.getByText('a-really-long-holiday-video-name.mov');
    expect(name).toHaveAttribute('title', 'a-really-long-holiday-video-name.mov');
    // Truncation, not overflow: the name must be able to shrink inside its flex row.
    expect(name.className).toMatch(/\btruncate\b/);
    expect(name.className).toContain('min-w-[min(10rem,100%)]');
    expect(screen.getByText(/MOV video · 2\.0 KB/)).toBeInTheDocument();
  });

  it('wraps its actions instead of forcing a single horizontal row', () => {
    renderRow(makeFile({ status: 'FAILED' }));

    const retry = screen.getByRole('button', { name: /^retry$/i });
    expect(retry.parentElement?.className).toMatch(/\bflex-wrap\b/);
  });
});

describe('FileRow — Process menu', () => {
  it('is closed by default and marked as a menu button', () => {
    renderRow(makeFile({ status: 'UPLOADED', mimeType: 'video/mp4' }));

    const button = screen.getByRole('button', { name: /^process$/i });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click and lists the registry tools in labelled Video tools / Audio groups', async () => {
    renderRow(makeFile({ status: 'UPLOADED', mimeType: 'video/mp4' }));

    await userEvent.click(screen.getByRole('button', { name: /^process$/i }));

    expect(screen.getByRole('button', { name: /^process$/i })).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Processing tools' });
    const video = within(menu).getByRole('group', { name: 'Video tools' });
    const audio = within(menu).getByRole('group', { name: 'Audio' });
    expect(within(video).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Convert to MP4'),
      expect.stringContaining('Compress Video'),
      expect.stringContaining('Resize Video'),
      expect.stringContaining('Trim Video'),
    ]);
    expect(within(audio).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(audio).getByRole('menuitem', { name: 'Extract MP3' })).toBeInTheDocument();
  });

  it('offers exactly the tools the registry lists for the file type — no invented tools', async () => {
    renderRow(makeFile({ status: 'UPLOADED', mimeType: 'video/quicktime' }));

    await userEvent.click(screen.getByRole('button', { name: /^process$/i }));

    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    expect(screen.queryByRole('menuitem', { name: /thumbnail|mute|pdf|webm/i })).not.toBeInTheDocument();
  });

  it('describes each item without putting the description in its name', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await userEvent.click(screen.getByRole('button', { name: /^process$/i }));

    const item = screen.getByRole('menuitem', { name: 'Trim Video' });
    expect(item).toHaveAccessibleDescription(/one section of the video/i);
  });

  it('closes again when the button is clicked a second time', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await userEvent.click(screen.getByRole('button', { name: /^process$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^process$/i }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Convert to MP4 fires immediately with no options form (unchanged Phase 7A behavior) and closes the menu', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Convert to MP4');

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith(
        'test-access-token',
        'job-1',
        'convert-to-mp4',
        undefined,
      ),
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it.each([
    ['Compress Video', 'Compression level'],
    ['Resize Video', 'Resize dimensions (pixels)'],
    ['Extract MP3', 'Audio quality'],
    ['Trim Video', 'Trim range (seconds)'],
  ])('picking %s opens that tool\'s own options form, and only that one', async (tool, heading) => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool(tool);

    expect(screen.getByRole('group', { name: `${tool} options` })).toBeInTheDocument();
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('moves keyboard focus into the opened form\'s first field', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    expect(screen.getByLabelText('Width')).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await chooseTool('Trim Video');
    expect(screen.getByLabelText('Start (seconds)')).toHaveFocus();
  });

  it('switching to another tool replaces the open form', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    expect(screen.getByLabelText('Width')).toBeInTheDocument();
    await chooseTool('Extract MP3');

    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Extract MP3 options' })).toBeInTheDocument();
  });

  it('shows Starting… and disables the button while a request is being sent', async () => {
    let resolve: (value: typeof QUEUED_RESPONSE) => void = () => {};
    vi.mocked(uploadsApi.requestProcessing).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Convert to MP4');

    const button = await screen.findByRole('button', { name: /starting/i });
    expect(button).toBeDisabled();
    resolve(QUEUED_RESPONSE);
  });

  it('reports a failed processing request in plain words, in an alert', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.requestProcessing).mockRejectedValue(
      new ApiError(429, { error: { code: 'TOO_MANY_ACTIVE_JOBS', message: 'You already have 3 jobs in progress.' } }),
    );
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Convert to MP4');

    expect(await screen.findByRole('alert')).toHaveTextContent('You already have 3 jobs in progress.');
  });

  it('falls back to a generic sentence, never a raw error, for a non-API failure', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockRejectedValue(new TypeError('Failed to fetch'));
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Convert to MP4');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start processing. Please try again.');
    expect(alert).not.toHaveTextContent(/failed to fetch|typeerror/i);
  });
});

describe('FileRow — Compress Video', () => {
  it('opens a quality selector with Balanced selected by default', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');

    expect(screen.getByRole('radio', { name: /balanced/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /high quality/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /small file/i })).not.toBeChecked();
  });

  it('submits with the default Balanced preset when the user does not change the selection', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');
    // With the menu closed, "Compress Video" now names only the form's submit button.
    await userEvent.click(screen.getByRole('button', { name: 'Compress Video' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'compress-video', {
        quality: 'balanced',
      }),
    );
  });

  it('submits the selected quality preset when the user picks High Quality', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');
    await userEvent.click(screen.getByRole('radio', { name: /high quality/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Compress Video' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'compress-video', {
        quality: 'high',
      }),
    );
  });

  it('Cancel closes the form without calling requestProcessing', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');
    expect(screen.getByRole('radio', { name: /balanced/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('has exactly one "Compress Video" control while the form is open (the submit button)', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');

    expect(screen.getAllByRole('button', { name: 'Compress Video' })).toHaveLength(1);
  });

  it('re-opens cleanly (reset to Balanced) after cancelling once', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Compress Video');
    await userEvent.click(screen.getByRole('radio', { name: /high quality/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await chooseTool('Compress Video');

    expect(screen.getByRole('radio', { name: /balanced/i })).toBeChecked();
  });
});

describe('FileRow — Resize Video', () => {
  it('opens Width and Height fields', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');

    expect(screen.getByLabelText('Width')).toBeInTheDocument();
    expect(screen.getByLabelText('Height')).toBeInTheDocument();
    expect(screen.getByText(/aspect ratio is always preserved/i)).toBeInTheDocument();
  });

  it('submits width only', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.type(screen.getByLabelText('Width'), '1280');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'resize-video', {
        width: 1280,
      }),
    );
  });

  it('submits height only', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.type(screen.getByLabelText('Height'), '720');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'resize-video', {
        height: 720,
      }),
    );
  });

  it('submits width and height together', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.type(screen.getByLabelText('Width'), '1280');
    await userEvent.type(screen.getByLabelText('Height'), '720');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'resize-video', {
        width: 1280,
        height: 720,
      }),
    );
  });

  it('shows a validation error and does not submit when neither width nor height is provided', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a width, a height, or both/i);
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('shows a validation error and does not submit for a zero width', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.type(screen.getByLabelText('Width'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/positive whole number/i);
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('shows a validation error and does not submit for a width above the configured maximum', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    await userEvent.type(screen.getByLabelText('Width'), '99999');
    await userEvent.click(screen.getByRole('button', { name: 'Resize Video' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at most 7680 pixels/i);
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('Cancel closes the form without calling requestProcessing', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Resize Video');
    expect(screen.getByLabelText('Width')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Width')).not.toBeInTheDocument();
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });
});

describe('FileRow — Extract MP3', () => {
  it('opens a quality selector with Balanced selected by default', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');

    expect(screen.getByRole('radio', { name: /balanced/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /high quality/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /small file/i })).not.toBeChecked();
  });

  it('has exactly one "Extract MP3" control while the form is open (the submit button)', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');

    expect(screen.getAllByRole('button', { name: 'Extract MP3' })).toHaveLength(1);
  });

  it('submits with the default Balanced preset when the user does not change the selection', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');
    await userEvent.click(screen.getByRole('button', { name: 'Extract MP3' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'extract-mp3', {
        quality: 'balanced',
      }),
    );
  });

  it('submits the selected quality preset when the user picks High Quality', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');
    await userEvent.click(screen.getByRole('radio', { name: /high quality/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Extract MP3' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'extract-mp3', {
        quality: 'high',
      }),
    );
  });

  it('submits the small preset', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');
    await userEvent.click(screen.getByRole('radio', { name: /small file/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Extract MP3' }));

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'extract-mp3', {
        quality: 'small',
      }),
    );
  });

  it('Cancel closes the form without calling requestProcessing', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Extract MP3');
    expect(screen.getByRole('radio', { name: /balanced/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });
});

describe('FileRow — Trim Video', () => {
  async function submitTrimForm() {
    // While the form is open the menu is closed, so this is the form's own submit button.
    await userEvent.click(screen.getByRole('button', { name: 'Trim Video' }));
  }

  it('opens a form with Start prefilled with 0 and End time selected by default', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');

    expect(screen.getByLabelText('Start (seconds)')).toHaveValue(0);
    expect(screen.getByLabelText('End time (seconds)')).toHaveValue(null);
    expect(screen.getByRole('radio', { name: 'End time' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Duration' })).not.toBeChecked();
  });

  it('has exactly one "Trim Video" control while the form is open (the submit button)', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');

    expect(screen.getAllByRole('button', { name: 'Trim Video' })).toHaveLength(1);
  });

  it('switching to Duration relabels the second field', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.click(screen.getByRole('radio', { name: 'Duration' }));

    expect(screen.getByLabelText('Duration (seconds)')).toBeInTheDocument();
    expect(screen.queryByLabelText('End time (seconds)')).not.toBeInTheDocument();
  });

  it('submits start + end', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.clear(screen.getByLabelText('Start (seconds)'));
    await userEvent.type(screen.getByLabelText('Start (seconds)'), '2.5');
    await userEvent.type(screen.getByLabelText('End time (seconds)'), '10');
    await submitTrimForm();

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'trim-video', {
        start: 2.5,
        end: 10,
      }),
    );
  });

  it('submits start + duration', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.click(screen.getByRole('radio', { name: 'Duration' }));
    await userEvent.type(screen.getByLabelText('Duration (seconds)'), '15');
    await submitTrimForm();

    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'trim-video', {
        start: 0,
        duration: 15,
      }),
    );
  });

  it('switching modes clears the value, so an end time is never silently reinterpreted as a duration', async () => {
    vi.mocked(uploadsApi.requestProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.type(screen.getByLabelText('End time (seconds)'), '30');
    await userEvent.click(screen.getByRole('radio', { name: 'Duration' }));
    expect(screen.getByLabelText('Duration (seconds)')).toHaveValue(null);

    await userEvent.type(screen.getByLabelText('Duration (seconds)'), '4');
    await submitTrimForm();

    // Exactly one of end/duration is ever sent, never both.
    await waitFor(() =>
      expect(uploadsApi.requestProcessing).toHaveBeenCalledWith('test-access-token', 'job-1', 'trim-video', {
        start: 0,
        duration: 4,
      }),
    );
  });

  it('switching modes clears a previous validation error', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await submitTrimForm();
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter an end time/i);

    await userEvent.click(screen.getByRole('radio', { name: 'Duration' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['a blank start', { start: '', end: '10' }, /start must be a number of seconds/i],
    ['a negative start', { start: '-1', end: '10' }, /start must be a number of seconds/i],
    ['a start above the maximum', { start: '86401', end: '90000' }, /start must be at most 86400/i],
    ['a missing end time', { start: '1', end: '' }, /enter an end time/i],
    ['an end equal to the start', { start: '5', end: '5' }, /at least 0\.1 seconds after the start/i],
    ['an end before the start', { start: '5', end: '2' }, /at least 0\.1 seconds after the start/i],
    ['an end above the maximum', { start: '0', end: '86401' }, /end time must be at most 86400/i],
  ])('shows a validation error and does not submit for %s', async (_label, values, message) => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.clear(screen.getByLabelText('Start (seconds)'));
    if (values.start !== '') await userEvent.type(screen.getByLabelText('Start (seconds)'), values.start);
    if (values.end !== '') await userEvent.type(screen.getByLabelText('End time (seconds)'), values.end);
    await submitTrimForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing duration', '', /enter a duration/i],
    ['a duration below the minimum', '0.05', /duration must be at least 0\.1 seconds/i],
    ['a zero duration', '0', /duration must be at least 0\.1 seconds/i],
    ['a duration above the maximum', '90000', /duration must be at most 86400/i],
  ])('shows a validation error and does not submit for %s', async (_label, duration, message) => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    await userEvent.click(screen.getByRole('radio', { name: 'Duration' }));
    if (duration !== '') await userEvent.type(screen.getByLabelText('Duration (seconds)'), duration);
    await submitTrimForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });

  it('Cancel closes the form without calling requestProcessing', async () => {
    renderRow(makeFile({ status: 'UPLOADED' }));

    await chooseTool('Trim Video');
    expect(screen.getByLabelText('Start (seconds)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Start (seconds)')).not.toBeInTheDocument();
    expect(uploadsApi.requestProcessing).not.toHaveBeenCalled();
  });
});

describe('FileRow — Preview', () => {
  const VIDEO_OUTPUT = {
    jobId: 'job-1',
    fileName: 'holiday.mp4',
    mimeType: 'video/mp4',
    sizeBytes: '500',
    url: 'https://storage.test/signed-inline-url',
    expiresAt: '2026-01-01T00:15:00.000Z',
    disposition: 'inline',
  } as const;

  it('requests a fresh inline URL and plays the processed output, not the original', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue(VIDEO_OUTPUT);
    const { container } = renderRow(
      makeFile({ status: 'COMPLETED', fileName: 'holiday.mov', mimeType: 'video/quicktime' }),
    );

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    await waitFor(() => {
      expect(uploadsApi.getProcessedOutput).toHaveBeenCalledWith('test-access-token', 'job-1', 'inline');
    });
    const video = await waitFor(() => {
      const element = container.querySelector('video');
      if (!element) throw new Error('video not rendered yet');
      return element;
    });
    expect(video).toHaveAttribute('src', 'https://storage.test/signed-inline-url');
    // The processed output's own metadata is shown, never the original upload's.
    expect(screen.getByText('holiday.mp4')).toBeInTheDocument();
  });

  it('keeps the player inside the card: height-capped, width-bounded, contained', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue(VIDEO_OUTPUT);
    const { container } = renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    const video = await waitFor(() => {
      const element = container.querySelector('video');
      if (!element) throw new Error('video not rendered yet');
      return element;
    });
    expect(video.className).toMatch(/\bmax-h-72\b/);
    expect(video.className).toMatch(/\bmax-w-md\b/);
    expect(video.className).toMatch(/\bw-full\b/);
    expect(video.className).toMatch(/\bobject-contain\b/);
  });

  it('is closed by default and can be hidden again, with the button reflecting its state', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue(VIDEO_OUTPUT);
    const { container } = renderRow(makeFile({ status: 'COMPLETED' }));
    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^preview$/i })).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    const hide = await screen.findByRole('button', { name: /^hide preview$/i });
    expect(hide).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(hide);

    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeInTheDocument();
  });

  it('renders a native <audio> preview (not <video>) for an audio/mpeg processed output', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue({
      jobId: 'job-1',
      fileName: 'holiday-audio.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: '200',
      url: 'https://storage.test/signed-audio-url',
      expiresAt: '2026-01-01T00:15:00.000Z',
      disposition: 'inline',
    });
    const { container } = renderRow(
      makeFile({ status: 'COMPLETED', fileName: 'holiday.mov', mimeType: 'video/quicktime' }),
    );

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    const audio = await waitFor(() => {
      const element = container.querySelector('audio');
      if (!element) throw new Error('audio not rendered yet');
      return element;
    });
    expect(audio).toHaveAttribute('src', 'https://storage.test/signed-audio-url');
    expect(audio.className).toMatch(/\bmax-w-md\b/);
    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.getByText('holiday-audio.mp3')).toBeInTheDocument();
  });

  it('renders an inline PDF preview (not <video>/<audio>) plus an "Open in a new tab" link for an application/pdf processed output', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue({
      jobId: 'job-1',
      fileName: 'images.pdf',
      mimeType: 'application/pdf',
      sizeBytes: '4096',
      url: 'https://storage.test/signed-pdf-url',
      expiresAt: '2026-01-01T00:15:00.000Z',
      disposition: 'inline',
    });
    const { container } = renderRow(
      makeFile({ status: 'COMPLETED', fileName: 'a.jpg', mimeType: 'image/jpeg' }),
    );

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    const iframe = await waitFor(() => {
      const element = container.querySelector('iframe');
      if (!element) throw new Error('iframe not rendered yet');
      return element;
    });
    expect(iframe).toHaveAttribute('src', 'https://storage.test/signed-pdf-url');
    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(container.querySelector('audio')).not.toBeInTheDocument();
    const openLink = screen.getByRole('link', { name: /open in a new tab/i });
    expect(openLink).toHaveAttribute('href', 'https://storage.test/signed-pdf-url');
    expect(openLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText('images.pdf')).toBeInTheDocument();
  });

  it('hiding and re-opening requests a fresh URL each time rather than reusing a possibly-expired one', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue(VIDEO_OUTPUT);
    renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await waitFor(() => expect(uploadsApi.getProcessedOutput).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: /^hide preview$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    await waitFor(() => expect(uploadsApi.getProcessedOutput).toHaveBeenCalledTimes(2));
  });

  it('offers a fresh link when the player itself fails to load (an expired URL)', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue(VIDEO_OUTPUT);
    const { container } = renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    const video = await waitFor(() => {
      const element = container.querySelector('video');
      if (!element) throw new Error('video not rendered yet');
      return element;
    });
    fireEvent.error(video);

    expect(await screen.findByText(/preview link could not be loaded/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /get a fresh link/i }));
    await waitFor(() => expect(uploadsApi.getProcessedOutput).toHaveBeenCalledTimes(2));
  });

  it('shows a clear message and does not crash when the processed output is unavailable', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.getProcessedOutput).mockRejectedValue(
      new ApiError(404, {
        error: { code: 'OUTPUT_NOT_AVAILABLE', message: 'The processed file is not available' },
      }),
    );
    renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    expect(await screen.findByText('The processed file is not available')).toBeInTheDocument();
    // The row itself must still be intact — the action is still present to retry.
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeInTheDocument();
  });
});

describe('FileRow — Download', () => {
  it('requests a fresh attachment URL and triggers a browser download using the processed output filename', async () => {
    vi.mocked(uploadsApi.getProcessedOutput).mockResolvedValue({
      jobId: 'job-1',
      fileName: 'holiday.mp4',
      mimeType: 'video/mp4',
      sizeBytes: '500',
      url: 'https://storage.test/signed-download-url',
      expiresAt: '2026-01-01T00:15:00.000Z',
      disposition: 'attachment',
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let downloadAttribute: string | null = null;
    let hrefAttribute: string | null = null;
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloadAttribute = this.getAttribute('download');
      hrefAttribute = this.getAttribute('href');
    });

    renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^download$/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(uploadsApi.getProcessedOutput).toHaveBeenCalledWith('test-access-token', 'job-1', 'attachment');
    expect(downloadAttribute).toBe('holiday.mp4');
    expect(hrefAttribute).toBe('https://storage.test/signed-download-url');

    clickSpy.mockRestore();
  });

  it('shows a clear error and does not crash when the download request fails', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.getProcessedOutput).mockRejectedValue(
      new ApiError(404, {
        error: { code: 'OUTPUT_NOT_AVAILABLE', message: 'The processed file is not available' },
      }),
    );
    renderRow(makeFile({ status: 'COMPLETED' }));

    await userEvent.click(screen.getByRole('button', { name: /^download$/i }));

    expect(await screen.findByText('The processed file is not available')).toBeInTheDocument();
  });
});

describe('FileRow — Retry and Cancel remain intact', () => {
  it('Retry calls retryProcessing for the owner job', async () => {
    vi.mocked(uploadsApi.retryProcessing).mockResolvedValue(QUEUED_RESPONSE);
    renderRow(makeFile({ status: 'FAILED' }));

    await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));

    await waitFor(() => expect(uploadsApi.retryProcessing).toHaveBeenCalledWith('test-access-token', 'job-1'));
  });

  it('shows a readable message when a retry is refused', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.retryProcessing).mockRejectedValue(
      new ApiError(429, { error: { code: 'TOO_MANY_ACTIVE_JOBS', message: 'You already have 3 jobs in progress.' } }),
    );
    renderRow(makeFile({ status: 'FAILED' }));

    await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You already have 3 jobs in progress.');
  });

  it('Cancel upload calls cancelUpload for the owner job', async () => {
    vi.mocked(uploadsApi.cancelUpload).mockResolvedValue({
      id: 'job-1',
      fileName: 'holiday.mov',
      mimeType: 'video/quicktime',
      sizeBytes: '1000',
      status: 'CANCELLED',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    renderRow(makeFile({ status: 'PENDING' }));

    await userEvent.click(screen.getByRole('button', { name: /^cancel upload$/i }));

    await waitFor(() => expect(uploadsApi.cancelUpload).toHaveBeenCalledWith('test-access-token', 'job-1'));
  });
});

describe('FileRow — failure and cancellation messages', () => {
  it('shows the safe backend message for a FAILED file in a readable error block, right above Retry and Delete', async () => {
    vi.mocked(uploadsApi.getJobStatus).mockResolvedValue({
      id: 'job-1',
      status: 'FAILED',
      progress: 0,
      fileName: 'holiday.mov',
      mimeType: 'video/quicktime',
      createdAt: '2026-01-01T00:00:00.000Z',
      errorMessage: 'This video has no audio track, so there is no audio to extract.',
    });
    renderRow(makeFile({ status: 'FAILED' }));

    expect(screen.getByText('Processing failed')).toBeInTheDocument();
    expect(
      await screen.findByText('This video has no audio track, so there is no audio to extract.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('falls back to a plain sentence when the failure detail cannot be loaded, never a raw error', async () => {
    vi.mocked(uploadsApi.getJobStatus).mockRejectedValue(new TypeError('Failed to fetch'));
    renderRow(makeFile({ status: 'FAILED' }));

    expect(
      await screen.findByText('Something went wrong while processing this file.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to fetch|typeerror/i)).not.toBeInTheDocument();
  });

  it('shows a concise, non-alarming reason for a CANCELLED file', async () => {
    vi.mocked(uploadsApi.getJobStatus).mockResolvedValue({
      id: 'job-1',
      status: 'CANCELLED',
      progress: 0,
      fileName: 'holiday.mov',
      mimeType: 'video/quicktime',
      createdAt: '2026-01-01T00:00:00.000Z',
      errorMessage: 'Cancelled by you.',
    });
    renderRow(makeFile({ status: 'CANCELLED' }));

    expect(await screen.findByText('Cancelled by you.')).toBeInTheDocument();
    // Cancelled is not an error: no error block.
    expect(screen.queryByText('Processing failed')).not.toBeInTheDocument();
  });
});

describe('FileRow — Delete', () => {
  const MISSING_PAGE_ERROR = 'Could not delete this file. Please try again.';

  async function openDeleteDialog() {
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    return screen.getByRole('alertdialog');
  }

  it.each(['FAILED', 'CANCELLED'] as const)('a %s file offers Delete, and it needs confirmation first', async (status) => {
    renderRow(makeFile({ status, fileName: 'holiday.mov' }));

    const dialog = await openDeleteDialog();

    expect(dialog).toHaveAccessibleName('Delete this file?');
    expect(dialog).toHaveTextContent(/holiday\.mov/);
    expect(dialog).toHaveTextContent(/permanently deleted/i);
    expect(uploadsApi.deleteUpload).not.toHaveBeenCalled();
  });

  it('starts with focus on Cancel, not on the destructive button', async () => {
    renderRow(makeFile({ status: 'FAILED' }));

    const dialog = await openDeleteDialog();

    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel closes the dialog without deleting anything', async () => {
    renderRow(makeFile({ status: 'FAILED' }));
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(uploadsApi.deleteUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('Escape closes the dialog without deleting anything', async () => {
    renderRow(makeFile({ status: 'FAILED' }));
    const dialog = await openDeleteDialog();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(uploadsApi.deleteUpload).not.toHaveBeenCalled();
  });

  it('confirming deletes the file through the API and removes the row from the list', async () => {
    vi.mocked(uploadsApi.deleteUpload).mockResolvedValue(undefined);
    const queryClient = makeClient();
    const file = makeFile({ status: 'FAILED' });
    const other = makeFile({ id: 'job-2', status: 'COMPLETED' });
    queryClient.setQueryData(UPLOADS_QUERY_KEY, { files: [file, other] });
    renderRow(file, queryClient);
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    await waitFor(() => expect(uploadsApi.deleteUpload).toHaveBeenCalledWith('test-access-token', 'job-1'));
    await waitFor(() =>
      expect(queryClient.getQueryData<{ files: UploadedFileSummary[] }>(UPLOADS_QUERY_KEY)?.files).toEqual([other]),
    );
  });

  it('treats "already gone" (404) as success', async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.deleteUpload).mockRejectedValue(
      new ApiError(404, { error: { code: 'JOB_NOT_FOUND', message: 'Upload not found' } }),
    );
    const queryClient = makeClient();
    const file = makeFile({ status: 'CANCELLED' });
    queryClient.setQueryData(UPLOADS_QUERY_KEY, { files: [file] });
    renderRow(file, queryClient);
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    await waitFor(() =>
      expect(queryClient.getQueryData<{ files: UploadedFileSummary[] }>(UPLOADS_QUERY_KEY)?.files).toEqual([]),
    );
  });

  it("shows the API's own reason inside the dialog when deletion is refused, and keeps the dialog open", async () => {
    const { ApiError } = await import('@media/auth-client');
    vi.mocked(uploadsApi.deleteUpload).mockRejectedValue(
      new ApiError(409, {
        error: {
          code: 'UPLOAD_CLEANUP_PENDING',
          message: 'This upload was just cancelled and is still being cleaned up. Try deleting it again in a few minutes.',
        },
      }),
    );
    renderRow(makeFile({ status: 'CANCELLED' }));
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/still being cleaned up/i);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('falls back to a plain sentence for an unexpected failure', async () => {
    vi.mocked(uploadsApi.deleteUpload).mockRejectedValue(new TypeError('Failed to fetch'));
    renderRow(makeFile({ status: 'FAILED' }));
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(MISSING_PAGE_ERROR);
  });

  it('disables both buttons and cannot be dismissed while the delete is in flight', async () => {
    let resolve: () => void = () => {};
    vi.mocked(uploadsApi.deleteUpload).mockReturnValue(
      new Promise<void>((res) => {
        resolve = res;
      }),
    );
    renderRow(makeFile({ status: 'FAILED' }));
    const dialog = await openDeleteDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    const deleting = await within(dialog).findByRole('button', { name: /deleting/i });
    expect(deleting).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.click(dialog);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    resolve();
  });

  it('clicking the backdrop closes the dialog', async () => {
    renderRow(makeFile({ status: 'FAILED' }));
    const dialog = await openDeleteDialog();

    fireEvent.click(dialog);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(uploadsApi.deleteUpload).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED'] as const)(
    'a %s file has no Delete action',
    (status) => {
      renderRow(makeFile({ status }));
      expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    },
  );

  it('labels the destructive action so its purpose is clear without colour', () => {
    renderRow(makeFile({ status: 'FAILED' }));
    // A word, not just a red icon or colour.
    expect(screen.getByRole('button', { name: /^delete$/i })).toHaveTextContent('Delete');
  });
});
