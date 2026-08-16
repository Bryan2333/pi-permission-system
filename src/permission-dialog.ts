import { createCommandViewer, type PermissionViewerComponent, type PermissionViewerTheme, type PermissionViewerTui } from "./command-viewer.js";
import { getNonEmptyString } from "./common.js";

export type PermissionDecisionState = "approved" | "denied" | "denied_with_reason" | "once" | "always" | "reject";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
};

export interface PermissionDecisionUiSelectOptions {
  timeout?: number;
}

export interface PermissionDecisionUi {
  select(title: string, options: string[], optionsOverride?: PermissionDecisionUiSelectOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  /**
   * Optional custom overlay renderer (pi 0.75+). When present, the dialog
   * offers "View Full Command" to inspect the complete, uncompacted prompt.
   */
  custom?<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => PermissionViewerComponent | Promise<PermissionViewerComponent>,
    options?: unknown,
  ): Promise<T>;
}

export type PermissionDecisionRequestOptions = {
  timeoutMs?: number;
  timeoutDenialReason?: string;
};

const APPROVE_ONCE_OPTION = "Allow Once";
const APPROVE_ALWAYS_OPTION = "Allow Always";
const REJECT_OPTION = "Reject";
const REJECT_WITH_REASON_OPTION = "Reject with Reason";
const VIEW_FULL_COMMAND_OPTION = "View Full Command";
const PERMISSION_DECISION_OPTIONS = [
  APPROVE_ONCE_OPTION,
  APPROVE_ALWAYS_OPTION,
  REJECT_OPTION,
  REJECT_WITH_REASON_OPTION,
] as const;
const PERMISSION_DIALOG_MAX_VISIBLE_LINES = 18;
const PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS = 1_500;

function splitPromptLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

function shouldCompactPromptForSelect(value: string): boolean {
  return splitPromptLines(value).length > PERMISSION_DIALOG_MAX_VISIBLE_LINES
    || value.length > PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS;
}

function formatPromptCompactionNotice(
  omittedLines: number,
  omittedCharacters: number,
  hintViewFullCommand: boolean,
): string {
  const omittedParts = [
    omittedLines > 0 ? `${omittedLines} ${omittedLines === 1 ? "line" : "lines"}` : null,
    omittedCharacters > 0 ? `${omittedCharacters} ${omittedCharacters === 1 ? "character" : "characters"}` : null,
  ].filter((part): part is string => typeof part === "string");
  const omittedSummary = omittedParts.length > 0 ? omittedParts.join(" and ") : "content";
  return hintViewFullCommand
    ? `[Permission prompt compacted: omitted ${omittedSummary} to keep the permission dialog usable. Use "View Full Command" to inspect the full request.]`
    : `[Permission prompt compacted: omitted ${omittedSummary} to keep the permission dialog usable.]`;
}

function compactPermissionPromptForSelect(value: string, hintViewFullCommand: boolean): string {
  const lines = splitPromptLines(value);
  if (lines.length <= PERMISSION_DIALOG_MAX_VISIBLE_LINES && value.length <= PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS) {
    return value;
  }

  const maxPrefixLines = Math.max(1, PERMISSION_DIALOG_MAX_VISIBLE_LINES - 1);
  const prefixLines = lines.slice(0, maxPrefixLines);
  const omittedLines = Math.max(0, lines.length - prefixLines.length);
  let prefix = prefixLines.join("\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedCharacters = Math.max(0, value.length - prefix.length);
    const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters, hintViewFullCommand);
    const separatorLength = prefix.trimEnd() ? 1 : 0;
    const maxPrefixCharacters = Math.max(0, PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS - notice.length - separatorLength);

    if (prefix.length <= maxPrefixCharacters) {
      return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
    }

    prefix = prefix.slice(0, maxPrefixCharacters).trimEnd();
  }

  const omittedCharacters = Math.max(0, value.length - prefix.length);
  const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters, hintViewFullCommand);
  return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
}

export function normalizePermissionDenialReason(value: unknown): string | undefined {
  return getNonEmptyString(value) ?? undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): PermissionPromptDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
      approved: false,
      state: "denied_with_reason",
      denialReason: normalizedReason,
    }
    : {
      approved: false,
      state: "denied",
    };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return value === "approved"
    || value === "denied"
    || value === "denied_with_reason"
    || value === "once"
    || value === "always"
    || value === "reject";
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options: PermissionDecisionRequestOptions = {},
): Promise<PermissionPromptDecision> {
  const hasTimeout = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
  const startedAt = Date.now();
  // Remaining budget counts from the first select, so repeatedly opening the
  // viewer cannot extend the auto-deny deadline past the configured timeout.
  const getSelectOptions = (): { timeout: number } | undefined => {
    if (!hasTimeout) {
      return undefined;
    }
    const remaining = (options.timeoutMs as number) - (Date.now() - startedAt);
    return remaining > 0 ? { timeout: remaining } : undefined;
  };
  const timedOut = (): PermissionPromptDecision => options.timeoutDenialReason
    ? { approved: false, state: "reject", denialReason: options.timeoutDenialReason }
    : { approved: false, state: "reject" };

  const fullPrompt = `${title}\n${message}`;
  const hasViewer = typeof ui.custom === "function";
  // The viewer option only makes sense when the prompt was actually compacted;
  // short prompts are fully visible in the select dialog already.
  const showViewerOption = hasViewer && shouldCompactPromptForSelect(fullPrompt);
  const decisionOptions = showViewerOption
    ? [...PERMISSION_DECISION_OPTIONS, VIEW_FULL_COMMAND_OPTION]
    : [...PERMISSION_DECISION_OPTIONS];

  // Compaction can take a moment on huge prompts; snapshot the timeout after
  // it so a deadline crossed during compaction auto-denies instead of opening
  // an untimed select.
  const compactedPrompt = compactPermissionPromptForSelect(fullPrompt, showViewerOption);
  const selectOptions = getSelectOptions();
  if (hasTimeout && !selectOptions) {
    return timedOut();
  }
  let selected = await ui.select(
    compactedPrompt,
    decisionOptions,
    selectOptions,
  );

  while (selected === VIEW_FULL_COMMAND_OPTION) {
    await ui.custom?.(
      (tui, theme, _keybindings, done) =>
        createCommandViewer(
          fullPrompt,
          theme as PermissionViewerTheme,
          tui as PermissionViewerTui,
          () => done("closed"),
        ),
      {
        overlay: true,
        // The viewer sizes its own content window from the live terminal
        // height on every render; the overlay itself never clips (maxHeight
        // 100% is only a ceiling, not a target).
        overlayOptions: { width: "90%", maxHeight: "100%", anchor: "center" },
      },
    );
    const nextCompactedPrompt = compactPermissionPromptForSelect(fullPrompt, showViewerOption);
    const nextSelectOptions = getSelectOptions();
    if (hasTimeout && !nextSelectOptions) {
      return timedOut();
    }
    selected = await ui.select(
      nextCompactedPrompt,
      decisionOptions,
      nextSelectOptions,
    );
  }

  if (selected === APPROVE_ONCE_OPTION) {
    return {
      approved: true,
      state: "once",
    };
  }

  if (selected === APPROVE_ALWAYS_OPTION) {
    return {
      approved: true,
      state: "always",
    };
  }

  if (selected === REJECT_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );

    return denialReason
      ? { approved: false, state: "reject", denialReason }
      : { approved: false, state: "reject" };
  }

  return options.timeoutDenialReason
    ? { approved: false, state: "reject", denialReason: options.timeoutDenialReason }
    : { approved: false, state: "reject" };
}
