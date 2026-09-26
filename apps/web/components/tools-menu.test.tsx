import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolsMenu } from './tools-menu';
import { MEDIA_TOOLS, getAvailableTools, type MediaToolDefinition } from '@/lib/media-tools';

const TOOLS = getAvailableTools('video/mp4');
const ITEM_ORDER = [
  'Convert to MP4',
  'Compress Video',
  'Resize Video',
  'Trim Video',
  'Extract MP3',
];

function setup(overrides: Partial<Parameters<typeof ToolsMenu>[0]> = {}) {
  const onSelect = vi.fn<(tool: MediaToolDefinition) => void>();
  const view = render(
    <div>
      <button type="button">before</button>
      <ToolsMenu tools={TOOLS} onSelect={onSelect} {...overrides} />
      <button type="button">after</button>
    </div>,
  );
  return { onSelect, ...view };
}

const processButton = () => screen.getByRole('button', { name: /^process$/i });
const items = () => screen.getAllByRole('menuitem');
/** An item's visible label (its accessible name), read via the id it is labelled by. */
const labelOf = (item: HTMLElement) =>
  document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent;

describe('ToolsMenu', () => {
  it('renders only the trigger until opened', () => {
    setup();

    expect(processButton()).toHaveAttribute('aria-expanded', 'false');
    expect(processButton()).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('lists the tools it was given, grouped, in registry order within each group', async () => {
    setup();
    await userEvent.click(processButton());

    expect(items().map(labelOf)).toEqual(ITEM_ORDER);
    const menu = screen.getByRole('menu');
    const video = within(menu).getByRole('group', { name: 'Video tools' });
    const audio = within(menu).getByRole('group', { name: 'Audio' });
    expect(within(video).getAllByRole('menuitem').map(labelOf)).toEqual([
      'Convert to MP4',
      'Compress Video',
      'Resize Video',
      'Trim Video',
    ]);
    expect(within(audio).getAllByRole('menuitem').map(labelOf)).toEqual(['Extract MP3']);
  });

  it('is built from the tools passed in, not from a list of its own', async () => {
    const onlyTrim = MEDIA_TOOLS.filter((tool) => tool.operation === 'trim-video');
    setup({ tools: onlyTrim });
    await userEvent.click(processButton());

    expect(items()).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Trim Video' })).toBeInTheDocument();
    // A group with no tools is not rendered at all — no empty heading.
    expect(screen.queryByRole('group', { name: 'Audio' })).not.toBeInTheDocument();
  });

  it('connects the trigger to the open menu with aria-controls', async () => {
    setup();
    await userEvent.click(processButton());

    const menu = screen.getByRole('menu');
    expect(processButton()).toHaveAttribute('aria-controls', menu.id);
    expect(processButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('focuses the first item when opened with the mouse', async () => {
    setup();
    await userEvent.click(processButton());

    expect(items()[0]).toHaveFocus();
  });

  it('calls onSelect with the chosen registry entry and closes', async () => {
    const { onSelect } = setup();
    await userEvent.click(processButton());

    await userEvent.click(screen.getByRole('menuitem', { name: 'Resize Video' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      MEDIA_TOOLS.find((tool) => tool.operation === 'resize-video'),
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  describe('keyboard', () => {
    it('opens with Enter and lands on the first item', async () => {
      setup();
      processButton().focus();

      await userEvent.keyboard('{Enter}');

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(items()[0]).toHaveFocus();
    });

    it('opens with Space', async () => {
      setup();
      processButton().focus();

      await userEvent.keyboard(' ');

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(items()[0]).toHaveFocus();
    });

    it('opens with ArrowDown on the first item and ArrowUp on the last', async () => {
      setup();
      processButton().focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(items()[0]).toHaveFocus();

      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();

      await userEvent.keyboard('{ArrowUp}');
      expect(items()[items().length - 1]).toHaveFocus();
    });

    it('moves between items with the arrow keys, wrapping at both ends', async () => {
      setup();
      processButton().focus();
      await userEvent.keyboard('{ArrowDown}');

      await userEvent.keyboard('{ArrowDown}');
      expect(items()[1]).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}{ArrowUp}');
      expect(items()[items().length - 1]).toHaveFocus(); // wrapped from the first to the last
      await userEvent.keyboard('{ArrowDown}');
      expect(items()[0]).toHaveFocus(); // wrapped from the last to the first
    });

    it('Home and End jump to the first and last item', async () => {
      setup();
      processButton().focus();
      await userEvent.keyboard('{ArrowDown}');

      await userEvent.keyboard('{End}');
      expect(items()[items().length - 1]).toHaveFocus();
      await userEvent.keyboard('{Home}');
      expect(items()[0]).toHaveFocus();
    });

    it('activates the focused item with Enter', async () => {
      const { onSelect } = setup();
      processButton().focus();
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

      expect(onSelect).toHaveBeenCalledWith(
        MEDIA_TOOLS.find((tool) => tool.operation === 'compress-video'),
      );
    });

    it('Escape closes the menu and returns focus to the button', async () => {
      setup();
      await userEvent.click(processButton());

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(processButton()).toHaveFocus();
    });

    it('Tab closes the menu and moves on to the next control rather than trapping focus', async () => {
      setup();
      await userEvent.click(processButton());

      await userEvent.tab();

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    });

    it('Shift+Tab closes the menu and moves back to the previous control', async () => {
      setup();
      await userEvent.click(processButton());

      await userEvent.tab({ shift: true });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'before' })).toHaveFocus();
    });
  });

  it('closes when the user presses anywhere outside it', async () => {
    setup();
    await userEvent.click(processButton());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'after' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays open when the press is inside the menu but not on an item (a group heading)', async () => {
    setup();
    await userEvent.click(processButton());

    await userEvent.click(screen.getByText('Video tools'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('is disabled, and cannot be opened, when told so', async () => {
    setup({ disabled: true });

    expect(processButton()).toBeDisabled();
    await userEvent.click(processButton());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows Starting… while a request is in flight', () => {
    setup({ busy: true, disabled: true });

    expect(screen.getByRole('button', { name: /starting/i })).toBeDisabled();
  });

  it('keeps the menu within a narrow viewport (bounded width, anchored to the button)', async () => {
    setup();
    await userEvent.click(processButton());

    const menu = screen.getByRole('menu');
    expect(menu.className).toMatch(/max-w-\[calc\(100vw-3rem\)\]/);
    expect(menu.className).toMatch(/\bleft-0\b/);
  });
});
