import type { OutputDisposition } from '@media/validation';

const MAX_FILE_NAME_LENGTH = 120;
const FALLBACK_FILE_NAME = 'download';

/**
 * Characters that must never reach a `Content-Disposition` value:
 * - C0/C1 control characters, which include CR and LF — the header-injection vector.
 * - `"` and `\`, which would break out of (or escape within) the quoted-string form.
 * - Bidirectional overrides/isolates, which survive percent-encoding into `filename*`
 *   and can visually reverse an extension in the browser's download shelf
 *   (`file‮gnp.exe` rendering as `fileexe.png`). Pure display spoofing rather
 *   than code execution, but free to remove.
 *
 * Implemented as a code-point filter rather than a regex so each excluded range is
 * explicit and readable rather than an escaped literal range.
 */
function stripUnsafeCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      const isBidiControl =
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return !isControl && !isBidiControl && character !== '"' && character !== '\\';
    })
    .join('');
}

/**
 * Truncates to a sane length while preserving a trailing extension where possible.
 *
 * Slices over code points (`[...value]`) rather than UTF-16 code units: cutting a
 * string mid-surrogate leaves a lone surrogate, which makes `encodeURIComponent`
 * throw `URIError: URI malformed` further down. That is reachable from an ordinary
 * upload name — ~120 emoji and a `.mp4` extension is well inside the 255-character
 * limit the upload schema allows — and would otherwise 500 that job's output link
 * permanently, with no way for the owner to rename the file.
 */
function truncatePreservingExtension(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_FILE_NAME_LENGTH) return value;
  const lastDot = value.lastIndexOf('.');
  // Only treat it as an extension if it's a short, real suffix — not a dot buried
  // near the start of a very long name.
  if (lastDot > 0 && value.length - lastDot <= 10) {
    const extension = value.slice(lastDot);
    const budget = MAX_FILE_NAME_LENGTH - [...extension].length;
    return characters.slice(0, Math.max(budget, 0)).join('') + extension;
  }
  return characters.slice(0, MAX_FILE_NAME_LENGTH).join('');
}

/**
 * Reduces a display file name to something safe to place in a `Content-Disposition`
 * header. The stored name is already derived server-side by the worker, but it
 * ultimately originates from a user-supplied upload name, so it is treated as
 * untrusted here regardless.
 */
export function sanitizeDownloadFileName(fileName: string): string {
  // Basename only — defence in depth, so no path component can ever reach the header.
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = truncatePreservingExtension(stripUnsafeCharacters(base).trim());
  return cleaned.length > 0 ? cleaned : FALLBACK_FILE_NAME;
}

/**
 * Percent-encodes for RFC 5987's `ext-value`. `encodeURIComponent` leaves `!'()*`
 * unescaped, but those are not `attr-char`, so they are encoded explicitly here.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds an RFC 6266 `Content-Disposition` value carrying both a plain ASCII
 * `filename` (for older clients) and a UTF-8 `filename*` (for everything else), so a
 * non-ASCII name survives without ever emitting raw non-ASCII bytes in the header.
 *
 * This value is handed to S3 as `ResponseContentDisposition`, which means it is
 * signed into the presigned URL — a client cannot change how the object is served
 * without invalidating the signature.
 */
export function buildContentDisposition(disposition: OutputDisposition, fileName: string): string {
  const safe = sanitizeDownloadFileName(fileName);
  // Non-ASCII collapses to '_' in the legacy parameter; filename* carries the real name.
  const asciiFallback =
    [...safe].map((character) => (character.charCodeAt(0) < 128 ? character : '_')).join('') ||
    FALLBACK_FILE_NAME;
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}
