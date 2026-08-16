// ---------------------------------------------------------------------------
// Tests for the scrollable full-command viewer and the "View Full Command"
// permission dialog flow.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  createCommandViewer,
  wrapLinesToWidth,
  VIEWER_CONTENT_LINES,
  type PermissionViewerComponent,
  type PermissionViewerTheme,
  type PermissionViewerTui,
} from "../src/command-viewer.js";
import { requestPermissionDecisionFromUi } from "../src/permission-dialog.js";
import { runTest, runAsyncTest } from "./test-harness.js";

const MOCK_THEME: PermissionViewerTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

// ===========================================================================
// wrapLinesToWidth
// ===========================================================================

runTest("command viewer: wrapLinesToWidth hard-wraps long lines and keeps empties", () => {
  const content = "aaaa\n" + "b".repeat(100) + "\n\n" + "c";
  const lines = wrapLinesToWidth(content, 30);
  assert.deepEqual(lines, [
    "aaaa",
    "b".repeat(30),
    "b".repeat(30),
    "b".repeat(30),
    "b".repeat(10),
    "",
    "c",
  ]);
});

runTest("command viewer: wrapLinesToWidth handles CRLF and narrow widths", () => {
  assert.deepEqual(wrapLinesToWidth("ab\r\ncd", 1), ["a", "b", "c", "d"]);
  assert.deepEqual(wrapLinesToWidth("abc", 0), ["a", "b", "c"], "width below 1 wraps at 1 column");
});

// ===========================================================================
// Viewer component behavior
// ===========================================================================

function createHarness(content: string) {
  let renders = 0;
  let closed = false;
  const tui: PermissionViewerTui = {
    requestRender: () => {
      renders += 1;
    },
  };
  const component = createCommandViewer(content, MOCK_THEME, tui, () => {
    closed = true;
  });
  return { tui, component, renders: () => renders, closed: () => closed };
}

const LONG_CONTENT = Array.from({ length: 50 }, (_, i) => `line-${i}-` + "x".repeat(60)).join("\n");

runTest("command viewer: render shows a bordered frame with the first window", () => {
  const { component } = createHarness(LONG_CONTENT);
  const lines = component.render(80);
  assert.equal(lines.length, VIEWER_CONTENT_LINES + 4, "top border + content + status + hint + bottom border");
  assert.ok(lines[0].startsWith("┌─ Full Command "), "top border carries the title");
  assert.ok(lines[0].endsWith("┐"), "top border closes on the right");
  assert.ok(lines[1].startsWith("│ ") && lines[1].includes("line-0-"), "first content line inside the frame");
  assert.match(lines[VIEWER_CONTENT_LINES + 1], /Showing lines 1-\d+ of 50/, "status shows range");
  assert.ok(lines[VIEWER_CONTENT_LINES + 3].startsWith("└") && lines[VIEWER_CONTENT_LINES + 3].endsWith("┘"), "bottom border");
});

runTest("command viewer: render pads short content and shows all-content status", () => {
  const { component } = createHarness("short\ncontent");
  const lines = component.render(80);
  assert.equal(lines.length, VIEWER_CONTENT_LINES + 4);
  assert.ok(lines.slice(1, 3).join("\n").includes("content"), "content rendered");
  assert.ok(lines[VIEWER_CONTENT_LINES + 1].includes("All content shown"), "status line");
});

runTest("command viewer: wide characters wrap by display width", () => {
  const { component } = createHarness("命令命令命令命令");
  const lines = component.render(10);
  // Each CJK char is 2 columns wide: 5 chars fit in a 10-column window.
  assert.ok(lines.slice(1, VIEWER_CONTENT_LINES + 1).every((l) => l !== ""), "content wrapped");
  const content = lines.slice(1, VIEWER_CONTENT_LINES + 1).join("");
  assert.equal(content.replace(/[│ ]/g, ""), "命令命令命令命令", "all chars present, no loss");
});

runTest("command viewer: keyboard scrolling moves the window and clamps at edges", () => {
  const { component, renders, closed } = createHarness(LONG_CONTENT);
  component.render(80);

  component.handleInput?.("\x1b[B");
  assert.equal(renders(), 1, "scroll triggers render");
  assert.ok(component.render(80)[1].includes("line-1-"), "scrolled down one line");

  component.handleInput?.("\x1b[A");
  component.handleInput?.("\x1b[A");
  assert.ok(component.render(80)[1].includes("line-0-"), "scrolled back to top");

  component.handleInput?.("\x1b[F");
  assert.ok(
    component.render(80)[1].includes("line-29-"),
    "end jumps to last window (50 lines, 21-line window)",
  );

  component.handleInput?.("\x1b[B");
  assert.ok(
    component.render(80)[1].includes("line-29-"),
    "clamped at bottom",
  );

  component.handleInput?.("\x1b[H");
  assert.ok(component.render(80)[1].includes("line-0-"), "home jumps to top");

  component.handleInput?.("\x1b[6~");
  const afterPage = component.render(80)[1];
  assert.ok(afterPage.includes("line-21-"), `pageDown moves one page, got ${afterPage}`);

  component.handleInput?.("\x1b");
  assert.equal(closed(), true, "escape closes the viewer");
});

runTest("command viewer: maxHeight caps the window so the last lines stay reachable", () => {
  // 24-row terminal at 85% gives a 20-row overlay → 16 content lines.
  const tui: PermissionViewerTui = { requestRender() {} };
  const small = createCommandViewer(LONG_CONTENT, MOCK_THEME, tui, () => {}, 20);
  const lines = small.render(80);
  assert.equal(lines.length, 20, "renders exactly the capped height");
  assert.ok(
    lines[lines.length - 1].startsWith("└") && lines[lines.length - 1].endsWith("┘"),
    "bottom border present",
  );

  small.handleInput?.("\x1b[F");
  const lastWindow = small.render(80);
  assert.ok(
    lastWindow[1].includes("line-34-") && lastWindow[16].includes("line-49-"),
    "End reaches the final lines inside the capped window",
  );
  assert.ok(lastWindow[17].includes("Showing lines 35-50 of 50"), "status reflects the capped window");
});

runTest("command viewer: terminal resize shrinks the window dynamically", () => {
  const tui: PermissionViewerTui = { requestRender() {}, terminal: { rows: 40 } };
  const component = createCommandViewer(LONG_CONTENT, MOCK_THEME, tui, () => {});
  let lines = component.render(80);
  assert.equal(lines.length, VIEWER_CONTENT_LINES + 4, "tall terminal uses the full window");

  // Terminal shrinks to 20 rows while the viewer is open.
  tui.terminal = { rows: 20 };
  lines = component.render(80);
  assert.equal(lines.length, 19, "window shrinks with the terminal (20 rows - frame - 1)");
  component.handleInput?.("\x1b[F");
  const lastWindow = component.render(80);
  assert.ok(
    lastWindow[1].includes("line-35-") && lastWindow[15].includes("line-49-"),
    "End reaches the final lines after the shrink",
  );

  // And grows back.
  tui.terminal = { rows: 40 };
  lines = component.render(80);
  assert.equal(lines.length, VIEWER_CONTENT_LINES + 4, "window grows back after the terminal grows");
});

runTest("command viewer: q and enter close, re-render after resize rewraps", () => {
  const { component, closed } = createHarness(LONG_CONTENT);
  component.render(80);
  component.handleInput?.("q");
  assert.equal(closed(), true, "q closes the viewer");

  const enter = createHarness(LONG_CONTENT);
  enter.component.render(80);
  enter.component.handleInput?.("\r");
  assert.equal(enter.closed(), true, "enter closes the viewer");

  const wide = createHarness(LONG_CONTENT);
  const narrowLines = wide.component.render(20);
  assert.ok(narrowLines[1].length <= 20, "narrow width wraps content");
  const wideLines = wide.component.render(100);
  assert.ok(wideLines[1].includes("line-0-") && wideLines[1].length > 20, "resize rewraps wider");
});

// ===========================================================================
// Permission dialog integration
// ===========================================================================

// Long enough (25 lines) to exceed the compaction threshold, so the
// "View Full Command" option is offered and the viewer can be exercised.
const COMPACTED_MESSAGE = [
  "Agent requested bash command 'git status'. Allow this command?",
  "",
  ...Array.from({ length: 22 }, (_, i) => `line-${i}-` + "x".repeat(60)),
  "END-OF-COMMAND-MARKER",
].join("\n");

const SHORT_MESSAGE = "Agent requested bash command 'git status'. Allow this command?";

await runAsyncTest("permission dialog: View Full Command opens viewer with the full prompt", async () => {
  const calls: string[] = [];
  let viewerContent = "";
  const ui = {
    select: async (_title: string, options: string[]) => {
      calls.push(`select:${options.join("|")}`);
      return calls.length === 1 ? "View Full Command" : "Allow Once";
    },
    input: async () => undefined,
    custom: async <T>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => PermissionViewerComponent | Promise<PermissionViewerComponent>,
    ) => {
      calls.push("custom");
      const component = await factory({ requestRender() {} }, MOCK_THEME, {}, () => {});
      component.render(80);
      component.handleInput?.("\x1b[F"); // jump to the end before capturing
      viewerContent = component.render(80).join("\n");
      return "closed" as T;
    },
  };

  const decision = await requestPermissionDecisionFromUi(
    ui,
    "Permission Required",
    COMPACTED_MESSAGE,
  );

  assert.equal(decision.approved, true);
  assert.equal(decision.state, "once");
  assert.deepEqual(calls, [
    "select:Allow Once|Allow Always|Reject|Reject with Reason|View Full Command",
    "custom",
    "select:Allow Once|Allow Always|Reject|Reject with Reason|View Full Command",
  ], "viewer opens between two select menus");
  assert.ok(
    viewerContent.includes("END-OF-COMMAND-MARKER"),
    "viewer receives the full uncompacted prompt",
  );
});

await runAsyncTest("permission dialog: short prompts hide the viewer option", async () => {
  let displayedOptions: string[] | undefined;
  let viewerOpened = false;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (_title: string, options: string[]) => {
        displayedOptions = options;
        return "Allow Once";
      },
      input: async () => undefined,
      custom: async <T>(
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => PermissionViewerComponent | Promise<PermissionViewerComponent>,
      ) => {
        viewerOpened = true;
        return "closed" as T;
      },
    },
    "Permission Required",
    SHORT_MESSAGE,
  );

  assert.deepEqual(displayedOptions, [
    "Allow Once",
    "Allow Always",
    "Reject",
    "Reject with Reason",
  ], "uncompacted prompt does not offer View Full Command");
  assert.equal(viewerOpened, false, "viewer never opens for short prompts");
  assert.equal(decision.state, "once");
});

await runAsyncTest("permission dialog: expired deadline auto-denies before the first select", async () => {
  const realNow = Date.now.bind(Date);
  let selectCalls = 0;
  // Each Date.now() call advances 10s, so the deadline (5ms) expires between
  // the function's startedAt snapshot and the first getSelectOptions() call.
  let fakeNow = realNow();
  Date.now = () => {
    fakeNow += 10_000;
    return fakeNow;
  };
  try {
    const decision = await requestPermissionDecisionFromUi(
      {
        select: async () => {
          selectCalls += 1;
          return "Allow Once";
        },
        input: async () => undefined,
      },
      "Permission Required",
      SHORT_MESSAGE,
      { timeoutMs: 5, timeoutDenialReason: "permission_timeout: expired." },
    );

    assert.equal(selectCalls, 0, "no select is opened after the deadline expires");
    assert.equal(decision.approved, false);
    assert.equal(decision.denialReason, "permission_timeout: expired.");
  } finally {
    Date.now = realNow;
  }
});

await runAsyncTest("permission dialog: without custom capability the option is hidden", async () => {
  let displayedOptions: string[] | undefined;
  let displayedTitle = "";
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (title: string, options: string[]) => {
        displayedOptions = options;
        displayedTitle = title;
        return "Reject";
      },
      input: async () => undefined,
    },
    "Permission Required",
    COMPACTED_MESSAGE,
  );

  assert.deepEqual(displayedOptions, [
    "Allow Once",
    "Allow Always",
    "Reject",
    "Reject with Reason",
  ]);
  assert.ok(
    !displayedTitle.includes("View Full Command"),
    "compaction notice must not recommend a hidden option",
  );
  assert.equal(decision.state, "reject");
});

await runAsyncTest("permission dialog: viewer loop cannot extend the timeout deadline", async () => {
  const TIMEOUT_MS = 20;
  let selectCalls = 0;
  const ui = {
    select: async (_title: string, _options: string[]) => {
      selectCalls += 1;
      return "View Full Command";
    },
    input: async () => undefined,
    custom: async <T>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => PermissionViewerComponent | Promise<PermissionViewerComponent>,
    ) => {
      // Simulate the user reading the viewer past the deadline.
      await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + 10));
      const component = await factory({ requestRender() {} }, MOCK_THEME, {}, () => {});
      component.render(80);
      return "closed" as T;
    },
  };

  const decision = await requestPermissionDecisionFromUi(
    ui,
    "Permission Required",
    COMPACTED_MESSAGE,
    { timeoutMs: TIMEOUT_MS, timeoutDenialReason: "permission_timeout: deadline passed." },
  );

  assert.equal(selectCalls, 1, "no second select after the deadline expires");
  assert.equal(decision.approved, false);
  assert.equal(decision.state, "reject");
  assert.equal(decision.denialReason, "permission_timeout: deadline passed.");
});
