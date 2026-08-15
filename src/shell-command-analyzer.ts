import { createRequire } from "node:module";

import { Language, Parser, type Node } from "web-tree-sitter";

import type {
  BashAnalysisStatus,
  BashCommandUnit,
  BashPermissionCheck,
  PermissionState,
} from "./types.js";

const MAX_COMMAND_BYTES = 256 * 1024;
const EXECUTABLE_NODE_TYPES = [
  "command",
  "declaration_command",
  "test_command",
  "unset_command",
  "variable_assignment",
  "variable_assignments",
] as const;
const DYNAMIC_COMMAND_NAME_TYPES = new Set([
  "command_substitution",
  "expansion",
  "process_substitution",
  "simple_expansion",
]);
const OUTPUT_REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);

let parser: Parser | null = null;

try {
  await Parser.init();
  const bashWasmPath = createRequire(import.meta.url).resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bashLanguage = await Language.load(bashWasmPath);
  parser = new Parser().setLanguage(bashLanguage);
} catch {
  parser = null;
}

export interface BashCommandAnalysis {
  status: BashAnalysisStatus;
  units: BashCommandUnit[];
}

export interface BashCommandPermissionEvaluation {
  state: PermissionState;
  matchedPattern?: string;
  analysisStatus: BashAnalysisStatus;
  checks: BashPermissionCheck[];
}

export type BashUnitPermissionEvaluator = (
  command: string,
) => { state: PermissionState; matchedPattern?: string } | null;

function hasDynamicCommandName(node: Node): boolean {
  if (node.type !== "command") {
    return false;
  }

  const name = node.childForFieldName("name");
  if (!name) {
    return true;
  }

  return name.descendantsOfType([...DYNAMIC_COMMAND_NAME_TYPES]).some(Boolean);
}

function isNestedAssignment(node: Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "command"
      || parent.type === "declaration_command"
      || parent.type === "variable_assignments"
    ) {
      return true;
    }
    if (parent.type.endsWith("statement") || parent.type === "program") {
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

function hasOutputRedirect(node: Node): boolean {
  return node.descendantsOfType("file_redirect").some((redirect) =>
    redirect?.children.some((child, index) => {
      if (!child || !OUTPUT_REDIRECT_OPERATORS.has(child.type)) {
        return false;
      }
      // `>&` to a numbered fd (e.g. 2>&1) duplicates the descriptor without writing a file.
      return child.type !== ">&" || redirect.children[index + 1]?.type !== "number";
    }) === true,
  );
}

function toUnit(node: Node): BashCommandUnit | null {
  if ((node.type === "variable_assignment" || node.type === "variable_assignments") && isNestedAssignment(node)) {
    return null;
  }

  const parent = node.parent;
  const selected = parent?.type === "redirected_statement" ? parent : node;
  const outputRedirect = hasOutputRedirect(selected);
  return {
    command: selected.text,
    startIndex: selected.startIndex,
    endIndex: selected.endIndex,
    kind: hasDynamicCommandName(node) ? "opaque" : outputRedirect ? "output_redirect" : "command",
    hasOutputRedirect: outputRedirect,
  };
}

function opaqueAnalysis(command: string, status: Exclude<BashAnalysisStatus, "ok">): BashCommandAnalysis {
  const commandBytes = new TextEncoder().encode(command).byteLength;
  return {
    status,
    units: command
      ? [{ command, startIndex: 0, endIndex: commandBytes, kind: "opaque", hasOutputRedirect: false }]
      : [],
  };
}

export function analyzeShellCommand(command: string): BashCommandAnalysis {
  if (new TextEncoder().encode(command).byteLength > MAX_COMMAND_BYTES) {
    return opaqueAnalysis(command, "too_large");
  }
  if (!parser) {
    return opaqueAnalysis(command, "unavailable");
  }

  let tree;
  try {
    tree = parser.parse(command);
  } catch {
    parser.reset();
    return opaqueAnalysis(command, "unparseable");
  }
  if (!tree) {
    return opaqueAnalysis(command, "unparseable");
  }

  try {
    const root = tree.rootNode;
    if (root.hasError) {
      return opaqueAnalysis(command, "unparseable");
    }

    const unitsBySpan = new Map<string, BashCommandUnit>();
    for (const node of root.descendantsOfType([...EXECUTABLE_NODE_TYPES])) {
      if (!node) {
        continue;
      }
      const unit = toUnit(node);
      if (!unit) {
        continue;
      }
      const key = `${unit.startIndex}:${unit.endIndex}`;
      const existing = unitsBySpan.get(key);
      if (!existing || unit.kind === "opaque") {
        unitsBySpan.set(key, unit);
      }
    }

    for (const node of root.descendantsOfType("redirected_statement")) {
      if (!node) {
        continue;
      }
      const key = `${node.startIndex}:${node.endIndex}`;
      if (!unitsBySpan.has(key)) {
        const outputRedirect = hasOutputRedirect(node);
        unitsBySpan.set(key, {
          command: node.text,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          kind: outputRedirect ? "output_redirect" : "command",
          hasOutputRedirect: outputRedirect,
        });
      }
    }

    return {
      status: "ok",
      units: [...unitsBySpan.values()].sort((left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex,
      ),
    };
  } catch {
    return opaqueAnalysis(command, "unparseable");
  } finally {
    tree.delete();
  }
}

export function evaluateShellCommandPermissions(
  command: string,
  fallbackState: PermissionState,
  evaluateUnit: BashUnitPermissionEvaluator,
): BashCommandPermissionEvaluation {
  const analysis = analyzeShellCommand(command);
  const checks = analysis.units.map((unit) => {
    const match = evaluateUnit(unit.command);
    const matchedState = match?.state ?? fallbackState;
    // A `>` inside a quoted section of the pattern (e.g. `sed 's/>//' *`) is a literal, not a redirect.
    const explicitRedirectRule = match?.matchedPattern?.replace(/"[^"]*"|'[^']*'/g, "").includes(">") === true;
    const state = (
      analysis.status !== "ok"
      || unit.kind === "opaque"
      || (unit.hasOutputRedirect && matchedState !== "deny" && !explicitRedirectRule)
    ) && matchedState !== "deny"
      ? "ask"
      : matchedState;
    return {
      ...unit,
      state,
      matchedPattern: state === matchedState ? match?.matchedPattern : undefined,
    };
  });
  const severity: Record<PermissionState, number> = { allow: 0, ask: 1, deny: 2 };
  const decisiveCheck = checks.reduce<(typeof checks)[number] | undefined>(
    (current, check) => !current || severity[check.state] > severity[current.state] ? check : current,
    undefined,
  );

  return {
    state: decisiveCheck?.state ?? fallbackState,
    matchedPattern: decisiveCheck?.matchedPattern,
    analysisStatus: analysis.status,
    checks,
  };
}
