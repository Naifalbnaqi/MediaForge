import { FileList } from '@/components/file-list';
import { PdfPanel } from '@/components/pdf-panel';
import { UploadForm } from '@/components/upload-form';

const SECTION_CLASS =
  'rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6';

/**
 * The dashboard's working area: an upload card, the PDF conversion card
 * (images and documents, see `PdfPanel`), then the user's own file list, each
 * on the full width of the content column (the list needs the room — each
 * file is a card with its own status, actions and preview). Upload success
 * and a started PDF conversion both refresh the list automatically (see
 * `UploadForm` and `PdfPanel`'s two sub-panels).
 */
export function UploadPanel() {
  return (
    <div className="space-y-6">
      <section className={SECTION_CLASS}>
        <UploadForm />
      </section>

      <section className={SECTION_CLASS} aria-labelledby="pdf-panel-heading">
        <h2 id="pdf-panel-heading" className="text-lg font-semibold">
          PDF tools
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Combine images or convert a document into a PDF.
        </p>
        <div className="mt-4">
          <PdfPanel />
        </div>
      </section>

      <section className={SECTION_CLASS} aria-labelledby="my-files-heading">
        <h2 id="my-files-heading" className="text-lg font-semibold">
          My files
        </h2>
        <div className="mt-4">
          <FileList />
        </div>
      </section>
    </div>
  );
}
