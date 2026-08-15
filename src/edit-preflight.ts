import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { expandPathValue, getNonEmptyString, toRecord } from "./common.js";

/**
 * Pre-execution feasibility check for Pi's `edit` tool.
 *
 * When an `edit` call resolves to an interactive `ask`, this module checks
 * whether the edit can actually be applied to the current file content. An
 * edit whose payload cannot match (stale oldText, duplicate anchor, missing
 * file, overlapping replacements, ...) is guaranteed to fail inside Pi's edit
 * tool, so prompting the user for it is pure noise. The permission hook blocks
 * such edits silently and returns a reason mirroring Pi's own edit-tool errors
 * so the agent can correct the payload and retry.
 *
 * The matching rules mirror pi-coding-agent `core/tools/edit-diff.js`
 * (`normalizeToLF`, `normalizeForFuzzyMatch`, `fuzzyFindText`, the failure
 * order of `applyEditsToNormalizedContent` including its no-change detection,
 * and the line-preserving overlay for fuzzy matches) plus `core/tools/edit.js`
 * (`prepareEditArguments` and the execute-time access/read checks). Path
 * resolution shares `common.ts` `expandPathValue`, which mirrors path-utils.js
 * `resolveToCwd` including Unicode-space folding and `file://` URLs, so the
 * preflight never reads a different file than the external-directory check
 * judged. The check is conservative: it only reports an edit as infeasible
 * when the current Pi tool implementation would deterministically fail.
 * Payloads that are not plain `oldText`/`newText` replacement lists (such as
 * op/pos/lines hashline edits this extension supports for edit-like tools)
 * skip the preflight and keep their normal prompt behavior.
 */

export type EditPreflightResult =
  | { feasible: true }
  | { feasible: false; reason: string };

type EditReplacement = { oldText: string; newText: string };

/** Mirrors pi-coding-agent edit-diff.js `normalizeToLF`. */
function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Mirrors pi-coding-agent edit-diff.js `normalizeForFuzzyMatch`. */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Resolves an edit target path exactly like pi-coding-agent `resolveToCwd`. */
function resolveEditPath(pathValue: string, cwd: string): string {
  const normalized = expandPathValue(pathValue);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function formatFileError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `Error code: ${error.code}.`;
  }
  return String(error);
}

/**
 * Mirrors pi-coding-agent edit.js `prepareEditArguments` (edits array plus
 * legacy flat oldText/newText). Returns `not-pi-format` when the payload is
 * not a plain oldText/newText replacement list (for example op/pos/lines
 * hashline edits, which this extension supports for edit-like tools): such
 * payloads are not validated by the preflight check and keep their normal
 * prompt behavior.
 */
function extractEditReplacements(
  record: Record<string, unknown>,
): { status: "parseable"; replacements: EditReplacement[] } | { status: "not-pi-format" } {
  let editsValue: unknown = record.edits;

  if (typeof editsValue === "string") {
    try {
      const parsed: unknown = JSON.parse(editsValue);
      editsValue = Array.isArray(parsed) ? parsed : null;
    } catch {
      editsValue = null;
    }
  }

  const replacements: EditReplacement[] = [];
  if (Array.isArray(editsValue)) {
    for (const entry of editsValue) {
      const editRecord = toRecord(entry);
      if (typeof editRecord.oldText !== "string" || typeof editRecord.newText !== "string") {
        return { status: "not-pi-format" };
      }
      replacements.push({ oldText: editRecord.oldText, newText: editRecord.newText });
    }
  } else if (editsValue !== undefined && editsValue !== null) {
    return { status: "not-pi-format" };
  }

  if (typeof record.oldText === "string" && typeof record.newText === "string") {
    replacements.push({ oldText: record.oldText, newText: record.newText });
  }

  return replacements.length > 0
    ? { status: "parseable", replacements }
    : { status: "not-pi-format" };
}

export async function checkEditPreflight(input: unknown, cwd: string): Promise<EditPreflightResult> {
  const record = toRecord(input);
  const pathValue = getNonEmptyString(record.path) ?? getNonEmptyString(record.file_path);
  const extraction = extractEditReplacements(record);
  if (!pathValue || extraction.status === "not-pi-format") {
    return { feasible: true };
  }

  const replacements = extraction.replacements;

  const absolutePath = resolveEditPath(pathValue, cwd);

  // Mirrors edit.js: access(R_OK | W_OK) then readFile, with the same failure text.
  try {
    await access(absolutePath, constants.R_OK | constants.W_OK);
  } catch (error) {
    return {
      feasible: false,
      reason: `Blocked before execution: Could not edit file: ${pathValue}. ${formatFileError(error)}`,
    };
  }

  let rawContent: string;
  try {
    rawContent = await readFile(absolutePath, "utf-8");
  } catch (error) {
    return {
      feasible: false,
      reason: `Blocked before execution: Could not edit file: ${pathValue}. ${formatFileError(error)}`,
    };
  }

  // Mirrors edit.js: BOM is stripped before matching; the model never includes it.
  const content = rawContent.startsWith("\uFEFF") ? rawContent.slice(1) : rawContent;
  const lfContent = normalizeToLF(content);
  const fuzzyContent = normalizeForFuzzyMatch(lfContent);

  // Occurrence counts mirror edit-diff.js `countOccurrences`, which always
  // counts in fuzzy-normalized space. Pi fails an edit when its oldText has
  // zero occurrences (not found) or more than one (not unique).
  for (let i = 0; i < replacements.length; i++) {
    const oldLF = normalizeToLF(replacements[i].oldText);
    if (oldLF.length === 0) {
      const message = replacements.length === 1
        ? `oldText must not be empty in ${pathValue}.`
        : `edits[${i}].oldText must not be empty in ${pathValue}.`;
      return { feasible: false, reason: `Blocked before execution: ${message}` };
    }

    const fuzzyOld = normalizeForFuzzyMatch(oldLF);
    const occurrences = fuzzyContent.split(fuzzyOld).length - 1;
    if (occurrences === 0) {
      const message = replacements.length === 1
        ? `Could not find the exact text in ${pathValue}. The old text must match exactly including all whitespace and newlines.`
        : `Could not find edits[${i}] in ${pathValue}. The oldText must match exactly including all whitespace and newlines.`;
      return { feasible: false, reason: `Blocked before execution: ${message}` };
    }
    if (occurrences > 1) {
      const message = replacements.length === 1
        ? `Found ${occurrences} occurrences of the text in ${pathValue}. The text must be unique. Please provide more context to make it unique.`
        : `Found ${occurrences} occurrences of edits[${i}] in ${pathValue}. Each oldText must be unique. Please provide more context to make it unique.`;
      return { feasible: false, reason: `Blocked before execution: ${message}` };
    }
  }

  // Match spans mirror edit-diff.js `applyEditsToNormalizedContent`: when any
  // edit needs fuzzy matching, every match is located in the fuzzy base.
  const requiresFuzzyBase = replacements.some(({ oldText }) => {
    const oldLF = normalizeToLF(oldText);
    return oldLF.length > 0 && lfContent.indexOf(oldLF) === -1;
  });
  const matchBase = requiresFuzzyBase ? fuzzyContent : lfContent;

  const spans: Array<{ editIndex: number; start: number; end: number }> = [];
  for (let i = 0; i < replacements.length; i++) {
    const oldLF = normalizeToLF(replacements[i].oldText);
    const fuzzyOld = normalizeForFuzzyMatch(oldLF);
    const exactInBase = matchBase.indexOf(oldLF);
    const start = exactInBase !== -1 ? exactInBase : fuzzyContent.indexOf(fuzzyOld);
    const length = exactInBase !== -1 ? oldLF.length : fuzzyOld.length;
    spans.push({ editIndex: i, start, end: start + length });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1];
    const current = spans[i];
    if (previous.end > current.start) {
      return {
        feasible: false,
        reason: `Blocked before execution: edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${pathValue}. Merge them into one edit or target disjoint regions.`,
      };
    }
  }

  // Mirrors edit-diff.js no-change failure: compute the final content exactly
  // as Pi does (direct replacements on the LF base when every match is exact,
  // the line-preserving fuzzy overlay otherwise) and compare it with the base.
  // Per-edit oldText/newText equality is not enough: a fuzzy match such as
  // "foo \n" -> "foo\n" on a file that already contains "foo\n" reproduces
  // the same bytes even though oldText differs from newText.
  const matchedReplacements = spans.map((span) => ({
    start: span.start,
    length: span.end - span.start,
    newText: normalizeToLF(replacements[span.editIndex].newText),
  }));
  const finalContent = requiresFuzzyBase
    ? applyReplacementsPreservingUnchangedLines(lfContent, fuzzyContent, matchedReplacements)
    : applyReplacements(lfContent, matchedReplacements);
  if (finalContent === lfContent) {
    const message = replacements.length === 1
      ? `No changes made to ${pathValue}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
      : `No changes made to ${pathValue}. The replacements produced identical content.`;
    return { feasible: false, reason: `Blocked before execution: ${message}` };
  }

  return { feasible: true };
}

/** Mirrors edit-diff.js `splitLinesWithEndings`. */
function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Mirrors edit-diff.js `getLineSpans`. */
function getLineSpans(content: string): Array<{ start: number; end: number }> {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** Mirrors edit-diff.js `getReplacementLineRange`. */
function getReplacementLineRange(
  lines: Array<{ start: number; end: number }>,
  replacement: { start: number; length: number },
): { startLine: number; endLine: number } {
  const replacementStart = replacement.start;
  const replacementEnd = replacement.start + replacement.length;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

/** Mirrors edit-diff.js `applyReplacements`. */
function applyReplacements(
  content: string,
  replacements: Array<{ start: number; length: number; newText: string }>,
  offset = 0,
): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.start - offset;
    result = result.substring(0, matchIndex)
      + replacement.newText
      + result.substring(matchIndex + replacement.length);
  }
  return result;
}

/**
 * Mirrors edit-diff.js `applyReplacementsPreservingUnchangedLines`: rewrites
 * only the lines touched by replacements (from the fuzzy-normalized base) and
 * copies every other line back from the original so unchanged lines keep their
 * original bytes.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: Array<{ start: number; length: number; newText: string }>,
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: Array<{ start: number; length: number; newText: string }>;
  }> = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.start - b.start);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}
