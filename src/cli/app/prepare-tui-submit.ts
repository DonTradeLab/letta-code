import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  buildFreshDenialApprovals,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { isLocalMemfsActive } from "@/agent/memory-runtime";
import type { SessionStats } from "@/agent/stats";
import { getBackend } from "@/backend";
import { appendOptimisticUserLine, uid } from "@/cli/app/ids";
import type { Buffers } from "@/cli/helpers/accumulator";
import { toLines } from "@/cli/helpers/accumulator";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import { getRandomThinkingVerb } from "@/cli/helpers/thinking-messages";
import { runTuiAdmissionTestHook } from "@/cli/helpers/tui-admission-test-hooks";
import {
  commitQueueItems,
  isQueueBatchCurrent,
} from "@/cli/helpers/tui-queue-commit";
import { createTuiReminderTransaction } from "@/cli/helpers/tui-reminder-transaction";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { runUserPromptSubmitHooks } from "@/hooks";
import type { QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "@/reminders/engine";
import type { SharedReminderState } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";
import { detectShellContext } from "@/utils/shell-context";
import type { TuiAdmissionRefusalReason } from "./types";

export type QueuedApprovalInputPlan = {
  input: ApprovalCreate;
  isCurrent: () => boolean;
  commit: () => void;
};

type Ref<T> = { current: T };
type BashCommandCacheEntry = { input: string; output: string };
type PendingGitReminder = {
  dirty: boolean;
  aheadOfRemote: boolean;
  summary: string;
};

type PreparedSubmit = {
  input: Array<MessageCreate | ApprovalCreate>;
  admissionCommit?: () => boolean;
  transcriptStartLineIndex?: number | null;
  refusal?: TuiAdmissionRefusalReason;
};

function consumePreparedPrefix<T>(live: T[], prepared: readonly T[]): void {
  if (
    prepared.length > 0 &&
    prepared.every((entry, index) => live[index] === entry)
  ) {
    live.splice(0, prepared.length);
  }
}

export async function prepareTuiSubmit(args: {
  contentParts: MessageCreate["content"];
  queueItems: readonly QueueItem[];
  submissionGeneration: number;
  submissionConversationId: string;
  userPromptSubmitHookFeedback: string;
  isCommand: boolean;
  isSystemOnly: boolean;
  userTextForInput: string;
  flushPendingReasoningEffort: () => Promise<void>;
  agentId: string;
  agentName: string | null;
  agentDescription: string | null;
  agentLastRunAt: string | null;
  sessionStartFeedbackRef: Ref<string[]>;
  bashCommandCacheRef: Ref<BashCommandCacheEntry[]>;
  pendingGitReminderRef: Ref<PendingGitReminder | null>;
  pendingConversationSwitchRef: Ref<ConversationSwitchContext | null>;
  sharedReminderStateRef: Ref<SharedReminderState>;
  systemInfoReminderEnabled: boolean;
  buffersRef: Ref<Buffers>;
  refreshDerived: () => void;
  needsEagerApprovalCheck: boolean;
  peekQueuedApprovalInput: () => QueuedApprovalInputPlan | null;
  setNeedsEagerApprovalCheck: (value: boolean) => void;
  conversationGenerationRef: Ref<number>;
  conversationIdRef: Ref<string>;
  tuiQueueRef: Ref<QueueRuntime | null>;
  shouldAutoGenerateConversationTitleRef: Ref<boolean>;
  firstUserQueryRef: Ref<string | null>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  taskNotifications: string[];
  userOtid: string;
  sessionStatsRef: Ref<SessionStats>;
  trajectoryTokenDisplayRef: Ref<number>;
  setTrajectoryTokenBase: (value: number) => void;
  trajectoryRunTokenStartRef: Ref<number>;
  setThinkingMessage: (value: string) => void;
  lastDequeuedMessageRef: Ref<string | null>;
  displayMessage: string;
  onAdmitted?: () => void;
}): Promise<PreparedSubmit> {
  let promptHookFeedback = args.userPromptSubmitHookFeedback;
  if (!args.isCommand && !args.isSystemOnly) {
    await args.flushPendingReasoningEffort();
    const hook = await runUserPromptSubmitHooks(
      args.userTextForInput,
      false,
      args.agentId,
      args.submissionConversationId,
    );
    if (hook.blocked) {
      const id = uid("status");
      const feedback = hook.feedback.join("\n") || "Blocked by hook";
      args.buffersRef.current.byId.set(id, {
        kind: "status",
        id,
        lines: [
          `<user-prompt-submit-hook>${feedback}</user-prompt-submit-hook>`,
        ],
      });
      args.buffersRef.current.order.push(id);
      args.refreshDerived();
      return { input: [], refusal: "blocked" };
    }
    promptHookFeedback = hook.feedback.length
      ? `${SYSTEM_REMINDER_OPEN}\n${hook.feedback.join("\n")}\n${SYSTEM_REMINDER_CLOSE}`
      : "";
  }

  const sessionStartSnapshot = [...args.sessionStartFeedbackRef.current];
  const bashCommandSnapshot = [...args.bashCommandCacheRef.current];
  const gitStatusSnapshot = args.pendingGitReminderRef.current;
  const conversationSwitchSnapshot = args.pendingConversationSwitchRef.current;
  const reminderTransaction = createTuiReminderTransaction(
    args.sharedReminderStateRef.current,
  );
  await runTuiAdmissionTestHook("submit_prepare");

  const sessionStartHookFeedback = sessionStartSnapshot.length
    ? `${SYSTEM_REMINDER_OPEN}\n[SessionStart hook context]:\n${sessionStartSnapshot.join("\n")}\n${SYSTEM_REMINDER_CLOSE}\n\n`
    : "";
  let bashCommandPrefix = "";
  if (bashCommandSnapshot.length) {
    bashCommandPrefix = `${SYSTEM_REMINDER_OPEN}
The messages below were generated by the user while running local commands using "bash mode" in the Letta Code CLI tool.
DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.
${SYSTEM_REMINDER_CLOSE}
`;
    for (const cmd of bashCommandSnapshot) {
      bashCommandPrefix += `<bash-input>${cmd.input}</bash-input>\n<bash-output>${cmd.output}</bash-output>\n`;
    }
  }

  let memoryGitReminder = "";
  if (gitStatusSnapshot) {
    const memoryDir = getScopedMemoryFilesystemRoot(args.agentId);
    const localMemfs = isLocalMemfsActive();
    const syncInstructions = localMemfs
      ? `Commit memory changes locally when appropriate. Inspect with:\n\`\`\`bash\ngit -C ${JSON.stringify(memoryDir)} status\n\`\`\``
      : `Inspect and fix the memory repository when appropriate. Commit any intended memory changes locally; the harness pushes clean committed memory changes automatically after turns.\n\`\`\`bash\ngit -C ${JSON.stringify(memoryDir)} status\n\`\`\``;
    memoryGitReminder = `${SYSTEM_REMINDER_OPEN}
${localMemfs ? "MEMORY COMMIT" : "MEMORY SYNC"}: Your memory directory has uncommitted changes${localMemfs ? "." : " or is ahead of the remote."}

${gitStatusSnapshot.summary}

${syncInstructions}

You should do this soon to avoid losing memory updates. It only takes a few seconds.
${SYSTEM_REMINDER_CLOSE}
`;
  }

  const reminderParts: Array<{ type: "text"; text: string }> = [];
  const { getSkillSources } = await import("@/agent/context");
  const shared = await buildSharedReminderParts({
    mode: "interactive",
    agent: {
      id: args.agentId,
      name: args.agentName,
      description: args.agentDescription,
      lastRunAt: args.agentLastRunAt,
      conversationId: args.submissionConversationId,
    },
    state: reminderTransaction.state,
    conversationBootstrapContent: args.contentParts,
    systemInfoReminderEnabled: args.systemInfoReminderEnabled,
    skillSources: getSkillSources(),
    shellContext: detectShellContext(),
  });
  reminderParts.push(...shared.parts);

  let conversationSwitchAlert = "";
  if (
    conversationSwitchSnapshot &&
    settingsManager.getSetting("conversationSwitchAlertEnabled")
  ) {
    const { buildConversationSwitchAlert } = await import(
      "@/cli/helpers/conversation-switch-alert"
    );
    conversationSwitchAlert = buildConversationSwitchAlert(
      conversationSwitchSnapshot,
    );
  }
  for (const text of [
    sessionStartHookFeedback,
    conversationSwitchAlert,
    bashCommandPrefix,
    promptHookFeedback,
    memoryGitReminder,
  ]) {
    if (text) reminderParts.push({ type: "text", text });
  }
  const messageContent = prependReminderPartsToContent(
    args.contentParts,
    reminderParts,
  );

  let eagerRecoveryDenials: ApprovalResult[] | null = null;
  let eagerCheckCompleted = false;
  const approvalPlan = args.peekQueuedApprovalInput();
  if (args.needsEagerApprovalCheck && !approvalPlan) {
    try {
      const agent = await getBackend().retrieveAgent(args.agentId);
      const data = await getResumeDataFromBackend(
        agent,
        args.submissionConversationId,
      );
      if (data.pendingApprovals?.length) {
        eagerRecoveryDenials = buildFreshDenialApprovals(
          data.pendingApprovals,
          STALE_APPROVAL_RECOVERY_DENIAL_REASON,
        ) as ApprovalResult[];
      }
      eagerCheckCompleted = true;
    } catch {
      // Eager recovery is best-effort.
    }
  }

  const input: Array<MessageCreate | ApprovalCreate> = [];
  if (eagerRecoveryDenials?.length) {
    input.push({
      type: "approval",
      approvals: eagerRecoveryDenials,
      otid: crypto.randomUUID(),
    });
  }
  if (approvalPlan) input.push(approvalPlan.input);
  input.push({
    type: "message",
    role: "user",
    content: messageContent,
    otid: args.userOtid,
  });
  const transcriptStartLineIndex = args.userTextForInput
    ? toLines(args.buffersRef.current).length
    : null;

  return {
    input,
    transcriptStartLineIndex,
    admissionCommit: () => {
      if (
        args.conversationGenerationRef.current !== args.submissionGeneration ||
        args.conversationIdRef.current !== args.submissionConversationId
      ) {
        return false;
      }
      const queue = args.tuiQueueRef.current;
      if (
        args.queueItems.length &&
        (!queue || !isQueueBatchCurrent(queue, args.queueItems))
      ) {
        return false;
      }
      if (approvalPlan && !approvalPlan.isCurrent()) return false;
      if (
        args.queueItems.length &&
        queue &&
        !commitQueueItems(queue, args.queueItems)
      ) {
        return false;
      }

      approvalPlan?.commit();
      reminderTransaction.commit();
      consumePreparedPrefix(
        args.sessionStartFeedbackRef.current,
        sessionStartSnapshot,
      );
      consumePreparedPrefix(
        args.bashCommandCacheRef.current,
        bashCommandSnapshot,
      );
      if (args.pendingGitReminderRef.current === gitStatusSnapshot) {
        args.pendingGitReminderRef.current = null;
      }
      if (
        args.pendingConversationSwitchRef.current === conversationSwitchSnapshot
      ) {
        args.pendingConversationSwitchRef.current = null;
      }
      if (eagerCheckCompleted) args.setNeedsEagerApprovalCheck(false);
      if (
        args.shouldAutoGenerateConversationTitleRef.current &&
        args.firstUserQueryRef.current === null &&
        !args.isSystemOnly &&
        args.userTextForInput &&
        !args.userTextForInput.startsWith("/")
      ) {
        args.firstUserQueryRef.current = args.userTextForInput
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
      }

      args.appendTaskNotificationEvents(args.taskNotifications);
      appendOptimisticUserLine(
        args.buffersRef.current,
        args.userTextForInput,
        args.userOtid,
      );
      args.buffersRef.current.tokenCount = 0;
      args.buffersRef.current.interrupted = false;
      if (!args.sessionStatsRef.current.getTrajectorySnapshot()) {
        args.trajectoryTokenDisplayRef.current = 0;
        args.setTrajectoryTokenBase(0);
        args.trajectoryRunTokenStartRef.current = 0;
      }
      args.setThinkingMessage(getRandomThinkingVerb());
      if (args.queueItems.length) {
        args.lastDequeuedMessageRef.current = args.displayMessage;
      }
      args.onAdmitted?.();
      args.refreshDerived();
      return true;
    },
  };
}
