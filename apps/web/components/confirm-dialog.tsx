'use client';

import { Button } from '@media/ui';
import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

/**
 * A modal confirmation for a destructive action, built on the native `<dialog>`
 * element: `showModal()` gives a real modal — focus is trapped inside, the rest of
 * the page is inert, Escape closes it, and the browser restores focus to the button
 * that opened it when it closes — with no focus-trap code of our own.
 *
 * "Mounted" means "open": render it while the confirmation is pending and unmount it
 * when it is answered. It focuses **Cancel**, not the destructive button, so an
 * accidental Enter never confirms. While `busy` (the request is in flight) neither
 * Escape nor a backdrop click can dismiss it, and the buttons are disabled.
 *
 * Marked `role="alertdialog"` (it interrupts to demand an answer), labelled by its
 * title and described by its body text.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel = 'Working…',
  cancelLabel = 'Cancel',
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Replaces `confirmLabel` while `busy`. */
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** A human-readable failure from the last attempt, shown inside the dialog. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    // Closing (rather than just unmounting) is what makes the browser hand focus back
    // to the element that opened the dialog.
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function handleCancelEvent(event: SyntheticEvent<HTMLDialogElement>): void {
    // Escape. Always take over from the browser so the parent's state stays the single
    // source of truth (and so a busy dialog can refuse to close).
    event.preventDefault();
    if (!busy) onCancel();
  }

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>): void {
    // A click on the dialog element itself (not its content) is a click on the backdrop.
    if (event.target === event.currentTarget && !busy) onCancel();
  }

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={handleCancelEvent}
      onClick={handleBackdropClick}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div id={descriptionId} className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {children}
        </div>
        {error && (
          <p
            className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="danger-solid"
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
