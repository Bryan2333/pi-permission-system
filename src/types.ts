export type PermissionState = "allow" | "deny" | "ask";

export type BuiltInToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export type ToolPermissions = Record<string, PermissionState>;

export type BashPermissions = Record<string, PermissionState>;

export type SkillPermissions = Record<string, PermissionState>;

export type SpecialPermissionName = "doom_loop" | "external_directory";

export type SpecialPermissions = Record<string, PermissionState>;

export interface PermissionDefaultPolicy {
  tools: PermissionState;
  bash: PermissionState;
  mcp: PermissionState;
  skills: PermissionState;
  special: PermissionState;
}

export interface AgentPermissions {
  defaultPolicy?: Partial<PermissionDefaultPolicy>;
  tools?: ToolPermissions;
  bash?: BashPermissions;
  mcp?: ToolPermissions;
  skills?: SkillPermissions;
  special?: SpecialPermissions;
}

export interface GlobalPermissionConfig extends AgentPermissions {
  defaultPolicy: PermissionDefaultPolicy;
}

export type BashAnalysisStatus = "ok" | "unparseable" | "too_large" | "unavailable";

export interface BashCommandUnit {
  command: string;
  startIndex: number;
  endIndex: number;
  kind: "command" | "opaque";
}

export interface BashPermissionCheck extends BashCommandUnit {
  state: PermissionState;
  matchedPattern?: string;
}

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  command?: string;
  bashAnalysisStatus?: BashAnalysisStatus;
  bashChecks?: BashPermissionCheck[];
  target?: string;
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default";
}
