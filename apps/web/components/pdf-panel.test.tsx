import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as AuthClient from '@media/auth-client';
import { describe, expect, it, vi } from 'vitest';
import { PdfPanel } from './pdf-panel';

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
  initiateUpload: vi.fn(),
  requestProcessing: vi.fn(),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PdfPanel />
    </QueryClientProvider>,
  );
}

describe('PdfPanel', () => {
  it('defaults to the Images to PDF tab, selected and visible', () => {
    renderPanel();

    const imagesTab = screen.getByRole('tab', { name: /images to pdf/i });
    const documentsTab = screen.getByRole('tab', { name: /documents to pdf/i });
    expect(imagesTab).toHaveAttribute('aria-selected', 'true');
    expect(documentsTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Combine images into a PDF')).toBeVisible();
  });

  it('switches to the Documents to PDF panel on click, hiding the Images panel', async () => {
    renderPanel();

    await userEvent.click(screen.getByRole('tab', { name: /documents to pdf/i }));

    expect(screen.getByRole('tab', { name: /documents to pdf/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /images to pdf/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Convert a document to PDF')).toBeVisible();
    expect(screen.getByText('Combine images into a PDF')).not.toBeVisible();
  });

  it('supports arrow-key navigation between tabs', async () => {
    renderPanel();
    const imagesTab = screen.getByRole('tab', { name: /images to pdf/i });
    imagesTab.focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: /documents to pdf/i })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowLeft}');

    expect(screen.getByRole('tab', { name: /images to pdf/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('each tabpanel is correctly associated with its tab via aria-controls/aria-labelledby', () => {
    renderPanel();

    const imagesTab = screen.getByRole('tab', { name: /images to pdf/i });
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    const imagesPanel = panels.find((p) => p.id === imagesTab.getAttribute('aria-controls'));
    expect(imagesPanel).toBeDefined();
    expect(imagesPanel).toHaveAttribute('aria-labelledby', imagesTab.id);
  });
});
