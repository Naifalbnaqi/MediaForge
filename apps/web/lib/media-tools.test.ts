import { describe, expect, it } from 'vitest';
import { getAvailableTools, groupTools, MEDIA_TOOL_GROUPS, MEDIA_TOOLS } from './media-tools';

describe('MEDIA_TOOLS registry', () => {
  it('exposes exactly the five tools after Phase 7D', () => {
    expect(MEDIA_TOOLS).toHaveLength(5);
    expect(MEDIA_TOOLS.map((tool) => tool.operation)).toEqual([
      'convert-to-mp4',
      'compress-video',
      'resize-video',
      'extract-mp3',
      'trim-video',
    ]);
  });

  it('Convert to MP4 takes no options form', () => {
    expect(MEDIA_TOOLS.find((tool) => tool.operation === 'convert-to-mp4')).toMatchObject({
      label: 'Convert to MP4',
      optionsKind: 'none',
    });
  });

  it('Compress Video is wired to the compress-video options form', () => {
    expect(MEDIA_TOOLS.find((tool) => tool.operation === 'compress-video')).toMatchObject({
      label: 'Compress Video',
      optionsKind: 'compress-video',
    });
  });

  it('Resize Video is wired to the resize-video options form', () => {
    expect(MEDIA_TOOLS.find((tool) => tool.operation === 'resize-video')).toMatchObject({
      label: 'Resize Video',
      optionsKind: 'resize-video',
    });
  });

  it('Extract MP3 is wired to the extract-mp3 options form', () => {
    expect(MEDIA_TOOLS.find((tool) => tool.operation === 'extract-mp3')).toMatchObject({
      label: 'Extract MP3',
      optionsKind: 'extract-mp3',
    });
  });

  it('Trim Video is wired to the trim-video options form and is video-only', () => {
    expect(MEDIA_TOOLS.find((tool) => tool.operation === 'trim-video')).toMatchObject({
      label: 'Trim Video',
      category: 'video',
      acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
      optionsKind: 'trim-video',
    });
  });

  it('does not expose Mute Video, Image to PDF, or any other later-phase tool, in this registry', () => {
    const operations = MEDIA_TOOLS.map((tool) => tool.operation);
    expect(operations).not.toContain('image-to-pdf');
    for (const future of ['generate-thumbnail', 'mute-video', 'convert-format']) {
      expect(operations).not.toContain(future);
    }
  });
});

describe('getAvailableTools', () => {
  it.each(['video/mp4', 'video/quicktime'])('returns all five tools for %s uploads', (mimeType) => {
    const tools = getAvailableTools(mimeType);
    expect(tools.map((tool) => tool.operation)).toEqual([
      'convert-to-mp4',
      'compress-video',
      'resize-video',
      'extract-mp3',
      'trim-video',
    ]);
  });

  it.each(['audio/mpeg', 'audio/wav', 'image/jpeg', 'image/png'])(
    'returns no tools for %s uploads (all five tools are video-only)',
    (mimeType) => {
      expect(getAvailableTools(mimeType)).toEqual([]);
    },
  );

  it('returns no tools for an unrecognised MIME type', () => {
    expect(getAvailableTools('application/octet-stream')).toEqual([]);
  });
});

describe('menu grouping metadata', () => {
  it('gives every tool a one-line description and a menu group', () => {
    for (const tool of MEDIA_TOOLS) {
      expect(tool.description.length, tool.operation).toBeGreaterThan(0);
      expect(MEDIA_TOOL_GROUPS.map((entry) => entry.group)).toContain(tool.group);
    }
  });

  it('groups Extract MP3 under Audio (it produces audio) and the rest under Video tools', () => {
    const byOperation = Object.fromEntries(MEDIA_TOOLS.map((tool) => [tool.operation, tool.group]));
    expect(byOperation).toEqual({
      'convert-to-mp4': 'video',
      'compress-video': 'video',
      'resize-video': 'video',
      'extract-mp3': 'audio',
      'trim-video': 'video',
    });
  });
});

describe('groupTools', () => {
  it('splits the tools for a video file into Video tools then Audio, keeping registry order inside each', () => {
    const sections = groupTools(getAvailableTools('video/mp4'));

    expect(
      sections.map((section) => [section.label, section.tools.map((tool) => tool.operation)]),
    ).toEqual([
      ['Video tools', ['convert-to-mp4', 'compress-video', 'resize-video', 'trim-video']],
      ['Audio', ['extract-mp3']],
    ]);
  });

  it('omits a group that has no applicable tools, rather than showing an empty heading', () => {
    const onlyAudio = MEDIA_TOOLS.filter((tool) => tool.group === 'audio');

    expect(groupTools(onlyAudio).map((section) => section.group)).toEqual(['audio']);
    expect(groupTools([])).toEqual([]);
  });

  it('lists every tool it is given exactly once', () => {
    const tools = getAvailableTools('video/quicktime');
    const listed = groupTools(tools).flatMap((section) => section.tools);

    expect(listed).toHaveLength(tools.length);
    expect(new Set(listed).size).toBe(tools.length);
  });
});
