import type { Buffers } from "@/cli/helpers/accumulator";
import { flushEligibleLinesBeforeReentry } from "@/cli/helpers/subagent-turn-start";
import {
  commitQueueContinuation,
  type PreparedQueueContinuation,
} from "@/cli/helpers/tui-queue-commit";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { appendOptimisticUserLine } from "./ids";

export function commitApprovalContinuation(args: {
  queued: PreparedQueueContinuation | null;
  queue: QueueRuntime | null;
  buffers: Buffers;
  commitEligibleLines: (
    buffers: Buffers,
    options?: { deferToolCalls?: boolean },
  ) => void;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  setLastDequeuedMessage: (message: string) => void;
  refreshDerived: () => void;
  clearQueuedApprovalResults: () => void;
}): boolean {
  if (
    args.queued &&
    !commitQueueContinuation(args.queue, args.queued, (committed) => {
      args.appendTaskNotificationEvents(committed.notificationSummaries);
      appendOptimisticUserLine(
        args.buffers,
        committed.userText,
        committed.userOtid,
      );
      if (committed.userText) {
        args.setLastDequeuedMessage(committed.userText);
      }
      args.refreshDerived();
    })
  ) {
    return false;
  }
  flushEligibleLinesBeforeReentry(args.commitEligibleLines, args.buffers);
  args.clearQueuedApprovalResults();
  return true;
}
