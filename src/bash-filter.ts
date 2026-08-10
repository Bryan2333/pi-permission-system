import { evaluateShellCommandPermissions } from "./shell-command-analyzer.js";
import type {
  BashAnalysisStatus,
  BashPermissionCheck as BashUnitPermissionCheck,
  BashPermissions,
  PermissionState,
} from "./types.js";
import {
  compileWildcardPatterns,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

type CompiledPattern = CompiledWildcardPattern<PermissionState>;

type BashPermissionSource = BashPermissions | readonly CompiledPattern[];

function isCompiledPatternList(value: BashPermissionSource): value is readonly CompiledPattern[] {
  return Array.isArray(value);
}

export interface BashPermissionCheck {
  state: PermissionState;
  matchedPattern?: string;
  command: string;
  bashAnalysisStatus: BashAnalysisStatus;
  bashChecks: BashUnitPermissionCheck[];
}

export class BashFilter {
  private readonly compiledPatterns: CompiledPattern[];

  constructor(
    permissions: BashPermissionSource,
    private readonly defaultState: PermissionState,
  ) {
    this.compiledPatterns = isCompiledPatternList(permissions)
      ? [...permissions]
      : compileWildcardPatterns(permissions);
  }

  check(command: string): BashPermissionCheck {
    const evaluation = evaluateShellCommandPermissions(
      command,
      this.defaultState,
      (unit) => findCompiledWildcardMatch(this.compiledPatterns, unit),
    );

    return {
      state: evaluation.state,
      matchedPattern: evaluation.matchedPattern,
      command,
      bashAnalysisStatus: evaluation.analysisStatus,
      bashChecks: evaluation.checks,
    };
  }
}
