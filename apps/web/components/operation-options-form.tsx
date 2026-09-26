'use client';

import { Button } from '@media/ui';
import {
  MAX_RESIZE_DIMENSION,
  MAX_TRIM_SECONDS,
  MIN_TRIM_DURATION_SECONDS,
  type CompressVideoQuality,
  type ExtractMp3Quality,
  type ResizeVideoOptions,
  type TrimVideoOptions,
} from '@media/validation';
import { useState } from 'react';
import type { MediaToolOptionsKind } from '@/lib/media-tools';

const FIELD_LABEL_CLASS = 'text-xs font-medium text-slate-700 dark:text-slate-300';
const NUMBER_INPUT_CLASS =
  'mt-1 w-28 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900';
const FORM_CONTAINER_CLASS =
  'rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60';

type QualityLevel = CompressVideoQuality | ExtractMp3Quality;

interface QualityChoice {
  value: QualityLevel;
  label: string;
  description: string;
}

const COMPRESS_QUALITY_CHOICES: readonly QualityChoice[] = [
  { value: 'high', label: 'High Quality', description: 'Best visual quality, larger file.' },
  { value: 'balanced', label: 'Balanced', description: 'Good quality with a much smaller file. Recommended.' },
  { value: 'small', label: 'Small File', description: 'Strongest compression, smallest file.' },
];

const EXTRACT_MP3_QUALITY_CHOICES: readonly QualityChoice[] = [
  { value: 'high', label: 'High Quality', description: 'Best audio quality (320kbps), larger file.' },
  { value: 'balanced', label: 'Balanced', description: 'Good audio quality (192kbps), smaller file. Recommended.' },
  { value: 'small', label: 'Small File', description: 'Smallest file (96kbps), noticeably compressed audio.' },
];

/**
 * Shared radio-group quality selector — `compress-video` and `extract-mp3`
 * both take the exact same `high | balanced | small` shape, so this is the
 * one place that renders it rather than duplicating the form per tool.
 */
function QualitySelectorForm({
  heading,
  choices,
  radioGroupName,
  submitLabel,
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  heading: string;
  choices: readonly QualityChoice[];
  radioGroupName: string;
  submitLabel: string;
  isSubmitting: boolean;
  onSubmit: (quality: QualityLevel) => void;
  onCancel: () => void;
}) {
  const [quality, setQuality] = useState<QualityLevel>('balanced');

  return (
    <div className={FORM_CONTAINER_CLASS}>
      <p className={FIELD_LABEL_CLASS}>{heading}</p>
      <div className="mt-2 flex flex-col gap-2">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-transparent p-1.5 has-[:checked]:border-indigo-300 has-[:checked]:bg-indigo-50 dark:has-[:checked]:border-indigo-800 dark:has-[:checked]:bg-indigo-950/40"
          >
            <input
              type="radio"
              name={radioGroupName}
              value={choice.value}
              checked={quality === choice.value}
              onChange={() => setQuality(choice.value)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium">{choice.label}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">{choice.description}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          onClick={() => onSubmit(quality)}
          disabled={isSubmitting}
          size="sm"
        >
          {isSubmitting ? 'Starting…' : submitLabel}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CompressVideoOptionsForm({
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  isSubmitting: boolean;
  onSubmit: (options: { quality: CompressVideoQuality }) => void;
  onCancel: () => void;
}) {
  return (
    <QualitySelectorForm
      heading="Compression level"
      choices={COMPRESS_QUALITY_CHOICES}
      radioGroupName="compress-quality"
      submitLabel="Compress Video"
      isSubmitting={isSubmitting}
      onSubmit={(quality) => onSubmit({ quality: quality as CompressVideoQuality })}
      onCancel={onCancel}
    />
  );
}

function ExtractMp3OptionsForm({
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  isSubmitting: boolean;
  onSubmit: (options: { quality: ExtractMp3Quality }) => void;
  onCancel: () => void;
}) {
  return (
    <QualitySelectorForm
      heading="Audio quality"
      choices={EXTRACT_MP3_QUALITY_CHOICES}
      radioGroupName="extract-mp3-quality"
      submitLabel="Extract MP3"
      isSubmitting={isSubmitting}
      onSubmit={(quality) => onSubmit({ quality: quality as ExtractMp3Quality })}
      onCancel={onCancel}
    />
  );
}

function parseDimensionField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function validateDimensions(width: number | undefined, height: number | undefined): string | null {
  if (width === undefined && height === undefined) {
    return 'Enter a width, a height, or both.';
  }
  for (const [label, value] of [
    ['Width', width],
    ['Height', height],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      return `${label} must be a positive whole number.`;
    }
    if (value > MAX_RESIZE_DIMENSION) {
      return `${label} must be at most ${MAX_RESIZE_DIMENSION} pixels.`;
    }
  }
  return null;
}

function ResizeVideoOptionsForm({
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  isSubmitting: boolean;
  onSubmit: (options: ResizeVideoOptions) => void;
  onCancel: () => void;
}) {
  const [widthInput, setWidthInput] = useState('');
  const [heightInput, setHeightInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(): void {
    const width = parseDimensionField(widthInput);
    const height = parseDimensionField(heightInput);
    const validationError = validateDimensions(width, height);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onSubmit({
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }

  return (
    <div className={FORM_CONTAINER_CLASS}>
      <p className={FIELD_LABEL_CLASS}>Resize dimensions (pixels)</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Provide a width, a height, or both. The aspect ratio is always preserved — the video is never
        stretched or distorted.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label>
          <span className={`block ${FIELD_LABEL_CLASS}`}>Width</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RESIZE_DIMENSION}
            placeholder="e.g. 1280"
            value={widthInput}
            onChange={(event) => setWidthInput(event.target.value)}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <label>
          <span className={`block ${FIELD_LABEL_CLASS}`}>Height</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RESIZE_DIMENSION}
            placeholder="e.g. 720"
            value={heightInput}
            onChange={(event) => setHeightInput(event.target.value)}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
      </div>
      {error && (
        <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" onClick={handleSubmit} disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Starting…' : 'Resize Video'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type TrimEndMode = 'end' | 'duration';

/** Empty input is "not provided" (undefined); anything that isn't a finite
 * number is NaN so validation can reject it rather than silently coerce it. */
function parseSecondsField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Mirrors `trimVideoOptionsSchema` (the server re-validates everything; this
 * only saves a round trip and words the problem for the user). Returns the
 * request options, or the first error message.
 */
function buildTrimOptions(
  startRaw: string,
  endMode: TrimEndMode,
  endRaw: string,
): { options: TrimVideoOptions } | { error: string } {
  const start = parseSecondsField(startRaw);
  if (start === undefined || Number.isNaN(start) || start < 0) {
    return { error: 'Start must be a number of seconds, 0 or more.' };
  }
  if (start > MAX_TRIM_SECONDS) {
    return { error: `Start must be at most ${MAX_TRIM_SECONDS} seconds.` };
  }

  const value = parseSecondsField(endRaw);
  if (endMode === 'end') {
    if (value === undefined || Number.isNaN(value)) {
      return { error: 'Enter an end time in seconds.' };
    }
    if (value > MAX_TRIM_SECONDS) {
      return { error: `End time must be at most ${MAX_TRIM_SECONDS} seconds.` };
    }
    // Same float slack as the schema (0.3 - 0.2 must still count as 0.1).
    if (value - start < MIN_TRIM_DURATION_SECONDS - 1e-9) {
      return { error: `End time must be at least ${MIN_TRIM_DURATION_SECONDS} seconds after the start.` };
    }
    return { options: { start, end: value } };
  }

  if (value === undefined || Number.isNaN(value)) {
    return { error: 'Enter a duration in seconds.' };
  }
  if (value < MIN_TRIM_DURATION_SECONDS) {
    return { error: `Duration must be at least ${MIN_TRIM_DURATION_SECONDS} seconds.` };
  }
  if (value > MAX_TRIM_SECONDS) {
    return { error: `Duration must be at most ${MAX_TRIM_SECONDS} seconds.` };
  }
  return { options: { start, duration: value } };
}

function TrimVideoOptionsForm({
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  isSubmitting: boolean;
  onSubmit: (options: TrimVideoOptions) => void;
  onCancel: () => void;
}) {
  const [startInput, setStartInput] = useState('0');
  const [endMode, setEndMode] = useState<TrimEndMode>('end');
  const [endInput, setEndInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(): void {
    const result = buildTrimOptions(startInput, endMode, endInput);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onSubmit(result.options);
  }

  const endLabel = endMode === 'end' ? 'End time (seconds)' : 'Duration (seconds)';

  return (
    <div className={FORM_CONTAINER_CLASS}>
      <p className={FIELD_LABEL_CLASS}>Trim range (seconds)</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Keep one section of the video. Times are in seconds and may include decimals (for example 12.5). If
        the end is past the end of the video, the section runs to the end of the video.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label>
          <span className={`block ${FIELD_LABEL_CLASS}`}>Start (seconds)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_TRIM_SECONDS}
            step="any"
            value={startInput}
            onChange={(event) => setStartInput(event.target.value)}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <label>
          <span className={`block ${FIELD_LABEL_CLASS}`}>{endLabel}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_TRIM_SECONDS}
            step="any"
            placeholder={endMode === 'end' ? 'e.g. 30' : 'e.g. 10'}
            value={endInput}
            onChange={(event) => setEndInput(event.target.value)}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className={FIELD_LABEL_CLASS}>Set the end by</span>
        {(
          [
            ['end', 'End time'],
            ['duration', 'Duration'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="trim-end-mode"
              value={value}
              checked={endMode === value}
              onChange={() => {
                // "End 30" and "duration 30" mean different things, so the value
                // typed under one mode is never silently reinterpreted under the
                // other.
                setEndMode(value);
                setEndInput('');
                setError(null);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {error && (
        <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" onClick={handleSubmit} disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Starting…' : 'Trim Video'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Dispatches to the right options-collection form by `optionsKind` — the only
 * place `FileRow` needs to know these forms exist. `'none'` never reaches this
 * component at all (see `FileRow`'s own dispatch), so there is no branch for it
 * here.
 */
export function OperationOptionsForm({
  optionsKind,
  isSubmitting,
  onSubmit,
  onCancel,
}: {
  optionsKind: Exclude<MediaToolOptionsKind, 'none'>;
  isSubmitting: boolean;
  onSubmit: (options: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  if (optionsKind === 'compress-video') {
    return <CompressVideoOptionsForm isSubmitting={isSubmitting} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  if (optionsKind === 'extract-mp3') {
    return <ExtractMp3OptionsForm isSubmitting={isSubmitting} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  if (optionsKind === 'trim-video') {
    return <TrimVideoOptionsForm isSubmitting={isSubmitting} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  return <ResizeVideoOptionsForm isSubmitting={isSubmitting} onSubmit={onSubmit} onCancel={onCancel} />;
}
