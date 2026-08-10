import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionManager } from "../src/permission-manager.js";
import { analyzeShellCommand } from "../src/shell-command-analyzer.js";
import type { GlobalPermissionConfig } from "../src/types.js";
import { runTest } from "./test-harness.js";

function createManager(config: GlobalPermissionConfig): { manager: PermissionManager; cleanup: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-shell-permissions-"));
  const agentsDir = join(baseDir, "agents");
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    manager: new PermissionManager({ globalConfigPath, agentsDir }),
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

runTest("Bash analyzer follows syntax instead of splitting operator text", () => {
  const cases: Array<[string, string[]]> = [
    ["git status && pnpm test || git commit; echo done", ["git status", "pnpm test", "git commit", "echo done"]],
    ["printf 'a && b'; echo a\\;b", ["printf 'a && b'", "echo a\\;b"]],
    ["git status |& tee output &\necho done", ["git status", "tee output", "echo done"]],
    ["echo \"$(git commit)\"", ["echo \"$(git commit)\"", "git commit"]],
    ["diff <(git status) <(git diff)", ["diff <(git status) <(git diff)", "git status", "git diff"]],
    ["if check; then run-a; else run-b; fi", ["check", "run-a", "run-b"]],
    ["(prepare; run) && { finish; }", ["prepare", "run", "finish"]],
    ["for item in a b; do use \"$item\"; done", ["use \"$item\""]],
    ["case $x in a) run-a;; *) run-b;; esac", ["run-a", "run-b"]],
    ["build(){ compile; }\nbuild", ["compile", "build"]],
    ["export X=$(git status)", ["export X=$(git status)", "git status"]],
    ["echo `git status`", ["echo `git status`", "git status"]],
    ["A=1 B=2", ["A=1 B=2"]],
    ["(git status) > output.txt", ["(git status) > output.txt", "git status"]],
  ];

  for (const [command, expected] of cases) {
    const analysis = analyzeShellCommand(command);
    assert.equal(analysis.status, "ok", command);
    assert.deepEqual(analysis.units.map((unit) => unit.command), expected, command);
  }
});

runTest("Bash analyzer respects heredoc expansion rules and redirections", () => {
  const quoted = analyzeShellCommand("cat <<'EOF'\n$(git commit)\nEOF");
  assert.deepEqual(quoted.units.map((unit) => unit.command), ["cat <<'EOF'\n$(git commit)\nEOF"]);

  const unquoted = analyzeShellCommand("cat <<EOF\n$(git commit)\nEOF");
  assert.deepEqual(unquoted.units.map((unit) => unit.command), ["cat <<EOF\n$(git commit)\nEOF", "git commit"]);

  const redirect = analyzeShellCommand("echo hi > output.txt\n> empty.txt");
  assert.deepEqual(redirect.units.map((unit) => unit.command), ["echo hi > output.txt", "> empty.txt"]);
});

runTest("Bash analyzer marks uncertain input as opaque", () => {
  const invalid = analyzeShellCommand("if then");
  assert.equal(invalid.status, "unparseable");
  assert.equal(invalid.units[0]?.kind, "opaque");

  const dynamic = analyzeShellCommand("$COMMAND --force");
  assert.equal(dynamic.status, "ok");
  assert.equal(dynamic.units[0]?.kind, "opaque");
});

runTest("PermissionManager authorizes every Bash execution unit", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: {
      "git *": "allow",
      "echo *": "allow",
      "pnpm *": "ask",
      "rm *": "deny",
    },
  });

  try {
    const allowed = manager.checkPermission("bash", { command: "git status && git commit" });
    assert.equal(allowed.state, "allow");
    assert.deepEqual(allowed.bashChecks?.map((check) => check.state), ["allow", "allow"]);

    const asked = manager.checkPermission("bash", { command: "git status && pnpm test && git commit" });
    assert.equal(asked.state, "ask");
    assert.equal(asked.bashChecks?.find((check) => check.state === "ask")?.command, "pnpm test");

    const denied = manager.checkPermission("bash", { command: "echo \"$(rm -rf build)\"" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.bashChecks?.find((check) => check.state === "deny")?.command, "rm -rf build");
  } finally {
    cleanup();
  }
});

runTest("Bash uncertainty cannot be silently allowed by wildcard policy", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "allow" },
    bash: { "*": "allow" },
  });

  try {
    assert.equal(manager.checkPermission("bash", { command: "if then" }).state, "ask");
    assert.equal(manager.checkPermission("bash", { command: "$COMMAND --force" }).state, "ask");
  } finally {
    cleanup();
  }
});

runTest("A whole-script allow pattern cannot bypass a denied command unit", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: {
      "git *": "allow",
      "rm *": "deny",
      "git status && rm *": "allow",
    },
  });

  try {
    const result = manager.checkPermission("bash", { command: "git status && rm -rf build" });
    assert.equal(result.state, "deny");
    assert.equal(result.matchedPattern, "rm *");
  } finally {
    cleanup();
  }
});

console.log("\nShell command permission tests complete.");
