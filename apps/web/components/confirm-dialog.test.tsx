import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function setup(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Delete this file?"
      confirmLabel="Delete file"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    >
      <p>This cannot be undone.</p>
    </ConfirmDialog>,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('is an open, modal alert dialog named by its title and described by its body', () => {
    setup();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAccessibleName('Delete this file?');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
  });

  it('puts initial focus on Cancel so an accidental Enter never confirms a destructive action', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('calls onConfirm from the confirm button, and onCancel from Cancel', async () => {
    const { onConfirm, onCancel } = setup();

    await userEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("treats Escape (the dialog's cancel event) as Cancel, and stops the browser closing it itself", () => {
    const { onCancel, onConfirm } = setup();
    const dialog = screen.getByRole('alertdialog');
    const event = new Event('cancel', { cancelable: true });

    fireEvent(dialog, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('treats a click on the backdrop as Cancel, but not a click inside the dialog', async () => {
    const { onCancel } = setup();
    const dialog = screen.getByRole('alertdialog');

    await userEvent.click(screen.getByText('This cannot be undone.'));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a failure inside the dialog as an alert', () => {
    setup({ error: 'Could not delete this file. Please try again.' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not delete this file. Please try again.',
    );
  });

  it('shows no alert when there is no error', () => {
    setup({ error: null });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('while busy', () => {
    it('relabels and disables both buttons', () => {
      setup({ busy: true, busyLabel: 'Deleting…' });

      expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    it('cannot be dismissed by Escape or a backdrop click', () => {
      const { onCancel } = setup({ busy: true });
      const dialog = screen.getByRole('alertdialog');

      fireEvent(dialog, new Event('cancel', { cancelable: true }));
      fireEvent.click(dialog);

      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  it('closes the native dialog when it unmounts, so the browser can restore focus to the opener', () => {
    const { unmount } = render(
      <ConfirmDialog title="t" confirmLabel="c" onConfirm={() => {}} onCancel={() => {}}>
        <p>body</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getAllByRole('alertdialog').at(-1) as HTMLDialogElement;
    const close = vi.spyOn(dialog, 'close');

    unmount();

    expect(close).toHaveBeenCalled();
  });
});
