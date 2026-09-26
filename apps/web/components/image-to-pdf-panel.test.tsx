import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as AuthClient from '@media/auth-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageToPdfPanel } from './image-to-pdf-panel';
import * as uploadsApi from '@/lib/uploads-api';

vi.mock('@media/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthClient>();
  return {
    ...actual,
    useAuth: () => ({ getAccessToken: () => 'test-access-token' }),
  };
});

vi.mock('@/lib/uploads-api', () => ({
  initiateImageToPdf: vi.fn(),
  completeUpload: vi.fn(),
  processImageToPdf: vi.fn(),
  uploadFileToPresignedUrl: vi.fn(),
}));

function makeImageFile(name: string, type: string, sizeBytes = 100): File {
  const file = new File([new Uint8Array(sizeBytes)], name, { type });
  return file;
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <ImageToPdfPanel />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText(/choose images/i) as HTMLInputElement;
}

/**
 * `userEvent.upload` faithfully emulates a real browser's file picker, which
 * silently excludes files that don't match the input's own `accept` attribute
 * before they ever reach `onChange` — exactly like a real OS picker filtered
 * to JPG/PNG/WebP would. The component's own rejection message is a defense
 * for the paths that *do* still reach `onChange` with a mismatched file (drag
 * and drop, or a browser/OS that doesn't enforce `accept`), so exercising it
 * needs to bypass that same-library filtering via a raw `change` event.
 */
function selectFilesBypassingAccept(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const thumbnailNames = () =>
  screen.getAllByRole('listitem').map((item) => within(item).getByTitle(/./).textContent);

beforeEach(() => {
  vi.mocked(uploadsApi.initiateImageToPdf).mockResolvedValue({
    id: 'job-1',
    uploads: [
      { uploadUrl: 'https://storage.test/a', expiresAt: '2026-01-01T00:15:00.000Z' },
      { uploadUrl: 'https://storage.test/b', expiresAt: '2026-01-01T00:15:00.000Z' },
    ],
  });
  vi.mocked(uploadsApi.uploadFileToPresignedUrl).mockResolvedValue(undefined);
  vi.mocked(uploadsApi.completeUpload).mockResolvedValue({
    id: 'job-1',
    fileName: 'a.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: '100',
    status: 'UPLOADED',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  vi.mocked(uploadsApi.processImageToPdf).mockResolvedValue({
    id: 'job-1',
    status: 'QUEUED',
    progress: 0,
    fileName: 'a.jpg',
    mimeType: 'image/jpeg',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

describe('ImageToPdfPanel — selection', () => {
  it('adds valid JPG/PNG/WebP files as thumbnails, showing the count', async () => {
    renderPanel();
    const files = [
      makeImageFile('a.jpg', 'image/jpeg'),
      makeImageFile('b.png', 'image/png'),
      makeImageFile('c.webp', 'image/webp'),
    ];

    await userEvent.upload(fileInput(), files);

    expect(screen.getByText('3 images selected')).toBeInTheDocument();
    expect(thumbnailNames()).toEqual(['a.jpg', 'b.png', 'c.webp']);
  });

  it('rejects an unsupported file type with a warning, and does not add it', () => {
    renderPanel();

    selectFilesBypassingAccept(fileInput(), [
      makeImageFile('a.jpg', 'image/jpeg'),
      makeImageFile('doc.gif', 'image/gif'),
    ]);

    expect(screen.getByText('1 image selected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/only jpg, png, and webp/i);
  });

  it('rejects an image over the per-image size limit, with a warning', async () => {
    renderPanel();
    const { MAX_IMAGE_SIZE_BYTES } = await import('@media/validation');

    await userEvent.upload(fileInput(), [
      makeImageFile('big.jpg', 'image/jpeg', MAX_IMAGE_SIZE_BYTES + 1),
    ]);

    expect(screen.queryByText(/1 image selected/i)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/too large/i);
  });

  it('appends a second selection to the first rather than replacing it', async () => {
    renderPanel();
    await userEvent.upload(fileInput(), [makeImageFile('a.jpg', 'image/jpeg')]);

    await userEvent.upload(fileInput(), [makeImageFile('b.png', 'image/png')]);

    expect(thumbnailNames()).toEqual(['a.jpg', 'b.png']);
  });

  it('shows the running total size, and flags it once it exceeds the aggregate limit', async () => {
    renderPanel();
    const { MAX_TOTAL_IMAGE_TO_PDF_BYTES, MAX_IMAGE_SIZE_BYTES } = await import('@media/validation');
    const perImage = MAX_IMAGE_SIZE_BYTES;
    const count = Math.ceil(MAX_TOTAL_IMAGE_TO_PDF_BYTES / perImage) + 1;
    const files = Array.from({ length: count }, (_, i) => makeImageFile(`${i}.jpg`, 'image/jpeg', perImage));

    await userEvent.upload(fileInput(), files);

    expect(screen.getByText(/over the .* limit/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate pdf/i })).toBeDisabled();
  });
});

describe('ImageToPdfPanel — reorder and remove', () => {
  async function selectThree() {
    renderPanel();
    await userEvent.upload(fileInput(), [
      makeImageFile('a.jpg', 'image/jpeg'),
      makeImageFile('b.png', 'image/png'),
      makeImageFile('c.webp', 'image/webp'),
    ]);
  }

  it('moves an image earlier, changing its position in the list', async () => {
    await selectThree();

    await userEvent.click(screen.getByRole('button', { name: /move c\.webp earlier/i }));

    expect(thumbnailNames()).toEqual(['a.jpg', 'c.webp', 'b.png']);
  });

  it('moves an image later, changing its position in the list', async () => {
    await selectThree();

    await userEvent.click(screen.getByRole('button', { name: /move a\.jpg later/i }));

    expect(thumbnailNames()).toEqual(['b.png', 'a.jpg', 'c.webp']);
  });

  it('disables "move earlier" on the first image and "move later" on the last', async () => {
    await selectThree();

    expect(screen.getByRole('button', { name: /move a\.jpg earlier/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move c\.webp later/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move a\.jpg later/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /move c\.webp earlier/i })).toBeEnabled();
  });

  it('removes an image, decrementing the count and dropping it from the order', async () => {
    await selectThree();

    await userEvent.click(screen.getByRole('button', { name: /remove b\.png/i }));

    expect(screen.getByText('2 images selected')).toBeInTheDocument();
    expect(thumbnailNames()).toEqual(['a.jpg', 'c.webp']);
  });

  it('"Clear all" removes every selected image', async () => {
    await selectThree();

    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));

    expect(screen.queryByText(/images? selected/i)).not.toBeInTheDocument();
  });
});

describe('ImageToPdfPanel — generating the PDF', () => {
  it('on success: uploads every image in order, completes, starts processing, shows a success message, and refreshes the file list', async () => {
    const { invalidateSpy } = renderPanel();
    await userEvent.upload(fileInput(), [
      makeImageFile('a.jpg', 'image/jpeg'),
      makeImageFile('b.png', 'image/png'),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /generate pdf/i }));

    await waitFor(() => {
      expect(screen.getByText(/pdf started/i)).toBeInTheDocument();
    });
    expect(uploadsApi.initiateImageToPdf).toHaveBeenCalledWith('test-access-token', {
      images: [
        { fileName: 'a.jpg', contentType: 'image/jpeg', contentLength: 100 },
        { fileName: 'b.png', contentType: 'image/png', contentLength: 100 },
      ],
    });
    expect(uploadsApi.uploadFileToPresignedUrl).toHaveBeenNthCalledWith(
      1,
      'https://storage.test/a',
      expect.any(File),
      'image/jpeg',
      expect.any(Function),
    );
    expect(uploadsApi.uploadFileToPresignedUrl).toHaveBeenNthCalledWith(
      2,
      'https://storage.test/b',
      expect.any(File),
      'image/png',
      expect.any(Function),
    );
    expect(uploadsApi.completeUpload).toHaveBeenCalledWith('test-access-token', 'job-1');
    expect(uploadsApi.processImageToPdf).toHaveBeenCalledWith('test-access-token', 'job-1');
    expect(invalidateSpy).toHaveBeenCalled();
    // The selection resets once the job has started.
    expect(screen.queryByText(/images? selected/i)).not.toBeInTheDocument();
  });

  it('is disabled with no images selected', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /generate pdf/i })).toBeDisabled();
  });

  it('shows an error and does not offer a targeted retry when the upload step itself fails', async () => {
    vi.mocked(uploadsApi.uploadFileToPresignedUrl).mockRejectedValue(new Error('Network error'));
    renderPanel();
    await userEvent.upload(fileInput(), [makeImageFile('a.jpg', 'image/jpeg')]);

    await userEvent.click(screen.getByRole('button', { name: /generate pdf/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(uploadsApi.completeUpload).not.toHaveBeenCalled();
    expect(uploadsApi.processImageToPdf).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^generate pdf$/i })).toBeInTheDocument();
  });

  it('offers a targeted "Try processing again" retry (no re-upload) when only the final processing step fails', async () => {
    vi.mocked(uploadsApi.processImageToPdf).mockRejectedValueOnce(new Error('Temporary system error'));
    renderPanel();
    await userEvent.upload(fileInput(), [makeImageFile('a.jpg', 'image/jpeg')]);

    await userEvent.click(screen.getByRole('button', { name: /generate pdf/i }));

    const retryButton = await screen.findByRole('button', { name: /try processing again/i });
    expect(uploadsApi.initiateImageToPdf).toHaveBeenCalledTimes(1);
    expect(uploadsApi.completeUpload).toHaveBeenCalledTimes(1);

    await userEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText(/pdf started/i)).toBeInTheDocument();
    });
    // Retrying only re-calls processImageToPdf — never re-initiates or re-uploads.
    expect(uploadsApi.initiateImageToPdf).toHaveBeenCalledTimes(1);
    expect(uploadsApi.completeUpload).toHaveBeenCalledTimes(1);
    expect(uploadsApi.processImageToPdf).toHaveBeenCalledTimes(2);
    expect(uploadsApi.processImageToPdf).toHaveBeenLastCalledWith('test-access-token', 'job-1');
  });
});
