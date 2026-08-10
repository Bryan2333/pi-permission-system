import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";

export class SessionApprovalStore {
  private readonly rules: PatternPermissionRule[] = [];
  private readonly exactApprovals = new Set<string>();

  private exactApprovalKey(tool: string, subject: string): string {
    return JSON.stringify([tool.trim(), subject]);
  }

  approveExact(tool: string, subject: string): void {
    if (!tool.trim() || !subject) {
      return;
    }
    this.exactApprovals.add(this.exactApprovalKey(tool, subject));
  }

  hasExactApproval(tool: string, subject: string): boolean {
    return this.exactApprovals.has(this.exactApprovalKey(tool, subject));
  }

  approveAlways(tool: string, pattern: string): void {
    const normalizedTool = tool.trim();
    const normalizedPattern = pattern.trim();
    if (!normalizedTool || !normalizedPattern) {
      return;
    }

    this.rules.push({
      tool: normalizedTool,
      pattern: normalizedPattern,
      action: "allow",
    });
  }

  approveOnce(tool: string, pattern: string): void {
    this.approveAlways(tool, pattern);
  }

  hasSessionApproval(tool: string, command: string): boolean {
    return this.evaluate(tool, command).state === "allow";
  }

  evaluate(tool: string, command: string): { state: "allow" | "ask"; matchedPattern?: string } {
    const result = evaluatePermission(tool, command, this.rules);
    return result.action === "allow"
      ? { state: "allow", matchedPattern: result.matchedPattern }
      : { state: "ask" };
  }

  getRules(): PatternPermissionRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  clear(): void {
    this.rules.length = 0;
    this.exactApprovals.clear();
  }
}
