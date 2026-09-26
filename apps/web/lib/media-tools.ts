import type { ProcessingOperation } from '@media/validation';

/**
 * Which options-collection form (if any) `FileRow` should render before firing
 * a tool's processing request. `'none'` fires immediately with no options, the
 * same as every Phase 7A tool did. This is a closed, small set purely for
 * *frontend form* dispatch — it has nothing to do with, and must never grow
 * into, the backend's `OPERATION_HANDLERS` registry lookup.
 */
export type MediaToolOptionsKind =
  'none' | 'compress-video' | 'resize-video' | 'extract-mp3' | 'trim-video';

/**
 * Which section of the "Process" menu a tool is listed under — by what it
 * *produces*, which is what a user is choosing between: a video tool gives back a
 * video, an audio tool gives back audio. Purely presentational; independent of
 * `category` below (which is about what the tool accepts as input).
 */
export type MediaToolGroup = 'video' | 'audio';

/**
 * One entry in the media-tools registry — the frontend counterpart to the API's
 * operation handler registry (`apps/api/src/workers/operations/registry.ts`).
 * Adding a real tool is additive here (and in the matching backend registry) —
 * nothing about how `FileRow` consumes this array needs to change.
 */
export interface MediaToolDefinition {
  operation: ProcessingOperation;
  label: string;
  /** One short line shown under the label in the Process menu. */
  description: string;
  category: 'video' | 'document';
  /** The Process-menu section this tool is listed under. */
  group: MediaToolGroup;
  /** MIME types this tool applies to — an uploaded file only offers a tool whose
   * `acceptedMimeTypes` includes its own `mimeType` (see `getAvailableTools`).
   * All five current tools are video-only: each handler's worker-side
   * `MediaService.probe` call requires a real video stream, so offering any of
   * them for an audio/image upload would only ever predictably fail. */
  acceptedMimeTypes: readonly string[];
  optionsKind: MediaToolOptionsKind;
}

/**
 * The five executable tools after Phase 7D. Adding a real future tool is
 * additive here (and in the matching backend registry) — nothing about how
 * `FileRow` consumes this array needs to change. Array order is the order tools
 * appear within their menu group.
 */
export const MEDIA_TOOLS: readonly MediaToolDefinition[] = [
  {
    operation: 'convert-to-mp4',
    label: 'Convert to MP4',
    description: 'Re-encode to a standard H.264 MP4.',
    category: 'video',
    group: 'video',
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    optionsKind: 'none',
  },
  {
    operation: 'compress-video',
    label: 'Compress Video',
    description: 'Make the file smaller with a quality preset.',
    category: 'video',
    group: 'video',
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    optionsKind: 'compress-video',
  },
  {
    operation: 'resize-video',
    label: 'Resize Video',
    description: 'Change the width or height.',
    category: 'video',
    group: 'video',
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    optionsKind: 'resize-video',
  },
  {
    operation: 'extract-mp3',
    label: 'Extract MP3',
    description: 'Save the audio track as an MP3.',
    category: 'video',
    group: 'audio',
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    optionsKind: 'extract-mp3',
  },
  {
    operation: 'trim-video',
    label: 'Trim Video',
    description: 'Keep just one section of the video.',
    category: 'video',
    group: 'video',
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    optionsKind: 'trim-video',
  },
];

/** The tools that apply to a given uploaded file's declared MIME type, in
 * registry order. */
export function getAvailableTools(mimeType: string): readonly MediaToolDefinition[] {
  return MEDIA_TOOLS.filter((tool) => tool.acceptedMimeTypes.includes(mimeType));
}

/** Menu section headings, in display order. */
export const MEDIA_TOOL_GROUPS: readonly { group: MediaToolGroup; label: string }[] = [
  { group: 'video', label: 'Video tools' },
  { group: 'audio', label: 'Audio' },
];

export interface MediaToolSection {
  group: MediaToolGroup;
  label: string;
  tools: readonly MediaToolDefinition[];
}

/**
 * Splits already-filtered tools into the Process menu's labelled sections, in
 * `MEDIA_TOOL_GROUPS` order, each keeping registry order. A group with no
 * applicable tools is omitted, so the menu never shows an empty heading.
 */
export function groupTools(tools: readonly MediaToolDefinition[]): readonly MediaToolSection[] {
  return MEDIA_TOOL_GROUPS.map(({ group, label }) => ({
    group,
    label,
    tools: tools.filter((tool) => tool.group === group),
  })).filter((section) => section.tools.length > 0);
}
