'use client';

import { useState } from 'react';
import { DocumentToPdfPanel } from '@/components/document-to-pdf-panel';
import { ImageToPdfPanel } from '@/components/image-to-pdf-panel';

type PdfTab = 'images' | 'documents';

const TABS: { value: PdfTab; label: string }[] = [
  { value: 'images', label: 'Images to PDF' },
  { value: 'documents', label: 'Documents to PDF' },
];

/**
 * The dashboard's "PDF" area: one card offering the two PDF conversion
 * workflows, switched with a standard WAI-ARIA tabs pattern (not a second
 * dashboard section) — extends the existing polished UI rather than adding a
 * new page or redesigning the layout. `ImageToPdfPanel` (multi-image, its own
 * upload-initiation path) and `DocumentToPdfPanel` (single document, the
 * existing single-file upload path) are both unchanged by being hosted here;
 * this component only owns which one is visible.
 */
export function PdfPanel() {
  const [tab, setTab] = useState<PdfTab>('images');

  return (
    <div>
      <div role="tablist" aria-label="PDF conversion type" className="flex flex-wrap gap-1.5">
        {TABS.map(({ value, label }) => {
          const selected = tab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              id={`pdf-tab-${value}`}
              aria-selected={selected}
              aria-controls={`pdf-tabpanel-${value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const currentIndex = TABS.findIndex((t) => t.value === tab);
                const nextIndex =
                  event.key === 'ArrowRight'
                    ? (currentIndex + 1) % TABS.length
                    : (currentIndex - 1 + TABS.length) % TABS.length;
                setTab(TABS[nextIndex]!.value);
              }}
              className={`inline-flex min-h-9 items-center rounded-full border px-4 py-1.5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
                selected
                  ? 'border-indigo-600 bg-indigo-600 text-white'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="pdf-tabpanel-images"
        aria-labelledby="pdf-tab-images"
        hidden={tab !== 'images'}
        className="mt-5"
      >
        <ImageToPdfPanel />
      </div>
      <div
        role="tabpanel"
        id="pdf-tabpanel-documents"
        aria-labelledby="pdf-tab-documents"
        hidden={tab !== 'documents'}
        className="mt-5"
      >
        <DocumentToPdfPanel />
      </div>
    </div>
  );
}
