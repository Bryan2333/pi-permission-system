/**
 * Scrollable full-content viewer rendered as a pi custom overlay component.
 *
 * pi's built-in extension selector renders its title as a plain, non-scrolling
 * Text and clips anything taller than the terminal viewport, so oversized
 * permission prompts can never be inspected in full there. This viewer renders
 * the complete prompt inside a bordered, theme-colored ui.custom overlay with
 * its own keyboard-driven scroll window (↑↓ / PgUp / PgDn / Home / End / Esc).
 */

import { getKeybindings, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

export interface PermissionViewerComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export interface PermissionViewerTui {
  requestRender(): void;
  terminal?: { rows?: number };
}

/** Minimal theme surface used for coloring (pi passes its full Theme). */
export interface PermissionViewerTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

/** Content lines rendered per frame (fixed height keeps the overlay stable). */
export const VIEWER_CONTENT_LINES = 21;

/** Auxiliary frame lines: top border, status, hint, bottom border. */
const VIEWER_FRAME_LINES = 4;

const VIEWER_TITLE = "Full Command";
const VIEWER_HINT_LINE = "↑↓/PgUp/PgDn/Home/End scroll · Esc back to decision menu";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Split content into display lines wrapped to `width` display columns.
 * Plain-text only (prompts are self-assembled without ANSI); honors wide
 * (CJK) characters via visibleWidth and hard-wraps at the boundary so long
 * command lines stay faithful to their source.
 */
export function wrapLinesToWidth(content: string, width: number): string[] {
  const wrapWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of rawLine) {
      const chWidth = visibleWidth(ch);
      if (current.length > 0 && currentWidth + chWidth > wrapWidth) {
        lines.push(current);
        current = ch;
        currentWidth = chWidth;
      } else {
        current += ch;
        currentWidth += chWidth;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Create a scrollable viewer component for the given content.
 */
export function createCommandViewer(
  content: string,
  theme: PermissionViewerTheme,
  tui: PermissionViewerTui,
  done: () => void,
  maxHeight?: number,
): PermissionViewerComponent {
  // Resolve the content window from the current terminal height on every call
  // so resizes while the viewer is open shrink the window instead of letting
  // the TUI clip the last lines. `maxHeight` (from tests) wins when provided.
  const getContentLines = (): number => {
    if (maxHeight !== undefined && Number.isFinite(maxHeight)) {
      return clamp(Math.floor(maxHeight) - VIEWER_FRAME_LINES, 1, VIEWER_CONTENT_LINES);
    }
    const rows = tui.terminal?.rows;
    if (rows !== undefined && Number.isFinite(rows)) {
      // Leave one row of breathing room so the frame never touches the edge.
      return clamp(Math.floor(rows) - VIEWER_FRAME_LINES - 1, 1, VIEWER_CONTENT_LINES);
    }
    return VIEWER_CONTENT_LINES;
  };
  let scrollTop = 0;
  let renderedWidth = 0;
  let wrapped: string[] = [];

  const ensureWrapped = (width: number): void => {
    const contentWidth = Math.max(1, width - 3);
    if (renderedWidth !== contentWidth) {
      wrapped = wrapLinesToWidth(content, contentWidth);
      renderedWidth = contentWidth;
      scrollTop = clamp(scrollTop, 0, Math.max(0, wrapped.length - getContentLines()));
    }
  };

  const setScrollTop = (next: number): void => {
    const maxTop = Math.max(0, wrapped.length - getContentLines());
    const clamped = clamp(next, 0, maxTop);
    if (clamped !== scrollTop) {
      scrollTop = clamped;
      tui.requestRender();
    }
  };

  const scrollBy = (delta: number): void => {
    setScrollTop(scrollTop + delta);
  };

  const border = (text: string): string => theme.fg("border", text);
  const dim = (text: string): string => theme.fg("dim", text);
  const accent = (text: string): string => theme.fg("accent", theme.bold?.(text) ?? text);

  const padTo = (text: string, width: number): string => {
    // "│ " (2 cols) + content + "│" (1 col) must total `width`.
    const padding = Math.max(0, width - 3 - visibleWidth(text));
    return text + " ".repeat(padding);
  };

  return {
    render(width: number): string[] {
      ensureWrapped(width);
      const contentLines = getContentLines();
      const start = Math.min(scrollTop, Math.max(0, wrapped.length - contentLines));
      const visible = wrapped.slice(start, start + contentLines);
      const contentRowLines = [...visible];
      while (contentRowLines.length < contentLines) {
        contentRowLines.push("");
      }

      const innerWidth = Math.max(1, width - 2);
      const total = wrapped.length;
      const status = total <= contentLines
        ? "All content shown"
        : `Showing lines ${start + 1}-${Math.min(start + contentLines, total)} of ${total}`;
      const hint = VIEWER_HINT_LINE.length > innerWidth
        ? VIEWER_HINT_LINE.slice(0, Math.max(1, innerWidth - 1))
        : VIEWER_HINT_LINE;

      const title = ` ${VIEWER_TITLE} `;
      const titleFiller = "─".repeat(Math.max(0, width - 3 - visibleWidth(title)));

      const lines: string[] = [];
      lines.push(border(`┌─`) + accent(title) + border(`${titleFiller}┐`));
      for (const line of contentRowLines) {
        lines.push(border("│ ") + theme.fg("text", padTo(line, width)) + border("│"));
      }
      lines.push(border("│ ") + dim(padTo(status, width)) + border("│"));
      lines.push(border("│ ") + dim(padTo(hint, width)) + border("│"));
      lines.push(border(`└${"─".repeat(Math.max(0, innerWidth))}┘`));
      return lines;
    },
    handleInput(data: string): void {
      const kb = getKeybindings();
      // pi delivers raw byte sequences (e.g. "\x1b[A", "\x1b"), so match via
      // the TUI keybinding engine instead of string equality.
      if (kb.matches(data, "tui.select.up") || data === "k") {
        scrollBy(-1);
      } else if (kb.matches(data, "tui.select.down") || data === "j") {
        scrollBy(1);
      } else if (kb.matches(data, "tui.select.pageUp")) {
        scrollBy(-getContentLines());
      } else if (kb.matches(data, "tui.select.pageDown")) {
        scrollBy(getContentLines());
      } else if (matchesKey(data, "home")) {
        setScrollTop(0);
      } else if (matchesKey(data, "end")) {
        setScrollTop(wrapped.length);
      } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
        done();
      } else if (kb.matches(data, "tui.select.confirm")) {
        done();
      }
    },
    invalidate(): void {
      renderedWidth = 0;
    },
  };
}
