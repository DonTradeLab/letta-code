import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import {
  buildContentFromQueueItems,
  buildQueueItemUserText,
  getQueueItemNotificationSummaries,
} from "@/cli/helpers/queued-message-parts";
import {
  isCoalescable,
  type QueueItem,
  type QueueRuntime,
} from "@/queue/queue-runtime";

function hasSameScope(a: QueueItem, b: QueueItem): boolean {
  return (
    (a.agentId ?? null) === (b.agentId ?? null) &&
    (a.conversationId ?? null) === (b.conversationId ?? null)
  );
}

/**
 * Select the exact ready batch the native QueueRuntime policy would admit,
 * without removing it. Paused items stay parked; barriers are single-item;
 * coalescable items stop at the first barrier or scope boundary.
 */
export function peekQueueBatch(queue: QueueRuntime): readonly QueueItem[] {
  const ready = queue.peekReady();
  const first = ready[0];
  if (!first) {
    return [];
  }
  if (!isCoalescable(first.kind)) {
    return [first];
  }
  const batch: QueueItem[] = [];
  for (const item of ready) {
    if (!isCoalescable(item.kind) || !hasSameScope(first, item)) {
      break;
    }
    batch.push(item);
  }
  return batch;
}

/**
 * Commit the exact ready prefix that a dequeue plan peeked earlier.
 *
 * Peek→commit replaces consume-then-submit: an attempt that is refused
 * (busy, stale, cancelled, …) must leave its batch untouched in the queue,
 * with original ids, order, origin and attachments intact.
 *
 * The whole function is synchronous — there is no await between verifying
 * the prefix and removing it, so no interleaved enqueue/pause/consume can
 * change what is taken. Returns false (consuming nothing) when the ready
 * prefix no longer starts with the planned items: a batch that changed or
 * was partially consumed elsewhere is never half-committed.
 */
export function isQueueBatchCurrent(
  queue: QueueRuntime,
  planned: readonly QueueItem[],
): boolean {
  if (planned.length === 0) {
    return true;
  }
  const ready = queue.peekReady();
  if (ready.length < planned.length) {
    return false;
  }
  for (let i = 0; i < planned.length; i += 1) {
    if (ready[i]?.id !== planned[i]?.id) {
      return false;
    }
  }
  return true;
}

export function commitQueueItems(
  queue: QueueRuntime,
  planned: readonly QueueItem[],
): boolean {
  if (!isQueueBatchCurrent(queue, planned)) return false;
  if (planned.length === 0) return true;
  return queue.consumeItems(planned.length) !== null;
}

export type PreparedQueueContinuation = {
  items: readonly QueueItem[];
  content: MessageCreate["content"];
  userText: string;
  userOtid: string;
  notificationSummaries: string[];
};

export function prepareQueueContinuation(
  queue: QueueRuntime | null,
): PreparedQueueContinuation | null {
  if (!queue) return null;
  const items = peekQueueBatch(queue);
  if (!items.length) return null;
  return {
    items,
    content: buildContentFromQueueItems(items),
    userText: buildQueueItemUserText(items),
    userOtid: randomUUID(),
    notificationSummaries: getQueueItemNotificationSummaries(items),
  };
}

export function commitQueueContinuation(
  queue: QueueRuntime | null,
  prepared: PreparedQueueContinuation,
  onCommitted: (prepared: PreparedQueueContinuation) => void,
): boolean {
  if (!queue || !commitQueueItems(queue, prepared.items)) return false;
  onCommitted(prepared);
  return true;
}
