import type { TuiTurnAdmission } from "@/cli/app/types";

/**
 * Shared admission gate. The loop's authoritative guard and the submit
 * handler's early pre-check must answer the same question with the same
 * precedence, so a submit that prepared state can predict — never decide —
 * whether processConversation will admit it.
 *
 * Precedence: cancellation before staleness, so Esc during preparation is
 * reported as cancelled while a conversation switch (generation-only) is
 * reported as stale. Busy comes last because it must not mask invalidation.
 * Returns null when the attempt may be admitted.
 */
export function checkTuiAdmission(args: {
  processingConversation: number;
  allowReentry: boolean;
  submissionGeneration: number;
  currentGeneration: number;
  userCancelled: boolean;
}): Extract<TuiTurnAdmission, { type: "not_admitted" }> | null {
  if (args.userCancelled) {
    return { type: "not_admitted", reason: "cancelled" };
  }
  if (args.submissionGeneration !== args.currentGeneration) {
    return { type: "not_admitted", reason: "stale" };
  }
  if (args.processingConversation > 0 && !args.allowReentry) {
    return { type: "not_admitted", reason: "busy" };
  }
  return null;
}
