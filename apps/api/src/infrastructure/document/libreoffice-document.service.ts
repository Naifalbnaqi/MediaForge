import { execFile } from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  InvalidDocumentError,
  type DocumentConversionService,
} from '../../services/document-conversion.service.js';

const execFileAsync = promisify(execFile);

/**
 * LibreOffice conversion timeout. Measured on the real Alpine package (headless
 * `soffice`, `libreoffice-writer`/`-calc`/`-impress`): a simple document converts
 * in well under 2 seconds. 2 minutes is a conservative ceiling for a far more
 * complex real-world document, matching the spirit of `CONVERT_TIMEOUT_MS` in
 * the FFmpeg adapter (a real, current limitation, not a dynamically-sized
 * budget) — a legitimately huge/complex document could still exceed this and be
 * killed, which is accepted for this phase.
 */
const CONVERT_TIMEOUT_MS = 2 * 60_000;

/** Generous relative to any expected stdout/stderr from a single headless
 * conversion (a handful of log lines) — sized the same way the FFmpeg
 * adapter's buffers are, not tuned specifically for this. */
const CONVERT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const PDF_MAGIC = '%PDF-';

/**
 * `DocumentConversionService` implemented against the real `soffice` (headless
 * LibreOffice) binary via `child_process.execFile` — never `shell: true`, never
 * a string-built command. `inputPath`/`outputDir` are the only caller-supplied
 * arguments, and both are always server-generated temp paths (see the worker),
 * never derived from client input.
 */
export class LibreOfficeDocumentService implements DocumentConversionService {
  public constructor(private readonly sofficePath: string) {}

  public async convertToPdf(inputPath: string, outputDir: string): Promise<string> {
    // A dedicated, per-conversion profile directory. LibreOffice's headless mode
    // locks its user profile for the duration of a run; without an explicit,
    // distinct `-env:UserInstallation` per invocation, two conversions running at
    // once (this worker's own concurrency is 2 — see DEFAULT_WORKER_CONCURRENCY)
    // would contend for the same default profile. Verified directly: two
    // concurrent `soffice` invocations against distinct UserInstallation
    // directories both complete correctly; sharing one does not reliably.
    // `outputDir` is already a fresh, per-job temp directory, so nesting the
    // profile under it costs nothing extra to clean up.
    const profileDir = path.join(outputDir, 'lo-profile');
    await mkdir(profileDir, { recursive: true });

    // Fixed argument array — inputPath/outputDir (server-generated temp paths,
    // see the worker) are the only variable elements; everything else is a
    // hardcoded literal. No client-supplied LibreOffice flag is ever accepted.
    const args = [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath,
    ];

    // Verified directly against the installed binary: `soffice --convert-to`
    // exits 0 even when conversion genuinely fails (see InvalidDocumentError's
    // own doc comment) — so a non-zero exit/timeout here is still worth
    // catching (it can happen, e.g. if the binary itself is missing or killed),
    // but is not the primary signal. Either way, execution falls through to the
    // output-file check below, which is what actually decides success.
    try {
      await execFileAsync(this.sofficePath, args, {
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: CONVERT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
    } catch {
      // Fall through to the output check — a thrown execFile error and a clean
      // exit that simply produced nothing are treated identically below.
    }

    // LibreOffice writes `<outDir>/<inputBasenameWithoutExtension>.pdf` —
    // deterministic since the caller controls inputPath's basename.
    const outputPath = path.join(outputDir, `${path.parse(inputPath).name}.pdf`);

    let outputStat;
    try {
      outputStat = await stat(outputPath);
    } catch (error) {
      throw new InvalidDocumentError('LibreOffice produced no output file', error);
    }
    if (outputStat.size === 0) {
      throw new InvalidDocumentError('LibreOffice produced an empty output file');
    }

    const handle = await open(outputPath, 'r');
    let header: string;
    try {
      const buffer = Buffer.alloc(PDF_MAGIC.length);
      await handle.read(buffer, 0, buffer.length, 0);
      header = buffer.toString('latin1');
    } finally {
      await handle.close();
    }
    if (header !== PDF_MAGIC) {
      throw new InvalidDocumentError('LibreOffice output is not a valid PDF');
    }

    return outputPath;
  }
}
