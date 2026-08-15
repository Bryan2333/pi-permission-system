import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkEditPreflight } from "../src/edit-preflight.js";
import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
} from "../src/extension-config.js";
import piPermissionSystemExtension from "../src/index.js";
import {
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import { runAsyncTest } from "./test-harness.js";

// Issue #30 RED coverage: an edit that is guaranteed to fail inside Pi's edit
// tool (stale oldText, duplicate anchor, missing file, overlapping or no-op
// replacements) must be blocked silently instead of prompting the user to
// approve a doomed operation. Edits that can still be applied (including
// fuzzy-matched anchors) keep their normal ask prompt.

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type ToolCallHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  cleanup: () => Promise<void>;
};

type ContextOptions = {
  selectResponse?: string;
};

const ISOLATED_ENV_KEYS = [
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  ...SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
] as const;

for (const key of ISOLATED_ENV_KEYS) {
  delete process.env[key];
}

type HarnessPolicyOverrides = {
  tools?: Record<string, unknown>;
  special?: Record<string, unknown>;
};

function createToolCallHarness(overrides: HarnessPolicyOverrides = {}): ToolCallHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-30-"));
  const cwd = join(baseDir, "workspace");
  const policyDir = join(baseDir, "policy");
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};

  const originalValues = new Map<string, string | undefined>();
  for (const key of [
    "PI_CODING_AGENT_DIR",
    PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
    CONFIG_PATH_ENV_KEY,
    LOGS_DIR_ENV_KEY,
    ...SUBAGENT_ENV_HINT_KEYS,
    SUBAGENT_PARENT_SESSION_ENV_KEY,
  ] as const) {
    originalValues.set(key, process.env[key]);
  }

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(policyDir, "agents"), { recursive: true });
  writeFileSync(
    join(policyDir, "pi-permissions.jsonc"),
    `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      tools: overrides.tools ?? {},
      special: overrides.special ?? {},
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = policyDir;
  process.env[PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY] = policyDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  for (const key of [...SUBAGENT_ENV_HINT_KEYS, SUBAGENT_PARENT_SESSION_ENV_KEY] as const) {
    delete process.env[key];
  }

  const harness: ToolCallHarness = {
    baseDir,
    cwd,
    prompts,
    handlers,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(harness)));
      for (const [key, value] of originalValues.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => [{ name: "edit" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return harness;
}

function createMockContext(
  harness: ToolCallHarness,
  options: ContextOptions = {},
): Record<string, unknown> {
  return {
    cwd: harness.cwd,
    hasUI: true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "issue-30-session",
      getSessionDir: (): string => harness.cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        harness.prompts.push(title);
        return options.selectResponse ?? "Reject";
      },
      input: async (): Promise<string | undefined> => undefined,
    },
  };
}

async function runSessionStart(harness: ToolCallHarness): Promise<void> {
  const handler = harness.handlers.session_start;
  assert.equal(typeof handler, "function", "session_start handler should be registered");
  await Promise.resolve(handler({ reason: "startup" }, createMockContext(harness)));
}

async function runToolCall(
  harness: ToolCallHarness,
  event: Record<string, unknown>,
  options: ContextOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function", "tool_call handler should be registered");
  const result = await Promise.resolve(handler(event, createMockContext(harness, options)));
  return (result ?? {}) as Record<string, unknown>;
}

function createEditEvent(input: Record<string, unknown>): Record<string, unknown> {
  return {
    toolName: "edit",
    toolCallId: `issue-30-${Math.random().toString(36).slice(2, 10)}`,
    input,
  };
}

async function runAsyncTestWithHarness(
  testFn: (harness: ToolCallHarness) => Promise<void>,
  overrides?: HarnessPolicyOverrides,
): Promise<void> {
  const harness = createToolCallHarness(overrides);
  try {
    await runSessionStart(harness);
    await testFn(harness);
  } finally {
    await harness.cleanup();
  }
}

await runAsyncTest("ISSUE30: stale edit oldText is blocked silently without a permission prompt", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "answer.ts"), "export const answer = 41;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/answer.ts",
      oldText: "export const answer = 40;\n",
      newText: "export const answer = 42;\n",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /Could not find the exact text in src\/answer\.ts/i);
    assert.equal(
      harness.prompts.length,
      0,
      "a doomed edit must not render a permission prompt",
    );
  }));

await runAsyncTest("ISSUE30: a feasible edit keeps its normal ask prompt", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "answer.ts"), "export const answer = 41;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/answer.ts",
      oldText: "export const answer = 41;\n",
      newText: "export const answer = 42;\n",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied tool 'edit'/i);
    assert.equal(
      harness.prompts.length,
      1,
      "a feasible edit must still ask the user for approval",
    );
  }));

await runAsyncTest("ISSUE30: structured edits array with a duplicate anchor is blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "dup.ts"), "const x = 1;\nconst x = 1;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/dup.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /must be unique/i);
    assert.equal(harness.prompts.length, 0);
  }));

await runAsyncTest("ISSUE30: edit targeting a missing file is blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    const result = await runToolCall(harness, createEditEvent({
      path: "src/missing.ts",
      oldText: "anything",
      newText: "something else",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /Could not edit file: src\/missing\.ts/i);
    assert.equal(harness.prompts.length, 0);
  }));

await runAsyncTest("ISSUE30: allow policy still runs doomed edits through without preflight blocking", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "answer.ts"), "export const answer = 41;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/answer.ts",
      oldText: "export const answer = 40;\n",
      newText: "export const answer = 42;\n",
    }));

    assert.deepEqual(result, {}, "an allowed edit must not be touched by the preflight check");
    assert.equal(harness.prompts.length, 0);
  }, { tools: { edit: "allow" } }));

await runAsyncTest("ISSUE30: fuzzy-matched oldText (trailing whitespace) stays feasible", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-30-unit-"));
  try {
    const target = join(baseDir, "fuzzy.ts");
    writeFileSync(target, "const x = 1; \n", "utf8");

    const result = await checkEditPreflight(
      { path: "fuzzy.ts", oldText: "const x = 1;\n", newText: "const x = 2;\n" },
      baseDir,
    );

    assert.deepEqual(result, { feasible: true }, "Pi's fuzzy matcher would apply this edit");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("ISSUE30: overlapping structured edits are blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "overlap.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/overlap.ts",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "a = 1;", newText: "a = 11;" },
      ],
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /overlap in src\/overlap\.ts/i);
    assert.equal(harness.prompts.length, 0);
  }));

await runAsyncTest("ISSUE30: no-op replacement (oldText equals newText) is blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "noop.ts"), "const a = 1;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/noop.ts",
      oldText: "const a = 1;\n",
      newText: "const a = 1;\n",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /No changes made to src\/noop\.ts/i);
    assert.equal(harness.prompts.length, 0);
  }));

await runAsyncTest("ISSUE30: empty oldText is blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "empty.ts"), "const a = 1;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/empty.ts",
      oldText: "",
      newText: "const a = 2;\n",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /oldText must not be empty/i);
    assert.equal(harness.prompts.length, 0);
  }));

await runAsyncTest("ISSUE30: external directory confirmation runs before the preflight file read", () =>
  runAsyncTestWithHarness(async (harness) => {
    const externalPath = join(harness.baseDir, "outside", "missing.ts");

    const result = await runToolCall(
      harness,
      createEditEvent({
        path: externalPath,
        oldText: "anything",
        newText: "something else",
      }),
      { selectResponse: "Allow Once" },
    );

    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /Could not edit file/i,
      "the preflight must still block the doomed edit after external access was approved",
    );
    assert.equal(
      harness.prompts.length,
      1,
      "the external directory prompt must render before the preflight reads the target file",
    );
    assert.match(harness.prompts[0] ?? "", /external directory access/i);
  }));

await runAsyncTest("ISSUE30: Unicode-space paths resolve like Pi's resolveToCwd", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-30-unit-"));
  try {
    const target = join(baseDir, "a b.txt");
    writeFileSync(target, "const x = 1;\n", "utf8");

    const result = await checkEditPreflight(
      { path: "a\u00A0b.txt", oldText: "const x = 1;", newText: "const x = 2;" },
      baseDir,
    );

    assert.deepEqual(
      result,
      { feasible: true },
      "a no-break space in the path must fold to a regular space like Pi does",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("ISSUE30: file:// URL paths resolve like Pi's resolveToCwd", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-30-unit-"));
  try {
    const target = join(baseDir, "url.ts");
    writeFileSync(target, "const x = 1;\n", "utf8");

    const result = await checkEditPreflight(
      { path: pathToFileURL(target).href, oldText: "const x = 1;", newText: "const x = 2;" },
      baseDir,
    );

    assert.deepEqual(result, { feasible: true }, "a file:// URL must resolve to the real path");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("ISSUE30: multiple replacements whose net result is unchanged are blocked silently", () =>
  runAsyncTestWithHarness(async (harness) => {
    writeFileSync(join(harness.cwd, "src", "swap.ts"), "foo\nbar\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: "src/swap.ts",
      edits: [
        { oldText: "foo \n", newText: "foo\n" },
        { oldText: "bar \n", newText: "bar\n" },
      ],
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /No changes made to src\/swap\.ts/i);
    assert.equal(
      harness.prompts.length,
      0,
      "an edit that leaves the file byte-identical must not prompt even when every replacement is individually non-identical",
    );
  }));

await runAsyncTest("ISSUE30: fuzzy-matched no-change edits are blocked silently", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-issue-30-unit-"));
  try {
    const target = join(baseDir, "fuzzy-noop.ts");
    writeFileSync(target, "foo\n", "utf8");

    const result = await checkEditPreflight(
      { path: "fuzzy-noop.ts", oldText: "foo \n", newText: "foo\n" },
      baseDir,
    );

    assert.deepEqual(
      result,
      { feasible: false, reason: "Blocked before execution: No changes made to fuzzy-noop.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected." },
      "a fuzzy match whose replacement leaves the file byte-identical must be treated as doomed",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("ISSUE30: external file:// URL is denied by external_directory policy", () =>
  runAsyncTestWithHarness(async (harness) => {
    const externalTarget = join(harness.baseDir, "outside", "secret.ts");
    mkdirSync(dirname(externalTarget), { recursive: true });
    writeFileSync(externalTarget, "const secret = 1;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: pathToFileURL(externalTarget).href,
      oldText: "const secret = 1;",
      newText: "const secret = 2;",
    }));

    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /outside working directory/i,
      "a file:// URL outside the worktree must be rejected by the external-directory check, not by the tool prompt",
    );
    assert.equal(
      harness.prompts.length,
      0,
      "external_directory deny must not render a normal edit permission prompt",
    );
  }, { special: { external_directory: "deny" } }));

await runAsyncTest("ISSUE30: file:// URL inside the worktree is not treated as external", () =>
  runAsyncTestWithHarness(async (harness) => {
    const insideTarget = join(harness.cwd, "src", "inside.ts");
    writeFileSync(insideTarget, "const x = 1;\n", "utf8");

    const result = await runToolCall(harness, createEditEvent({
      path: pathToFileURL(insideTarget).href,
      oldText: "const x = 1;",
      newText: "const x = 2;",
    }));

    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied tool 'edit'/i);
    assert.equal(
      harness.prompts.length,
      1,
      "a file:// URL inside the worktree must keep the normal edit permission prompt",
    );
  }, { special: { external_directory: "deny" } }));

console.log("Issue #30 doomed edit preflight TDD tests completed.");
