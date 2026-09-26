import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// jsdom does not implement the modal methods of <dialog>. This stand-in models just
// what the components rely on — `showModal()` opens it, `close()` closes it and fires
// `close` — so tests exercise our own logic; real modal behaviour (focus trap, inert
// page, Escape, focus restoration) is the browser's and is checked in the Docker/UI
// acceptance run instead.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom/Vitest's own `URL.createObjectURL` compat shim expects internal Blob
// fields that a plain `new File([...], name, { type })` (exactly what
// `<input type="file">`/`userEvent.upload` produce in tests) doesn't carry,
// throwing "Cannot read properties of undefined (reading '_buffer')". Real
// object-URL creation/revocation has no meaningful behavior to test here
// anyway (it's the browser's own memory management) — components only need a
// stable, distinct string per call for their preview `src`/`href`.
let objectUrlCounter = 0;
URL.createObjectURL = (): string => `blob:mock-url-${(objectUrlCounter += 1)}`;
URL.revokeObjectURL = () => {};

// Testing Library's own auto-cleanup only registers itself against a *global*
// afterEach, which this project doesn't have (`test.globals` is deliberately left
// off — explicit `describe`/`it`/`expect` imports match the rest of the repo's test
// style). Without this, a component rendered in one test stays mounted into the
// next, since nothing ever unmounts it.
afterEach(() => {
  cleanup();
});
