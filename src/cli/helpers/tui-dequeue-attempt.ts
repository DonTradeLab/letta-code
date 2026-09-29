import type { TuiSubmitResult } from "@/cli/app/types";
import { buildQueueItemUserText } from "@/cli/helpers/queued-message-parts";
import { peekQueueBatch } from "@/cli/helpers/tui-queue-commit";
import type { QueueItem, QueueRuntime } from "@/queue/queue-runtime";

export type TuiDequeuePlan = {
  items: readonly QueueItem[];
  displayText: string;
};

export type TuiDequeueScopeMismatch = {
  itemAgentId?: string;
  itemConversationId?: string;
};

export function planTuiDequeue(
  queue: QueueRuntime,
  scope: { agentId: string; conversationId: string },
): TuiDequeuePlan | TuiDequeueScopeMismatch | null {
  const items = peekQueueBatch(queue);
  const first = items[0];
  if (!first) return null;
  if (
    (first.agentId !== undefined && first.agentId !== scope.agentId) ||
    (first.conversationId !== undefined &&
      first.conversationId !== scope.conversationId)
  ) {
    return {
      itemAgentId: first.agentId,
      itemConversationId: first.conversationId,
    };
  }
  return {
    items,
    displayText: items
      .map((item) => {
        if (
          item.kind === "task_notification" ||
          item.kind === "cron_prompt" ||
          item.kind === "mod_continue"
        ) {
          return item.text;
        }
        return item.kind === "message" ? buildQueueItemUserText([item]) : "";
      })
      .filter(Boolean)
      .join("\n"),
  };
}

export function shouldWakeTuiDequeue(
  result: TuiSubmitResult | null,
  ownerIdle: boolean,
): boolean {
  const refusal =
    result?.admission?.type === "not_admitted" ? result.admission.reason : null;
  return (
    result?.status === "admitted" ||
    refusal === "queue_changed" ||
    ((refusal === "busy" || refusal === "stale" || refusal === "cancelled") &&
      ownerIdle)
  );
}

export function enqueueRetainedTuiDraft(args: {
  queue: QueueRuntime | null;
  draft: string;
  clientMessageId: string;
  agentId: string;
  conversationId: string;
}): void {
  if (!args.draft) return;
  args.queue?.enqueue({
    kind: "message",
    source: "user",
    content: args.draft,
    clientMessageId: args.clientMessageId,
    agentId: args.agentId,
    conversationId: args.conversationId,
    paused: true,
  } as Parameters<QueueRuntime["enqueue"]>[0]);
}
