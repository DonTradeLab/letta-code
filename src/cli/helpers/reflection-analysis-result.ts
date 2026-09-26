import type { SubagentToolExecutionSummary } from "@/agent/subagents";

export type ReflectionAnalysisFailure = "infrastructure" | "all_tools_failed";

export function classifyUnresolvedReflectionAnalysisFailure(
  summary: SubagentToolExecutionSummary | undefined,
  worktreeState: { commitCount: number; dirty: boolean },
): ReflectionAnalysisFailure | undefined {
  if (!summary || worktreeState.commitCount > 0 || worktreeState.dirty) {
    return undefined;
  }
  if (summary.infrastructureFailed > 0) return "infrastructure";
  if (
    summary.attempted > 0 &&
    summary.succeeded === 0 &&
    summary.failed + summary.incomplete >= summary.attempted
  ) {
    return "all_tools_failed";
  }
  return undefined;
}
