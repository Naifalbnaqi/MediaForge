import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as AuthClient from '@media/auth-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentToPdfPanel } from './document-to-pdf-panel';
import * as uploadsApi from '@/lib/uploads-api';

vi.mock('@media/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthClient>();
  return {
    ...actual,
    useAuth: () => ({ getAccessToken: () => 'test-access-token' }),
  };
});

vi.mock('@/lib/uploads-api', () => ({
  initiateUpload: vi.fn(),
  completeUpload: vi.fn(),
  requestProcessing: vi.fn(),
  uploadFileToPresignedUrl: vi.fn(),
}));

function makeDocFile(name: string, sizeBytes = 100): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: '' });
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentToPdfPanel />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText(/choose a document/i) as HTMLInputElement;
}

/** See image-to-pdf-panel.test.tsx's identical helper: `userEvent.upload`
 * faithfully emulates a real browser's file picker, which excludes files
 * that don't match the input's own `accept` attribute before `onChange` ever
 * fires. Exercising the component's *own* rejection message needs a raw
 * `change` event that bypasses that same-library filtering. */
function selectFileBypassingAccept(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.mocked(uploadsApi.initiateUpload).mockResolvedValue({
    id: 'job-1',
    uploadUrl: 'https://storage.test/report',
    expiresAt: '2026-01-01T00:15:00.000Z',
  });
  vi.mocked(uploadsApi.uploadFileToPresignedUrl).mockResolvedValue(undefined);
  vi.mocked(uploadsApi.completeUpload).mockResolvedValue({
    id: 'job-1',
    fileName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: '100',
    status: 'UPLOADED',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  vi.mocked(uploadsApi.requestProcessing).mockResolvedValue({
    id: 'job-1',
    status: 'QUEUED',
    progress: 0,
    fileName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

describe('DocumentToPdfPanel — type detection and validation', () => {
  it.each([
    ['report.docx', 'Word document (.docx)'],
    ['slides.pptx', 'PowerPoint presentation (.pptx)'],
    ['numbers.xlsx', 'Excel workbook (.xlsx)'],
    ['notes.odt', 'OpenDocument text (.odt)'],
    ['sheet.ods', 'OpenDocument spreadsheet (.ods)'],
    ['deck.odp', 'OpenDocument presentation (.odp)'],
    ['letter.rtf', 'Rich Text document (.rtf)'],
    ['readme.txt', 'Plain text (.txt)'],
    ['legacy.doc', 'Word 97-2003 document (.doc)'],
    ['legacy.ppt', 'PowerPoint 97-2003 presentation (.ppt)'],
    ['legacy.xls', 'Excel 97-2003 workbook (.xls)'],
  ])('detects %s as %s and shows the label', async (fileName, expectedLabel) => {
    renderPanel();

    await userEvent.upload(fileInput(), makeDocFile(fileName));

    expect(screen.getByText(fileName)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(expectedLabel.replace(/[.()]/g, '\\$&')))).toBeInTheDocument();
  });

  it('shows a clear validation error for an unsupported extension, and offers no Convert button', () => {
    renderPanel();

    selectFileBypassingAccept(fileInput(), makeDocFile('image.gif'));

    expect(screen.getByText(/isn't a supported document type/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /convert to pdf/i })).not.toBeInTheDocument();
  });

  it('shows a clear validation error for a file over the size limit', async () => {
    renderPanel();
    const { MAX_DOCUMENT_SIZE_BYTES } = await import('@media/validation');

    await userEvent.upload(fileInput(), makeDocFile('huge.docx', MAX_DOCUMENT_SIZE_BYTES + 1));

    expect(screen.getByText(/over the .* limit/i)).toBeInTheDocument();
  });
});

describe('DocumentToPdfPanel — conversion', () => {
  it('on success: uploads, completes, requests document-to-pdf processing, shows a success message, and refreshes the file list', async () => {
    const { invalidateSpy } = renderPanel();
    await userEvent.upload(fileInput(), makeDocFile('report.docx'));

    await userEvent.click(screen.getByRole('button', { name: /convert to pdf/i }));

    await waitFor(() => {
      expect(screen.getByText(/is converting/i)).toBeInTheDocument();
    });
    expect(uploadsApi.initiateUpload).toHaveBeenCalledWith('test-access-token', {
      fileName: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentLength: 100,
    });
    expect(uploadsApi.uploadFileToPresignedUrl).toHaveBeenCalledWith(
      'https://storage.test/report',
      expect.any(File),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      expect.any(Function),
    );
    expect(uploadsApi.completeUpload).toHaveBeenCalledWith('test-access-token', 'job-1');
    expect(uploadsApi.requestProcessing).toHaveBeenCalledWith(
      'test-access-token',
      'job-1',
      'document-to-pdf',
    );
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('shows an error and a retry option when the upload fails', async () => {
    vi.mocked(uploadsApi.uploadFileToPresignedUrl).mockRejectedValue(new Error('Network error'));
    renderPanel();
    await userEvent.upload(fileInput(), makeDocFile('report.docx'));

    await userEvent.click(screen.getByRole('button', { name: /convert to pdf/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry conversion/i })).toBeInTheDocument();
    expect(uploadsApi.completeUpload).not.toHaveBeenCalled();
  });

  it('Cancel returns to the empty state without starting a conversion', async () => {
    renderPanel();
    await userEvent.upload(fileInput(), makeDocFile('report.docx'));

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText('report.docx')).not.toBeInTheDocument();
    expect(uploadsApi.initiateUpload).not.toHaveBeenCalled();
  });
});
