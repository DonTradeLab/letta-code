import { describe, expect, test } from "bun:test";
import { checkTuiAdmission } from "@/cli/helpers/tui-admission";
import {
  commitQueueItems,
  isQueueBatchCurrent,
  peekQueueBatch,
} from "@/cli/helpers/tui-queue-commit";
import { createTuiReminderTransaction } from "@/cli/helpers/tui-reminder-transaction";
import { QueueRuntime } from "@/queue/queue-runtime";
import { createSharedReminderState } from "@/reminders/state";

function queue(): QueueRuntime {
  return new QueueRuntime();
}

function enqueueMessage(
  runtime: QueueRuntime,
  text: string,
  scope: { agentId?: string; conversationId?: string } = {},
): void {
  runtime.enqueue({
    kind: "message",
    source: "user",
    content: text,
    ...scope,
  } as Parameters<QueueRuntime["enqueue"]>[0]);
}

describe("TUI admission gate", () => {
  test("refuses cancellation, staleness and busy ownership explicitly", () => {
    expect(
      checkTuiAdmission({
        processingConversation: 1,
        allowReentry: false,
        submissionGeneration: 1,
        currentGeneration: 2,
        userCancelled: true,
      }),
    ).toEqual({ type: "not_admitted", reason: "cancelled" });
    expect(
      checkTuiAdmission({
        processingConversation: 1,
        allowReentry: false,
        submissionGeneration: 1,
        currentGeneration: 2,
        userCancelled: false,
      }),
    ).toEqual({ type: "not_admitted", reason: "stale" });
    expect(
      checkTuiAdmission({
        processingConversation: 1,
        allowReentry: false,
        submissionGeneration: 2,
        currentGeneration: 2,
        userCancelled: false,
      }),
    ).toEqual({ type: "not_admitted", reason: "busy" });
    expect(
      checkTuiAdmission({
        processingConversation: 1,
        allowReentry: true,
        submissionGeneration: 2,
        currentGeneration: 2,
        userCancelled: false,
      }),
    ).toBeNull();
  });
});

describe("TUI queue admission commit", () => {
  test("commits the exact peeked prefix and leaves a later enqueue intact", () => {
    const runtime = queue();
    enqueueMessage(runtime, "first", {
      agentId: "agent",
      conversationId: "conversation",
    });
    const planned = peekQueueBatch(runtime);
    expect(planned).toHaveLength(1);

    enqueueMessage(runtime, "later", {
      agentId: "agent",
      conversationId: "conversation",
    });
    expect(isQueueBatchCurrent(runtime, planned)).toBe(true);
    expect(commitQueueItems(runtime, planned)).toBe(true);
    expect(runtime.length).toBe(1);
    expect(runtime.items[0]?.kind).toBe("message");
    expect(
      runtime.items[0]?.kind === "message" ? runtime.items[0].content : null,
    ).toBe("later");
  });

  test("refuses a changed prefix without consuming the remaining queue", () => {
    const runtime = queue();
    enqueueMessage(runtime, "first");
    enqueueMessage(runtime, "second");
    const planned = peekQueueBatch(runtime);
    expect(planned).toHaveLength(2);

    runtime.consumeItems(1);
    expect(isQueueBatchCurrent(runtime, planned)).toBe(false);
    expect(commitQueueItems(runtime, planned)).toBe(false);
    expect(runtime.length).toBe(1);
    expect(
      runtime.items[0]?.kind === "message" ? runtime.items[0].content : null,
    ).toBe("second");
  });

  test("coalescing stops at a scope boundary", () => {
    const runtime = queue();
    enqueueMessage(runtime, "old scope", {
      agentId: "agent",
      conversationId: "old",
    });
    enqueueMessage(runtime, "new scope", {
      agentId: "agent",
      conversationId: "new",
    });
    const planned = peekQueueBatch(runtime);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.conversationId).toBe("old");
  });
});

describe("TUI reminder preparation transaction", () => {
  test("consumes prepared reminders without erasing events that arrive during await", () => {
    const live = createSharedReminderState();
    const preparedReminder = { text: "prepared before await" };
    const arrivedDuringAwait = { text: "arrived during await" };
    live.pendingMemoryGitSyncReminders.push(preparedReminder);

    const transaction = createTuiReminderTransaction(live);
    transaction.state.pendingMemoryGitSyncReminders.splice(0);
    transaction.state.hasSentAgentInfo = true;

    live.pendingMemoryGitSyncReminders.push(arrivedDuringAwait);
    live.pendingSecretsInfoRefresh = true;
    transaction.commit();

    expect(live.pendingMemoryGitSyncReminders).toEqual([arrivedDuringAwait]);
    expect(live.hasSentAgentInfo).toBe(true);
    expect(live.pendingSecretsInfoRefresh).toBe(true);
  });
});
