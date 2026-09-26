import { describe, expect, it } from 'vitest';
import {
  buildContentDisposition,
  sanitizeDownloadFileName,
} from '../src/utils/content-disposition.js';

describe('sanitizeDownloadFileName', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitizeDownloadFileName('holiday.mp4')).toBe('holiday.mp4');
  });

  it('strips CR/LF so a name cannot inject additional header content', () => {
    const injected = 'clip.mp4\r\nX-Injected: yes';
    const sanitized = sanitizeDownloadFileName(injected);
    expect(sanitized).not.toContain('\r');
    expect(sanitized).not.toContain('\n');
  });

  it('strips quotes and backslashes that would break out of the quoted string', () => {
    const sanitized = sanitizeDownloadFileName('we"ird\\name.mp4');
    expect(sanitized).not.toContain('"');
    expect(sanitized).not.toContain('\\');
  });

  it('reduces a path to its basename', () => {
    expect(sanitizeDownloadFileName('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(sanitizeDownloadFileName('C:\\Windows\\system32\\evil.mp4')).toBe('evil.mp4');
  });

  it('falls back to a default when nothing usable survives', () => {
    expect(sanitizeDownloadFileName('')).toBe('download');
    expect(sanitizeDownloadFileName('"""')).toBe('download');
  });

  it('truncates an overlong name while preserving its extension', () => {
    const sanitized = sanitizeDownloadFileName(`${'a'.repeat(400)}.mp4`);
    expect(sanitized.length).toBeLessThanOrEqual(120);
    expect(sanitized.endsWith('.mp4')).toBe(true);
  });

  it('truncates astral characters without splitting a surrogate pair', () => {
    // Slicing by UTF-16 code units here would leave a lone surrogate, which makes
    // encodeURIComponent throw downstream — a 500 reachable from an ordinary upload
    // name, since this is well inside the 255-character limit uploads allow.
    const sanitized = sanitizeDownloadFileName(`a${'😀'.repeat(120)}.mp4`);
    for (const character of sanitized) {
      const code = character.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
    expect(() => buildContentDisposition('attachment', `a${'😀'.repeat(120)}.mp4`)).not.toThrow();
  });

  it('strips bidirectional overrides that could visually reverse the extension', () => {
    const sanitized = sanitizeDownloadFileName('clip‮gnp.exe.mp4');
    expect(sanitized).not.toContain('‮');
    expect(buildContentDisposition('attachment', 'clip‮gnp.exe.mp4')).not.toContain('%E2%80%AE');
  });
});

describe('buildContentDisposition', () => {
  it('emits both a plain filename and a UTF-8 filename*', () => {
    const value = buildContentDisposition('attachment', 'holiday.mp4');
    expect(value).toBe(`attachment; filename="holiday.mp4"; filename*=UTF-8''holiday.mp4`);
  });

  it('uses the requested disposition', () => {
    expect(buildContentDisposition('inline', 'clip.mp4')).toContain('inline;');
    expect(buildContentDisposition('attachment', 'clip.mp4')).toContain('attachment;');
  });

  it('never emits raw non-ASCII in the legacy filename, but preserves it in filename*', () => {
    const value = buildContentDisposition('attachment', 'vidéo-日本.mp4');
    const legacy = /filename="([^"]*)"/.exec(value)?.[1] ?? '';
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(legacy)).toBe(true);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain('%C3%A9');
  });

  it('produces a header value with no CR/LF even from a hostile name', () => {
    const value = buildContentDisposition('attachment', 'a.mp4\r\nContent-Length: 0');
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
  });

  it('percent-encodes characters that are not RFC 5987 attr-chars', () => {
    const value = buildContentDisposition('attachment', "it's (a) file*.mp4");
    const extValue = value.split("filename*=UTF-8''")[1] ?? '';
    for (const forbidden of ["'", '(', ')', '*']) {
      expect(extValue).not.toContain(forbidden);
    }
  });
});
