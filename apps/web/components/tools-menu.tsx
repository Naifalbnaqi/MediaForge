'use client';

import { Button } from '@media/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { groupTools, type MediaToolDefinition } from '@/lib/media-tools';

/**
 * The "Process" menu on an uploaded file: one primary button that opens a small
 * grouped list of the tools that apply to the file, instead of a row of one button
 * per tool. Built from the tool registry it is handed (`FileRow` passes
 * `getAvailableTools(mimeType)`), never from a list of its own.
 *
 * Follows the WAI-ARIA "menu button" pattern, with no dependency:
 * - the button has `aria-haspopup="menu"` / `aria-expanded`; Enter, Space or the
 *   arrow keys open it (ArrowUp lands on the last item);
 * - inside the menu the arrow keys, Home and End move focus (wrapping), Escape
 *   closes and returns focus to the button, Tab closes and lets focus move on;
 * - a click or tap outside closes it;
 * - items are real `<button role="menuitem">`s, so activation by click, Enter and
 *   Space needs no extra handling.
 */
export function ToolsMenu({
  tools,
  onSelect,
  disabled = false,
  busy = false,
}: {
  tools: readonly MediaToolDefinition[];
  onSelect: (tool: MediaToolDefinition) => void;
  disabled?: boolean;
  /** True while a processing request is being sent — labels the button "Starting…". */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Which item to focus once the menu has rendered open: 'first' for a click/Enter/
  // Space/ArrowDown, 'last' for ArrowUp.
  const pendingFocusRef = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const sections = groupTools(tools);

  function getItems(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  // Focus the first/last item as the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = getItems();
    (pendingFocusRef.current === 'last' ? items[items.length - 1] : items[0])?.focus();
  }, [open]);

  // A press outside the menu (mouse, touch or pen) closes it without stealing focus
  // from wherever the user pressed.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  function handleButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      pendingFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
      if (open) {
        const items = getItems();
        (event.key === 'ArrowUp' ? items[items.length - 1] : items[0])?.focus();
      } else {
        setOpen(true);
      }
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = getItems();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        items[(currentIndex + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        items[(currentIndex - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Hand focus back to the button first, then let the browser's own Tab move on
        // from there — otherwise the focused item is removed as the menu closes and
        // focus would restart from the top of the page.
        buttonRef.current?.focus();
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => {
          pendingFocusRef.current = 'first';
          setOpen((current) => !current);
        }}
        onKeyDown={handleButtonKeyDown}
      >
        {busy ? 'Starting…' : 'Process'}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </Button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Processing tools"
          onKeyDown={handleMenuKeyDown}
          className="absolute left-0 z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {sections.map((section, sectionIndex) => (
            <div
              key={section.group}
              role="group"
              aria-labelledby={`${menuId}-${section.group}`}
              className={
                sectionIndex > 0 ? 'mt-1 border-t border-slate-100 pt-1 dark:border-slate-800' : ''
              }
            >
              <p
                id={`${menuId}-${section.group}`}
                className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
              >
                {section.label}
              </p>
              {section.tools.map((tool) => (
                <button
                  key={tool.operation}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  // The name is just the label; the one-line description is exposed as
                  // the item's description rather than being read as part of its name.
                  aria-labelledby={`${menuId}-${tool.operation}-label`}
                  aria-describedby={`${menuId}-${tool.operation}-description`}
                  onClick={() => {
                    setOpen(false);
                    onSelect(tool);
                  }}
                  className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800"
                >
                  <span
                    id={`${menuId}-${tool.operation}-label`}
                    className="block text-sm font-medium"
                  >
                    {tool.label}
                  </span>
                  <span
                    id={`${menuId}-${tool.operation}-description`}
                    className="block text-xs text-slate-500 dark:text-slate-400"
                  >
                    {tool.description}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
