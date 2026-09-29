// src/cli/app/useConversationLoop.ts

import { randomUUID } from "node:crypto";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import { executeAutoAllowedTools } from "@/agent/approval-execution";
import {
  extractConflictDetail,
  fetchRunErrorInfo,
  getPreStreamErrorAction,
  getRetryDelayMs,
  isApprovalPendingError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  isQuotaLimitErrorDetail,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  refreshInputOtidsForNewRequest,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
} from "@/agent/approval-recovery";
import { getAvailableModelHandles } from "@/agent/available-models";
import {
  CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
  formatPlanRotationNotice,
  rotateChatGPTPlanOnQuotaLimit,
} from "@/agent/chatgpt-plan-rotation";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getStreamToolContextId, sendMessageStream } from "@/agent/message";
import { getModelInfoForLlmConfig } from "@/agent/model";
import { INTERRUPT_RECOVERY_ALERT } from "@/agent/prompt-assets";
import type { SessionStats } from "@/agent/stats";
import {
  clearCompletedSubagents,
  hasActiveSubagents,
} from "@/agent/subagent-state";
import { type ConversationMessageStreamBody, getBackend } from "@/backend";
import {
  type Buffers,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  setToolCallsRunning,
  toLines,
} from "@/cli/helpers/accumulator";
import { classifyApprovals } from "@/cli/helpers/approval-classification";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import {
  formatErrorDetails,
  formatTelemetryErrorMessage,
  getRetryStatusMessage,
  isEncryptedContentError,
  isProviderStreamDisconnectErrorText,
} from "@/cli/helpers/error-formatter";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import {
  buildLocalNoModelResponse,
  splitSyntheticAssistantResponse,
} from "@/cli/helpers/local-no-model-response";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import {
  type ApprovalRequest,
  type DrainResult,
  drainStream,
  drainStreamWithResume,
} from "@/cli/helpers/stream";
import { shouldClearCompletedSubagentsOnTurnStart } from "@/cli/helpers/subagent-turn-start";
import {
  getRandomPastTenseVerb,
  getRandomThinkingVerb,
} from "@/cli/helpers/thinking-messages";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "@/cli/helpers/tool-name-mapping";
import { alwaysRequiresUserInput } from "@/cli/helpers/tool-name-mapping.js";
import { checkTuiAdmission } from "@/cli/helpers/tui-admission";
import {
  commitQueueContinuation,
  prepareQueueContinuation,
} from "@/cli/helpers/tui-queue-commit";
import { finishTuiTurn } from "@/cli/helpers/tui-turn-lifecycle";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { runStopHooks } from "@/hooks";
import type { ApprovalContext } from "@/permissions/analyzer";
import { formatPermissionDenial } from "@/permissions/format-denial";
import type { PermissionMode } from "@/permissions/mode";
import { permissionMode } from "@/permissions/mode";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { analyzeToolApproval, type ToolExecutionResult } from "@/tools/manager";
import type { PreparedScopeToolContext } from "@/tools/toolset";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

import {
  CONVERSATION_BUSY_MAX_RETRIES,
  EAGER_CANCEL,
  EMPTY_RESPONSE_MAX_RETRIES,
  ERROR_FEEDBACK_HINT,
  INTERRUPT_MESSAGE,
  LLM_API_ERROR_MAX_RETRIES,
  TEMP_QUOTA_OVERRIDE_MODEL,
} from "./constants";
import {
  reportAdmittedRunError,
  reportConversationPreparationError,
  reportPostAdmissionSetupError,
} from "./conversation-error-reporting";
import { appendOptimisticUserLine, createClientOtid, uid } from "./ids";
import {
  getErrorHintForStopReason,
  getPreferredAgentModelHandle,
} from "./model-config";
import { sendDesktopNotification } from "./notifications";
import {
  prepareConversationAdmission,
  promoteReadyServerToolCalls,
} from "./prepare-conversation-admission";
import { isRetriableError } from "./retry";
import { stripSystemReminders } from "./system-reminders";
import type {
  AppendError,
  ApprovalDecision,
  AutoAllowedExecution,
  AutoDeniedApproval,
  AutoHandledToolResult,
  ProcessConversationOptions,
  QueueApprovalResults,
  TuiTurnAdmission,
  TuiTurnOutcome,
} from "./types";

type NetworkPhase = "error" | "upload" | "download" | null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function continuationOutcome(result: TuiTurnAdmission): TuiTurnOutcome {
  if (result.type === "admitted") return result.outcome;
  return result.reason === "stale" || result.reason === "cancelled"
    ? "interrupted"
    : "error";
}

function makeExecutionPhaseHook(
  setExecutionPhase: Dispatch<SetStateAction<ExecutionPhase>>,
) {
  return ({ chunk }: { chunk: { message_type?: string } }) => {
    const t = chunk?.message_type;
    if (t === "reasoning_message") setExecutionPhase("thinking");
    else if (t === "tool_call_message" || t === "approval_request_message")
      setExecutionPhase("toolUse");
    else if (t === "assistant_message") setExecutionPhase("responding");
    return undefined;
  };
}

type ConversationLoopContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentIdRef: MutableRefObject<string>;
  appendError: AppendError;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  approvalToolContextIdRef: MutableRefObject<string | null>;
  autoAllowedExecutionRef: MutableRefObject<AutoAllowedExecution | null>;
  buffersRef: MutableRefObject<Buffers>;
  clearApprovalToolContext: () => void;
  closeTrajectorySegment: () => void;
  queueModeRef: MutableRefObject<"immediate" | "defer">;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  chatgptPlanSwapsRef: MutableRefObject<number>;
  chatgptExhaustedProvidersRef: MutableRefObject<Set<string>>;
  conversationBusyRetriesRef: MutableRefObject<number>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  currentModelId: string | null;
  emptyResponseRetriesRef: MutableRefObject<number>;
  executingToolCallIdsRef: MutableRefObject<string[]>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  modAdapter: LocalModAdapter;
  generateConversationTitle: () => Promise<string | null>;
  hasConversationModelOverrideRef: MutableRefObject<boolean>;
  interruptQueuedRef: MutableRefObject<boolean>;
  isAutoConversationTitleInFlightRef: MutableRefObject<boolean>;
  lastDequeuedMessageRef: MutableRefObject<string | null>;
  lastRunIdRef: MutableRefObject<string | null>;
  lastSentInputRef: MutableRefObject<Array<
    MessageCreate | ApprovalCreate
  > | null>;
  llmApiErrorRetriesRef: MutableRefObject<number>;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  maybeRunPostTurnReflection: () => Promise<void>;
  needsEagerApprovalCheck: boolean;
  openTrajectorySegment: () => void;
  pendingInterruptRecoveryConversationIdRef: MutableRefObject<string | null>;
  pendingTranscriptStartLineIndexRef: MutableRefObject<number | null>;
  precomputedDiffsRef: MutableRefObject<Map<string, AdvancedDiffSuccess>>;
  prepareScopedToolExecutionContext: (
    overrideModel?: string | null,
  ) => Promise<PreparedScopeToolContext>;
  processingConversationRef: MutableRefObject<number>;
  queueApprovalResults: QueueApprovalResults;
  queueSnapshotRef: MutableRefObject<QueuedMessage[]>;
  quotaAutoSwapAttemptedRef: MutableRefObject<boolean>;
  refreshDerived: () => void;
  refreshDerivedThrottled: () => void;
  resetTrajectoryBases: () => void;
  restoreQueueOnCancelRef: MutableRefObject<boolean>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  setAgentDescription: Dispatch<SetStateAction<string | null>>;
  setAgentLastRunAt: Dispatch<SetStateAction<string | null>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setApprovalContexts: Dispatch<SetStateAction<ApprovalContext[]>>;
  setApprovalResults: Dispatch<SetStateAction<ApprovalDecision[]>>;
  setAutoDeniedApprovals: Dispatch<SetStateAction<AutoDeniedApproval[]>>;
  setAutoHandledResults: Dispatch<SetStateAction<AutoHandledToolResult[]>>;
  setCurrentModelHandle: Dispatch<SetStateAction<string | null>>;
  setCurrentModelId: Dispatch<SetStateAction<string | null>>;
  setDequeueEpoch: Dispatch<SetStateAction<number>>;
  setInterruptRequested: Dispatch<SetStateAction<boolean>>;
  lastStopReasonRef: MutableRefObject<string | null>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  setNeedsEagerApprovalCheck: Dispatch<SetStateAction<boolean>>;
  setNetworkPhase: Dispatch<SetStateAction<NetworkPhase>>;
  setExecutionPhase: Dispatch<SetStateAction<ExecutionPhase>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setRestoreQueueOnCancel: Dispatch<SetStateAction<boolean>>;
  setRestoredInput: Dispatch<SetStateAction<string | null>>;
  setAdmissionPreparing: Dispatch<SetStateAction<boolean>>;
  setStreaming: (value: boolean) => void;
  setConversationSummary: (summary: string | null) => void;
  setTempModelOverride: (next: string | null) => void;
  setThinkingMessage: Dispatch<SetStateAction<string>>;
  setTrajectoryElapsedBaseMs: Dispatch<SetStateAction<number>>;
  setTrajectoryTokenBase: Dispatch<SetStateAction<number>>;
  setUiPermissionMode: (mode: PermissionMode) => void;
  shouldAutoGenerateConversationTitleRef: MutableRefObject<boolean>;
  syncTrajectoryElapsedBase: () => void;
  syncTrajectoryTokenBase: () => void;
  tempModelOverrideRef: MutableRefObject<string | null>;
  toolAbortControllerRef: MutableRefObject<AbortController | null>;
  toolResultsInFlightRef: MutableRefObject<boolean>;
  trajectoryRunTokenStartRef: MutableRefObject<number>;
  trajectorySegmentStartRef: MutableRefObject<number | null>;
  trajectoryTokenDisplayRef: MutableRefObject<number>;
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
  uiPermissionModeRef: MutableRefObject<PermissionMode>;
  updateStreamingOutput: (
    toolCallId: string,
    chunk: string,
    isStderr?: boolean,
  ) => void;
  userCancelledRef: MutableRefObject<boolean>;
  waitingForQueueCancelRef: MutableRefObject<boolean>;
};

export function useConversationLoop(ctx: ConversationLoopContext) {
  const {
    abortControllerRef,
    agentIdRef,
    appendError,
    appendTaskNotificationEvents,
    approvalToolContextIdRef,
    autoAllowedExecutionRef,
    buffersRef,
    clearApprovalToolContext,
    closeTrajectorySegment,
    chatgptPlanSwapsRef,
    chatgptExhaustedProvidersRef,
    queueModeRef,
    contextTrackerRef,
    conversationBusyRetriesRef,
    conversationGenerationRef,
    conversationIdRef,
    currentModelId,
    emptyResponseRetriesRef,
    executingToolCallIdsRef,
    generateConversationDescription,
    modAdapter,
    generateConversationTitle,
    hasConversationModelOverrideRef,
    interruptQueuedRef,
    isAutoConversationTitleInFlightRef,
    lastDequeuedMessageRef,
    lastRunIdRef,
    lastSentInputRef,
    llmApiErrorRetriesRef,
    llmConfigRef,
    maybeRunPostTurnReflection,
    needsEagerApprovalCheck,
    openTrajectorySegment,
    pendingInterruptRecoveryConversationIdRef,
    pendingTranscriptStartLineIndexRef,
    precomputedDiffsRef,
    prepareScopedToolExecutionContext,
    processingConversationRef,
    queueApprovalResults,
    queueSnapshotRef,
    quotaAutoSwapAttemptedRef,
    refreshDerived,
    refreshDerivedThrottled,
    resetTrajectoryBases,
    restoreQueueOnCancelRef,
    sessionStatsRef,
    setAgentDescription,
    setAgentLastRunAt,
    setAgentState,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setCurrentModelHandle,
    setCurrentModelId,
    setDequeueEpoch,
    setInterruptRequested,
    lastStopReasonRef,
    setIsExecutingTool,
    setLlmConfig,
    setNeedsEagerApprovalCheck,
    setNetworkPhase,
    setExecutionPhase,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setRestoredInput,
    setAdmissionPreparing,
    setStreaming,
    setConversationSummary,
    setTempModelOverride,
    setThinkingMessage,
    setTrajectoryElapsedBaseMs,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    shouldAutoGenerateConversationTitleRef,
    syncTrajectoryElapsedBase,
    syncTrajectoryTokenBase,
    tempModelOverrideRef,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    trajectoryRunTokenStartRef,
    trajectorySegmentStartRef,
    trajectoryTokenDisplayRef,
    tuiQueueRef,
    uiPermissionModeRef,
    updateStreamingOutput,
    userCancelledRef,
    waitingForQueueCancelRef,
  } = ctx;

  const maybeStreamSyntheticNoModelResponse = useCallback(
    async (
      currentInput: Array<MessageCreate | ApprovalCreate>,
      allowReentry: boolean,
      hasApprovalInput: boolean,
    ): Promise<boolean> => {
      const backend = getBackend();
      if (
        !backend.capabilities.localModelCatalog ||
        allowReentry ||
        hasApprovalInput
      ) {
        return false;
      }

      const hasUserMessage = currentInput.some(
        (item) => item.type === "message" && item.role === "user",
      );
      if (!hasUserMessage) {
        return false;
      }

      const availableModels = await getAvailableModelHandles({
        forceRefresh: true,
      });
      if (availableModels.handles.size > 0) {
        return false;
      }

      const currentSettings =
        await settingsManager.getSettingsWithSecureTokens();
      const hasCloudAuth = Boolean(
        process.env.LETTA_API_KEY ||
          currentSettings.refreshToken ||
          currentSettings.env?.LETTA_API_KEY,
      );

      setThinkingMessage(getRandomThinkingVerb());
      await sleep(250);

      const lineId = uid("assistant");
      buffersRef.current.byId.set(lineId, {
        kind: "assistant",
        id: lineId,
        text: "",
        phase: "streaming",
      });
      buffersRef.current.order.push(lineId);
      refreshDerived();

      const chunks = splitSyntheticAssistantResponse(
        buildLocalNoModelResponse(hasCloudAuth),
      );
      for (const chunk of chunks) {
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const currentLine = buffersRef.current.byId.get(lineId);
        if (!currentLine || currentLine.kind !== "assistant") {
          break;
        }

        buffersRef.current.byId.set(lineId, {
          ...currentLine,
          text: currentLine.text + chunk,
        });
        buffersRef.current.tokenCount += Buffer.byteLength(chunk, "utf8");
        refreshDerived();
        await sleep(chunk === "\n" ? 70 : 120);
      }

      const finalLine = buffersRef.current.byId.get(lineId);
      if (finalLine && finalLine.kind === "assistant") {
        buffersRef.current.byId.set(lineId, {
          ...finalLine,
          phase: "finished",
        });
      }
      setNetworkPhase(null);
      setExecutionPhase(null);
      setStreaming(false);
      refreshDerived();
      return true;
    },
    [
      abortControllerRef,
      buffersRef,
      refreshDerived,
      setNetworkPhase,
      setExecutionPhase,
      setStreaming,
      setThinkingMessage,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: blanket suppression — this callback has ~16 omitted deps (refs, stable functions, etc.). Refs are safe (read .current dynamically), but the blanket ignore also hides any genuinely missing reactive deps. If stale-closure bugs appear in processConversation, audit the dep array here first.
  const processConversation = useCallback(
    async (
      initialInput: Array<MessageCreate | ApprovalCreate>,
      options?: ProcessConversationOptions,
    ): Promise<TuiTurnAdmission> => {
      const allowReentry = options?.allowReentry ?? false;
      const myGeneration =
        options?.submissionGeneration ?? conversationGenerationRef.current;

      if (
        options?.submissionConversationId !== undefined &&
        options.submissionConversationId !== conversationIdRef.current
      ) {
        return { type: "not_admitted", reason: "stale" };
      }
      const preGate = checkTuiAdmission({
        processingConversation: processingConversationRef.current,
        allowReentry,
        submissionGeneration: myGeneration,
        currentGeneration: conversationGenerationRef.current,
        userCancelled: userCancelledRef.current,
      });
      if (preGate) {
        debugLog(
          "queue",
          `processConversation refused before reservation: ${preGate.reason}`,
        );
        return preGate;
      }

      const pinnedPermissionMode = uiPermissionModeRef.current;
      const restorePinnedPermissionMode = () => {
        if (permissionMode.getMode() !== pinnedPermissionMode) {
          permissionMode.setMode(pinnedPermissionMode);
        }
        if (uiPermissionModeRef.current !== pinnedPermissionMode) {
          setUiPermissionMode(pinnedPermissionMode);
        }
      };

      processingConversationRef.current += 1;
      let admitted = false;
      let outcome: TuiTurnOutcome = "completed";
      let wakeAfterFinish = true;
      let currentInput: Array<MessageCreate | ApprovalCreate> = [];
      let hasApprovalInput = false;
      let transcriptTurnStartLineIndex: number | null = null;
      let requestedTranscriptStartLineIndex = options?.transcriptStartLineIndex;
      let currentRunId: string | undefined;
      let preserveTranscriptStartForApproval = false;
      let turnAbortController: AbortController | null = null;

      try {
        turnAbortController = new AbortController();
        abortControllerRef.current = turnAbortController;
        setAdmissionPreparing(true);

        const preparation = await prepareConversationAdmission({
          initialInput,
          options,
          myGeneration,
          turnAbortController,
          conversationGenerationRef,
          conversationIdRef,
          userCancelledRef,
          agentIdRef,
          modAdapter,
          buffersRef,
          refreshDerived,
        });
        if (!preparation.admitted) {
          if (preparation.suppressWake) wakeAfterFinish = false;
          return preparation.result;
        }
        currentInput = preparation.input;
        requestedTranscriptStartLineIndex =
          preparation.transcriptStartLineIndex;
        admitted = true;
        setAdmissionPreparing(false);

        buffersRef.current.approvalsPending = false;
        if (promoteReadyServerToolCalls(buffersRef.current)) {
          refreshDerived();
        }

        hasApprovalInput = currentInput.some(
          (item) => item.type === "approval",
        );
        const hasExplicitTranscriptStart =
          requestedTranscriptStartLineIndex !== undefined;
        if (requestedTranscriptStartLineIndex !== undefined) {
          pendingTranscriptStartLineIndexRef.current =
            requestedTranscriptStartLineIndex;
        } else if (!hasApprovalInput) {
          pendingTranscriptStartLineIndexRef.current = null;
        }
        transcriptTurnStartLineIndex =
          hasExplicitTranscriptStart || hasApprovalInput
            ? pendingTranscriptStartLineIndexRef.current
            : null;

        if (!allowReentry) {
          llmApiErrorRetriesRef.current = 0;
          emptyResponseRetriesRef.current = 0;
          conversationBusyRetriesRef.current = 0;
          quotaAutoSwapAttemptedRef.current = false;
          chatgptPlanSwapsRef.current = 0;
          chatgptExhaustedProvidersRef.current.clear();
        }

        setStreaming(true);
        openTrajectorySegment();
        setNetworkPhase("upload");
        setExecutionPhase("requesting");
        const activeTurnAbortController = turnAbortController;

        const runAdmittedTurn = async (): Promise<void> => {
          try {
            if (
              await maybeStreamSyntheticNoModelResponse(
                currentInput,
                allowReentry,
                hasApprovalInput,
              )
            ) {
              return;
            }

            // Recover interrupted message only after explicit user interrupt:
            // if cache contains ONLY user messages, prepend them.
            // Note: type="message" is a local discriminator (not in SDK types) to distinguish from approvals
            const originalInput = currentInput;
            const cacheIsAllUserMsgs = lastSentInputRef.current?.every(
              (m: MessageCreate | ApprovalCreate) =>
                m.type === "message" && m.role === "user",
            );
            const canInjectInterruptRecovery =
              pendingInterruptRecoveryConversationIdRef.current !== null &&
              pendingInterruptRecoveryConversationIdRef.current ===
                conversationIdRef.current;
            if (
              cacheIsAllUserMsgs &&
              lastSentInputRef.current &&
              canInjectInterruptRecovery
            ) {
              currentInput = [
                // Refresh OTIDs — this is a new request, not a retry of the interrupted one
                ...lastSentInputRef.current.map(
                  (m: MessageCreate | ApprovalCreate) => ({
                    ...m,
                    otid: randomUUID(),
                  }),
                ),
                ...currentInput.map((m) =>
                  m.type === "message" && m.role === "user"
                    ? {
                        ...m,
                        otid: randomUUID(),
                        content: [
                          {
                            type: "text" as const,
                            text: INTERRUPT_RECOVERY_ALERT,
                          },
                          ...(typeof m.content === "string"
                            ? [{ type: "text" as const, text: m.content }]
                            : Array.isArray(m.content)
                              ? m.content
                              : []),
                        ],
                      }
                    : { ...m, otid: randomUUID() },
                ),
              ];
              pendingInterruptRecoveryConversationIdRef.current = null;
              // Cache old + new for chained recovery
              lastSentInputRef.current = [
                ...lastSentInputRef.current,
                ...originalInput,
              ];
            } else {
              pendingInterruptRecoveryConversationIdRef.current = null;
              lastSentInputRef.current = originalInput;
            }

            // Clear any stale pending tool calls from previous turns
            // If we're sending a new message, old pending state is no longer relevant
            // Pass false to avoid setting interrupted=true, which causes race conditions
            // with concurrent processConversation calls reading the flag
            // IMPORTANT: Skip this when allowReentry=true (continuing after tool execution)
            // because server-side tools (like memory) may still be pending and their results
            // will arrive in this stream. Cancelling them prematurely shows "Cancelled" in UI.
            if (!allowReentry) {
              markIncompleteToolsAsCancelled(
                buffersRef.current,
                false,
                "internal_cancel",
              );
            }
            // Reset interrupted flag since we're starting a fresh stream
            buffersRef.current.interrupted = false;

            // Clear completed subagents only on true new turns.
            if (
              shouldClearCompletedSubagentsOnTurnStart(
                allowReentry,
                hasActiveSubagents(),
              )
            ) {
              clearCompletedSubagents();
            }

            let highestSeqIdSeen: number | null = null;

            while (true) {
              // Capture the signal BEFORE any async operations
              // This prevents a race where handleInterrupt nulls the ref during await
              const signal = abortControllerRef.current?.signal;

              // Check if cancelled before starting new stream
              if (signal?.aborted) {
                const isStaleAtAbort =
                  myGeneration !== conversationGenerationRef.current;
                // Only set streaming=false if this is the current generation.
                // If stale, a newer processConversation might be running and we shouldn't affect its UI.
                if (!isStaleAtAbort) {
                  setStreaming(false);
                }
                outcome = "interrupted";
                return;
              }

              // Inject queued skill content as user message parts (LET-7353)
              // This centralizes skill content injection so all approval-send paths
              // automatically get skill SKILL.md content alongside tool results.
              const { consumeQueuedSkillContent } = await import(
                "@/tools/impl/skill-content-registry"
              );
              const skillContents = consumeQueuedSkillContent();
              if (skillContents.length > 0) {
                currentInput = [
                  ...currentInput,
                  {
                    role: "user",
                    content: skillContents.map((sc) => ({
                      type: "text" as const,
                      text: sc.content,
                    })),
                    otid: randomUUID(),
                  },
                ];
              }

              // Stream one turn - use ref to always get the latest conversationId
              // Wrap in try-catch to handle pre-stream desync errors (when sendMessageStream
              // throws before streaming begins, e.g., retry after LLM error when backend
              // already cleared the approval)
              let stream: Awaited<ReturnType<typeof sendMessageStream>> | null =
                null;
              let turnToolContextId: string | null = null;
              let preStreamResumeResult: DrainResult | null = null;
              let prefetchedAgent: AgentState | null = null;
              try {
                const preparedToolContext =
                  await prepareScopedToolExecutionContext(
                    tempModelOverrideRef.current ?? undefined,
                  );
                prefetchedAgent = preparedToolContext.agent;
                const nextStream = await sendMessageStream(
                  conversationIdRef.current,
                  currentInput,
                  {
                    agentId: agentIdRef.current,
                    overrideModel: tempModelOverrideRef.current ?? undefined,
                    preparedToolContext:
                      preparedToolContext.preparedToolContext,
                    allowResponseStateReuse:
                      options?.allowResponseStateReuse === true,
                  },
                );
                stream = nextStream;
                turnToolContextId = getStreamToolContextId(nextStream);
              } catch (preStreamError) {
                debugLog(
                  "stream",
                  "Pre-stream error: %s (status=%s)",
                  preStreamError instanceof Error
                    ? preStreamError.message
                    : String(preStreamError),
                  preStreamError instanceof APIError
                    ? preStreamError.status
                    : "none",
                );

                // Extract error detail using shared helper (handles nested/direct/message shapes)
                const errorDetail = extractConflictDetail(preStreamError);

                // Route through shared pre-stream conflict classifier (parity with headless.ts)
                const preStreamAction = getPreStreamErrorAction(
                  errorDetail,
                  conversationBusyRetriesRef.current,
                  CONVERSATION_BUSY_MAX_RETRIES,
                  {
                    status:
                      preStreamError instanceof APIError
                        ? preStreamError.status
                        : undefined,
                    transientRetries: llmApiErrorRetriesRef.current,
                    maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
                  },
                );

                // Resolve stale approval conflict: fetch real pending approvals, auto-deny, retry.
                // Shares llmApiErrorRetriesRef budget with LLM transient-error retries (max 3 per turn).
                // Resets on each processConversation entry and on success.
                if (
                  shouldAttemptApprovalRecovery({
                    approvalPendingDetected:
                      preStreamAction === "resolve_approval_pending",
                    retries: llmApiErrorRetriesRef.current,
                    maxRetries: LLM_API_ERROR_MAX_RETRIES,
                  })
                ) {
                  llmApiErrorRetriesRef.current += 1;
                  try {
                    const agent = await getBackend().retrieveAgent(
                      agentIdRef.current,
                    );
                    const { pendingApprovals: existingApprovals } =
                      await getResumeDataFromBackend(
                        agent,
                        conversationIdRef.current,
                      );
                    currentInput = rebuildInputWithFreshDenials(
                      currentInput,
                      existingApprovals ?? [],
                      STALE_APPROVAL_RECOVERY_DENIAL_REASON,
                    );
                  } catch {
                    // Fetch failed — strip stale payload and retry plain message
                    currentInput = rebuildInputWithFreshDenials(
                      currentInput,
                      [],
                      "",
                    );
                  }
                  buffersRef.current.interrupted = false;
                  continue;
                }

                // Check for 409 "conversation busy" error - retry with exponential backoff
                if (preStreamAction === "retry_conversation_busy") {
                  conversationBusyRetriesRef.current += 1;
                  const retryDelayMs = getRetryDelayMs({
                    category: "conversation_busy",
                    attempt: conversationBusyRetriesRef.current,
                  });

                  // Log the conversation-busy error
                  telemetry.trackError(
                    "retry_conversation_busy",
                    formatTelemetryErrorMessage(
                      errorDetail || "Conversation is busy",
                    ),
                    "pre_stream_retry",
                    {
                      httpStatus:
                        preStreamError instanceof APIError
                          ? preStreamError.status
                          : undefined,
                      modelId: currentModelId || undefined,
                    },
                  );

                  // Attempt to resume the in-flight run via the conversation stream endpoint.
                  // Server resolves: (1) otid lookup, (2) active run fallback.
                  try {
                    const backend = getBackend();
                    const messageOtid = currentInput
                      .map((item) => (item as Record<string, unknown>).otid)
                      .find((v): v is string => typeof v === "string");
                    debugLog(
                      "stream",
                      "Conversation busy: resuming via stream endpoint (otid=%s)",
                      messageOtid ?? "none",
                    );

                    if (signal?.aborted || userCancelledRef.current) {
                      const isStaleAtAbort =
                        myGeneration !== conversationGenerationRef.current;
                      if (!isStaleAtAbort) {
                        setStreaming(false);
                      }
                      outcome = "interrupted";
                      return;
                    }

                    const conversationId =
                      conversationIdRef.current ?? "default";
                    const resumeStream =
                      await backend.streamConversationMessages(
                        conversationId,
                        // Cast needed until SDK MessageStreamParams includes otid field
                        {
                          agent_id:
                            conversationId === "default"
                              ? (agentIdRef.current ?? undefined)
                              : undefined,
                          otid: messageOtid ?? undefined,
                          starting_after: 0,
                          batch_size: 1000,
                        } as unknown as ConversationMessageStreamBody,
                      );

                    // Only reset buffer state after confirming stream is available
                    buffersRef.current.interrupted = false;
                    buffersRef.current.commitGeneration =
                      (buffersRef.current.commitGeneration || 0) + 1;

                    preStreamResumeResult = await drainStream(
                      resumeStream,
                      buffersRef.current,
                      refreshDerivedThrottled,
                      signal,
                      undefined, // no handleFirstMessage on resume
                      makeExecutionPhaseHook(setExecutionPhase),
                      contextTrackerRef.current,
                      highestSeqIdSeen,
                    );
                    debugLog(
                      "stream",
                      "Pre-stream resume succeeded (stopReason=%s)",
                      preStreamResumeResult.stopReason,
                    );
                    // Fall through — preStreamResumeResult will short-circuit drainStreamWithResume
                  } catch (resumeError) {
                    if (signal?.aborted || userCancelledRef.current) {
                      const isStaleAtAbort =
                        myGeneration !== conversationGenerationRef.current;
                      if (!isStaleAtAbort) {
                        setStreaming(false);
                      }
                      outcome = "interrupted";
                      return;
                    }

                    debugLog(
                      "stream",
                      "Pre-stream resume failed, falling back to wait/retry: %s",
                      resumeError instanceof Error
                        ? resumeError.message
                        : String(resumeError),
                    );
                    // Fall through to existing wait/retry behavior
                  }

                  // If resume succeeded, skip the wait/retry loop
                  if (!preStreamResumeResult) {
                    // Show status message
                    const statusId = uid("status");
                    buffersRef.current.byId.set(statusId, {
                      kind: "status",
                      id: statusId,
                      lines: ["Conversation is busy, waiting and retrying…"],
                    });
                    buffersRef.current.order.push(statusId);
                    refreshDerived();

                    // Wait with abort checking (same pattern as LLM API error retry)
                    let cancelled = false;
                    const startTime = Date.now();
                    while (Date.now() - startTime < retryDelayMs) {
                      if (
                        abortControllerRef.current?.signal.aborted ||
                        userCancelledRef.current
                      ) {
                        cancelled = true;
                        break;
                      }
                      await new Promise((resolve) => setTimeout(resolve, 100));
                    }

                    // Remove status message
                    buffersRef.current.byId.delete(statusId);
                    buffersRef.current.order = buffersRef.current.order.filter(
                      (id: string) => id !== statusId,
                    );
                    refreshDerived();

                    if (!cancelled) {
                      buffersRef.current.interrupted = false;
                      restorePinnedPermissionMode();
                      continue;
                    }
                  }
                  // User pressed ESC - fall through to error handling
                }

                // Retry pre-stream transient errors (429/5xx/network) with shared LLM retry budget
                if (preStreamAction === "retry_transient") {
                  llmApiErrorRetriesRef.current += 1;
                  const attempt = llmApiErrorRetriesRef.current;

                  const retryAfterMs =
                    preStreamError instanceof APIError
                      ? parseRetryAfterHeaderMs(
                          preStreamError.headers?.get("retry-after"),
                        )
                      : null;
                  const delayMs = getRetryDelayMs({
                    category: "transient_provider",
                    attempt,
                    detail: errorDetail,
                    retryAfterMs,
                  });

                  // Log the error that triggered the retry
                  telemetry.trackError(
                    "retry_pre_stream_transient",
                    formatTelemetryErrorMessage(
                      errorDetail || "Pre-stream transient error",
                    ),
                    "pre_stream_retry",
                    {
                      httpStatus:
                        preStreamError instanceof APIError
                          ? preStreamError.status
                          : undefined,
                      modelId: currentModelId || undefined,
                    },
                  );

                  const retryStatusMsg = getRetryStatusMessage(errorDetail);
                  const retryStatusId =
                    retryStatusMsg != null ? uid("status") : null;
                  if (retryStatusId && retryStatusMsg) {
                    buffersRef.current.byId.set(retryStatusId, {
                      kind: "status",
                      id: retryStatusId,
                      lines: [retryStatusMsg],
                    });
                    buffersRef.current.order.push(retryStatusId);
                    refreshDerived();
                  }

                  let cancelled = false;
                  const startTime = Date.now();
                  while (Date.now() - startTime < delayMs) {
                    if (
                      abortControllerRef.current?.signal.aborted ||
                      userCancelledRef.current
                    ) {
                      cancelled = true;
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }

                  if (retryStatusId) {
                    buffersRef.current.byId.delete(retryStatusId);
                    buffersRef.current.order = buffersRef.current.order.filter(
                      (id: string) => id !== retryStatusId,
                    );
                    refreshDerived();
                  }

                  if (!cancelled) {
                    buffersRef.current.interrupted = false;
                    conversationBusyRetriesRef.current = 0;
                    restorePinnedPermissionMode();
                    continue;
                  }
                  // User pressed ESC - fall through to error handling
                }

                // Reset conversation busy retry counter on non-busy error
                conversationBusyRetriesRef.current = 0;

                // Check if this is a pre-stream approval desync error
                const hasApprovalInPayload = currentInput.some(
                  (item) => item?.type === "approval",
                );

                if (hasApprovalInPayload) {
                  // "Invalid tool call IDs" means server HAS pending approvals but with different IDs.
                  // We need to fetch the actual pending approvals and show them to the user.
                  if (isInvalidToolCallIdsError(errorDetail)) {
                    try {
                      const agent = await getBackend().retrieveAgent(
                        agentIdRef.current,
                      );
                      const { pendingApprovals: serverApprovals } =
                        await getResumeDataFromBackend(
                          agent,
                          conversationIdRef.current,
                        );

                      if (serverApprovals && serverApprovals.length > 0) {
                        // Preserve user message from current input (if any)
                        // Filter out system reminders to avoid re-injecting them
                        const userMessage = currentInput.find(
                          (item) => item?.type === "message",
                        );
                        if (userMessage && "content" in userMessage) {
                          const content = userMessage.content;
                          let textToRestore = "";
                          if (typeof content === "string") {
                            textToRestore = stripSystemReminders(content);
                          } else if (Array.isArray(content)) {
                            // Extract text parts, filtering out system reminders
                            textToRestore = content
                              .filter(
                                (c): c is { type: "text"; text: string } =>
                                  typeof c === "object" &&
                                  c !== null &&
                                  "type" in c &&
                                  c.type === "text" &&
                                  "text" in c &&
                                  typeof c.text === "string" &&
                                  !c.text.includes(SYSTEM_REMINDER_OPEN) &&
                                  !c.text.includes(SYSTEM_ALERT_OPEN),
                              )
                              .map((c) => c.text)
                              .join("\n");
                          }
                          if (textToRestore.trim()) {
                            setRestoredInput(textToRestore);
                          }
                        }

                        // Clear all stale approval state before setting new approvals
                        setApprovalResults([]);
                        setAutoHandledResults([]);
                        setAutoDeniedApprovals([]);
                        setApprovalContexts([]);
                        queueApprovalResults(null);

                        // Set up approval UI with fetched approvals
                        setPendingApprovals(serverApprovals);

                        // Analyze approval contexts (same logic as /resume)
                        try {
                          const contexts = await Promise.all(
                            serverApprovals.map(async (approval) => {
                              const parsedArgs = safeJsonParseOr<
                                Record<string, unknown>
                              >(approval.toolArgs, {});
                              return await analyzeToolApproval(
                                approval.toolName,
                                parsedArgs,
                              );
                            }),
                          );
                          setApprovalContexts(contexts);
                        } catch {
                          // If analysis fails, contexts remain empty (will show basic options)
                        }

                        // Stop streaming and exit - user needs to approve/deny
                        // (finally block will decrement processingConversationRef)
                        setStreaming(false);
                        sendDesktopNotification("Approval needed");
                        outcome = "awaiting_approval";
                        return;
                      }
                      // No approvals found - fall through to error handling below
                    } catch {
                      // Fetch failed - fall through to error handling below
                    }
                  }
                }

                // Not a recoverable desync - re-throw to outer catch
                throw preStreamError;
              }

              // Check again after network call - user may have pressed Escape during sendMessageStream
              if (signal?.aborted) {
                const isStaleAtAbort =
                  myGeneration !== conversationGenerationRef.current;
                // Only set streaming=false if this is the current generation.
                // If stale, a newer processConversation might be running and we shouldn't affect its UI.
                if (!isStaleAtAbort) {
                  setStreaming(false);
                }
                outcome = "interrupted";
                return;
              }

              // Define callback to sync agent state on first message chunk
              // This ensures the UI shows the correct model as early as possible
              const syncAgentState = async () => {
                try {
                  // Reuse the agent fetched by prepareToolExecutionContextForScope
                  // (avoids a redundant agents.retrieve per turn).
                  const agent =
                    prefetchedAgent ??
                    (await getBackend().retrieveAgent(agentIdRef.current));

                  // Keep model UI in sync with the agent configuration.
                  // Note: many tiers share the same handle (e.g. gpt-5.2-none/high), so we
                  // must also treat reasoning settings as model-affecting.
                  const currentModel = llmConfigRef.current?.model;
                  const currentEndpoint =
                    llmConfigRef.current?.model_endpoint_type;
                  const currentEffort = llmConfigRef.current?.reasoning_effort;
                  const currentEnableReasoner = (
                    llmConfigRef.current as unknown as {
                      enable_reasoner?: boolean | null;
                    }
                  )?.enable_reasoner;

                  const agentModel = agent.llm_config.model;
                  const agentEndpoint = agent.llm_config.model_endpoint_type;
                  const agentEffort = agent.llm_config.reasoning_effort;
                  const agentEnableReasoner = (
                    agent.llm_config as unknown as {
                      enable_reasoner?: boolean | null;
                    }
                  )?.enable_reasoner;

                  if (
                    currentModel !== agentModel ||
                    currentEndpoint !== agentEndpoint ||
                    currentEffort !== agentEffort ||
                    currentEnableReasoner !== agentEnableReasoner
                  ) {
                    if (!hasConversationModelOverrideRef.current) {
                      // Model has changed at the agent level - update local state.
                      setLlmConfig(agent.llm_config);

                      // Derive model ID from the configured model handle for ModelSelector.
                      const agentModelHandle =
                        getPreferredAgentModelHandle(agent);

                      const modelInfo = getModelInfoForLlmConfig(
                        agentModelHandle || "",
                        agent.llm_config as unknown as {
                          reasoning_effort?: string | null;
                          enable_reasoner?: boolean | null;
                        },
                      );
                      if (modelInfo) {
                        setCurrentModelId(modelInfo.id);
                      } else {
                        // Model not in the runtime catalog (e.g., BYOK model) - use handle as ID
                        setCurrentModelId(agentModelHandle || null);
                      }
                      setCurrentModelHandle(agentModelHandle || null);
                    }

                    // Always keep base agent state fresh.
                    setAgentState(agent);
                    setAgentDescription(agent.description ?? null);
                    const lastRunCompletion = (
                      agent as { last_run_completion?: string }
                    ).last_run_completion;
                    setAgentLastRunAt(lastRunCompletion ?? null);
                  }
                } catch (error) {
                  // Silently fail - don't interrupt the conversation flow
                  debugLog(
                    "sync-agent",
                    "Failed to sync agent state: %O",
                    error,
                  );
                }
              };

              const isAutoApprovalMode =
                pinnedPermissionMode === "unrestricted";
              const isUserInitiated = currentInput.some(
                (item) => item.type === "message" && item.role === "user",
              );
              const handleFirstMessage = () => {
                setNetworkPhase("download");
                // Only sync agent state on user messages or when manual approval
                // mode is active (user may have changed model while reviewing).
                // In bypass mode, tool-result continuations happen instantly —
                // no time for the agent to have changed.
                if (isUserInitiated || !isAutoApprovalMode) {
                  void syncAgentState();
                }
              };

              const runTokenStart = buffersRef.current.tokenCount;
              trajectoryRunTokenStartRef.current = runTokenStart;
              sessionStatsRef.current.startTrajectory();

              // Only bump turn counter for actual user messages, not approval continuations.
              // This ensures all LLM steps within one user "turn" are counted as one.
              const hasUserMessage = currentInput.some(
                (item) => item.type === "message",
              );
              if (hasUserMessage) {
                contextTrackerRef.current.currentTurnId++;
              }

              const drainResult = preStreamResumeResult
                ? preStreamResumeResult
                : (() => {
                    if (!stream) {
                      throw new Error(
                        "Expected stream when pre-stream resume did not succeed",
                      );
                    }
                    return drainStreamWithResume(
                      stream,
                      buffersRef.current,
                      refreshDerivedThrottled,
                      signal, // Use captured signal, not ref (which may be nulled by handleInterrupt)
                      handleFirstMessage,
                      makeExecutionPhaseHook(setExecutionPhase),
                      contextTrackerRef.current,
                      highestSeqIdSeen,
                    );
                  })();

              const {
                stopReason,
                approval,
                approvals,
                apiDurationMs,
                lastRunId,
                lastSeqId,
                fallbackError,
                errorInfo: streamErrorInfo,
              } = await drainResult;

              if (lastSeqId != null) {
                highestSeqIdSeen = Math.max(highestSeqIdSeen ?? 0, lastSeqId);
              }

              // Update currentRunId for error reporting in catch block
              currentRunId = lastRunId ?? undefined;
              // Expose to statusline
              if (lastRunId) lastRunIdRef.current = lastRunId;

              // Track API duration and trajectory deltas
              sessionStatsRef.current.endTurn(apiDurationMs);
              const usageDelta = sessionStatsRef.current.updateUsageFromBuffers(
                buffersRef.current,
              );
              const tokenDelta = Math.max(
                0,
                buffersRef.current.tokenCount - runTokenStart,
              );
              sessionStatsRef.current.accumulateTrajectory({
                apiDurationMs,
                usageDelta,
                tokenDelta,
              });
              syncTrajectoryTokenBase();

              const wasInterrupted = !!buffersRef.current.interrupted;
              const wasAborted = !!signal?.aborted;
              let stopReasonToHandle = wasAborted ? "cancelled" : stopReason;

              // Check if this conversation became stale while the stream was running.
              // If stale, a newer processConversation is running and we shouldn't modify UI state.
              const isStaleAfterDrain =
                myGeneration !== conversationGenerationRef.current;

              // If this conversation is stale, exit without modifying UI state.
              // A newer conversation is running and should control the UI.
              if (isStaleAfterDrain) {
                outcome = "interrupted";
                return;
              }

              // Immediate refresh after stream completes to show final state unless
              // the user already cancelled (handleInterrupt rendered the UI).
              if (!wasInterrupted) {
                refreshDerived();
              }

              // If the turn was interrupted client-side but the backend had already emitted
              // requires_approval, treat it as a cancel. This avoids re-entering approval flow
              // and keeps queue-cancel flags consistent with the normal cancel branch below.
              if (
                wasInterrupted &&
                stopReasonToHandle === "requires_approval"
              ) {
                stopReasonToHandle = "cancelled";
              }

              const approvalsFromStream =
                approvals && approvals.length > 0
                  ? approvals
                  : approval
                    ? [approval]
                    : [];
              if (
                stopReasonToHandle === "end_turn" &&
                approvalsFromStream.length > 0
              ) {
                telemetry.trackError(
                  "stream_end_turn_with_pending_approvals_tui_guard",
                  "Stream returned end_turn after emitting approval_request_message chunks; continuing approval flow",
                  "message_stream",
                  { runId: lastRunId ?? undefined },
                );
                debugWarn(
                  "stream",
                  "Coercing end_turn to requires_approval because %d approval chunk(s) were collected",
                  approvalsFromStream.length,
                );
                stopReasonToHandle = "requires_approval";
              }

              // Record the final stop reason so the dequeue gate can check it and
              // classify the admitted turn's explicit outcome.
              lastStopReasonRef.current = stopReasonToHandle;
              if (stopReasonToHandle === "cancelled") {
                outcome = "interrupted";
              } else if (stopReasonToHandle === "requires_approval") {
                outcome = "awaiting_approval";
              } else if (stopReasonToHandle === "end_turn") {
                outcome = "completed";
              } else {
                outcome = "error";
              }

              // Case 1: Turn ended normally
              if (stopReasonToHandle === "end_turn") {
                clearApprovalToolContext();
                setStreaming(false);
                const liveElapsedMs = (() => {
                  const snapshot =
                    sessionStatsRef.current.getTrajectorySnapshot();
                  const base = snapshot?.wallMs ?? 0;
                  const segmentStart = trajectorySegmentStartRef.current;
                  if (segmentStart === null) {
                    return base;
                  }
                  return base + (performance.now() - segmentStart);
                })();
                closeTrajectorySegment();
                llmApiErrorRetriesRef.current = 0; // Reset retry counter on success
                emptyResponseRetriesRef.current = 0;
                conversationBusyRetriesRef.current = 0;
                lastDequeuedMessageRef.current = null; // Clear - message was processed successfully
                lastSentInputRef.current = null; // Clear - no recovery needed
                pendingInterruptRecoveryConversationIdRef.current = null;

                if (transcriptTurnStartLineIndex !== null) {
                  try {
                    const transcriptLines = toLines(buffersRef.current).slice(
                      transcriptTurnStartLineIndex,
                    );
                    await appendTranscriptDeltaJsonl(
                      agentIdRef.current,
                      conversationIdRef.current,
                      transcriptLines,
                    );
                  } catch (transcriptError) {
                    debugWarn(
                      "memory",
                      `Failed to append transcript delta: ${
                        transcriptError instanceof Error
                          ? transcriptError.message
                          : String(transcriptError)
                      }`,
                    );
                  }
                }
                pendingTranscriptStartLineIndexRef.current = null;

                // Evaluate reflection triggers now that the turn's transcript
                // delta is on disk, so step counts include this turn.
                await maybeRunPostTurnReflection();

                // Get last assistant message, user message, and reasoning for Stop hook
                const bufferedLines = Array.from(
                  buffersRef.current.byId.values(),
                ) as Line[];
                const lastAssistant = bufferedLines.findLast(
                  (item) => item.kind === "assistant" && "text" in item,
                );
                const assistantMessage =
                  lastAssistant && "text" in lastAssistant
                    ? lastAssistant.text
                    : undefined;
                const lastUser = bufferedLines.findLast(
                  (item) => item.kind === "user" && "text" in item,
                );
                const userMessage =
                  lastUser && "text" in lastUser ? lastUser.text : undefined;
                const precedingReasoning = buffersRef.current.lastReasoning;
                buffersRef.current.lastReasoning = undefined; // Clear after use

                const stopHookResult = await runStopHooks(
                  stopReasonToHandle,
                  buffersRef.current.order.length,
                  bufferedLines.filter((item) => item.kind === "tool_call")
                    .length,
                  undefined, // workingDirectory (uses default)
                  precedingReasoning,
                  assistantMessage,
                  userMessage,
                );

                if (stopHookResult.blocked) {
                  const stderrOutput = stopHookResult.results
                    .map((r) => r.stderr)
                    .filter(Boolean)
                    .join("\n");
                  const feedback = stderrOutput || "Stop hook blocked";
                  const hookMessage = `<stop-hook>\n${feedback}\n</stop-hook>`;

                  const statusId = uid("status");
                  buffersRef.current.byId.set(statusId, {
                    kind: "status",
                    id: statusId,
                    lines: ["Stop hook blocked, continuing conversation."],
                  });
                  buffersRef.current.order.push(statusId);
                  refreshDerived();

                  const hookMessageOtid = randomUUID();
                  const continuationResult = await processConversation(
                    [
                      {
                        type: "message",
                        role: "user",
                        content: hookMessage,
                        otid: hookMessageOtid,
                      },
                    ],
                    {
                      allowReentry: true,
                      submissionGeneration: myGeneration,
                    },
                  );
                  outcome = continuationOutcome(continuationResult);
                  return;
                }

                const turnEndEvent: {
                  agentId: string | null;
                  conversationId: string | null;
                  stopReason: string;
                  assistantMessage?: string;
                  continue?: string;
                } = {
                  agentId: agentIdRef.current ?? null,
                  conversationId: conversationIdRef.current ?? null,
                  stopReason: stopReasonToHandle,
                  assistantMessage,
                };
                let turnEndContinue: string | undefined;
                try {
                  await modAdapter.events.emit(
                    "turn_end",
                    turnEndEvent,
                    modAdapter.context,
                  );
                  turnEndContinue =
                    typeof turnEndEvent.continue === "string"
                      ? turnEndEvent.continue
                      : undefined;
                } catch {
                  turnEndContinue = undefined;
                }

                if (turnEndContinue) {
                  const continueOtid = randomUUID();
                  const continuationResult = await processConversation(
                    [
                      {
                        type: "message",
                        role: "user",
                        content: turnEndContinue,
                        otid: continueOtid,
                      },
                    ],
                    {
                      allowReentry: true,
                      submissionGeneration: myGeneration,
                    },
                  );
                  outcome = continuationOutcome(continuationResult);
                  return;
                }

                if (needsEagerApprovalCheck) {
                  setNeedsEagerApprovalCheck(false);
                }

                if (
                  shouldAutoGenerateConversationTitleRef.current &&
                  !isAutoConversationTitleInFlightRef.current &&
                  conversationIdRef.current !== "default"
                ) {
                  isAutoConversationTitleInFlightRef.current = true;
                  const titleConversationId = conversationIdRef.current;
                  const conversationTitle = await generateConversationTitle();
                  if (!conversationTitle) {
                    isAutoConversationTitleInFlightRef.current = false;
                  } else if (
                    !shouldAutoGenerateConversationTitleRef.current ||
                    conversationIdRef.current !== titleConversationId
                  ) {
                    isAutoConversationTitleInFlightRef.current = false;
                  } else {
                    void getBackend()
                      .updateConversation(titleConversationId, {
                        summary: conversationTitle,
                      })
                      .then(() => {
                        shouldAutoGenerateConversationTitleRef.current = false;
                        setConversationSummary(conversationTitle);
                      })
                      .catch((err) => {
                        // Silently ignore - not critical.
                        if (isDebugEnabled()) {
                          console.error(
                            "[DEBUG] Failed to update conversation title:",
                            err,
                          );
                        }
                      })
                      .finally(() => {
                        isAutoConversationTitleInFlightRef.current = false;
                      });
                  }
                }

                if (
                  contextTrackerRef.current
                    .pendingConversationDescriptionRegeneration
                ) {
                  contextTrackerRef.current.pendingConversationDescriptionRegeneration = false;
                  void generateConversationDescription({ force: true });
                } else {
                  void generateConversationDescription();
                }

                const trajectorySnapshot =
                  sessionStatsRef.current.endTrajectory();
                setTrajectoryTokenBase(0);
                setTrajectoryElapsedBaseMs(0);
                trajectoryRunTokenStartRef.current = 0;
                trajectoryTokenDisplayRef.current = 0;
                if (trajectorySnapshot) {
                  const summaryWallMs = Math.max(
                    liveElapsedMs,
                    trajectorySnapshot.wallMs,
                  );
                  const shouldShowSummary =
                    (trajectorySnapshot.stepCount > 3 &&
                      summaryWallMs > 10000) ||
                    summaryWallMs > 60000;
                  if (shouldShowSummary) {
                    const summaryId = uid("trajectory-summary");
                    buffersRef.current.byId.set(summaryId, {
                      kind: "trajectory_summary",
                      id: summaryId,
                      durationMs: summaryWallMs,
                      stepCount: trajectorySnapshot.stepCount,
                      verb: getRandomPastTenseVerb(),
                    });
                    buffersRef.current.order.push(summaryId);
                    refreshDerived();
                  }
                }

                // Send desktop notification when turn completes
                // and we're not about to auto-send another queued message
                if (!waitingForQueueCancelRef.current) {
                  sendDesktopNotification(
                    "Turn completed, awaiting your input",
                  );
                }

                // Check if we were waiting for cancel but stream finished naturally
                if (waitingForQueueCancelRef.current) {
                  // Queue-cancel completed - let dequeue effect handle the messages
                  // We don't call onSubmit here because isAgentBusy() would return true
                  // (abortControllerRef is still set until finally block), causing re-queue
                  debugLog(
                    "queue",
                    "Queue-cancel completed (end_turn): messages will be processed by dequeue effect",
                  );
                  if (restoreQueueOnCancelRef.current) {
                    setRestoreQueueOnCancel(false);
                  }

                  // Reset flags - dequeue effect will fire when streaming=false commits
                  waitingForQueueCancelRef.current = false;
                  queueSnapshotRef.current = [];
                }

                return;
              }

              // Case 1.5: Stream was cancelled by user
              if (stopReasonToHandle === "cancelled") {
                clearApprovalToolContext();
                pendingTranscriptStartLineIndexRef.current = null;
                setStreaming(false);
                closeTrajectorySegment();
                syncTrajectoryElapsedBase();

                // Check if this cancel was triggered by queue threshold
                if (waitingForQueueCancelRef.current) {
                  // Queue-cancel completed - let dequeue effect handle the messages
                  // We don't call onSubmit here because isAgentBusy() would return true
                  // (abortControllerRef is still set until finally block), causing re-queue
                  debugLog(
                    "queue",
                    "Queue-cancel completed (cancelled): messages will be processed by dequeue effect",
                  );
                  if (restoreQueueOnCancelRef.current) {
                    setRestoreQueueOnCancel(false);
                  }

                  // Reset flags - dequeue effect will fire when streaming=false commits
                  waitingForQueueCancelRef.current = false;
                  queueSnapshotRef.current = [];
                } else {
                  // Regular user cancellation - show error
                  if (!EAGER_CANCEL) {
                    appendError(INTERRUPT_MESSAGE, true);
                  }
                }

                return;
              }

              // Case 2: Requires approval
              if (stopReasonToHandle === "requires_approval") {
                clearApprovalToolContext();
                preserveTranscriptStartForApproval = true;
                approvalToolContextIdRef.current = turnToolContextId;
                // Clear stale state immediately to prevent ID mismatch bugs
                setAutoHandledResults([]);
                setAutoDeniedApprovals([]);
                lastSentInputRef.current = null; // Clear - message was received by server
                pendingInterruptRecoveryConversationIdRef.current = null;

                // Use new approvals array, fallback to legacy approval for backward compat
                const approvalsToProcess = approvalsFromStream;

                if (approvalsToProcess.length === 0) {
                  clearApprovalToolContext();
                  appendError(
                    `Unexpected empty approvals with stop reason: ${stopReason}`,
                  );
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  outcome = "error";
                  return;
                }

                // If in quietCancel mode (user queued messages), auto-reject all approvals
                // and send denials + queued messages together
                if (waitingForQueueCancelRef.current) {
                  clearApprovalToolContext();
                  // Create denial results for all approvals
                  const denialResults = approvalsToProcess.map(
                    (approvalItem) => ({
                      type: "approval" as const,
                      tool_call_id: approvalItem.toolCallId,
                      approve: false,
                      reason: "User cancelled - new message queued",
                    }),
                  );

                  // Update buffers to show tools as cancelled
                  for (const approvalItem of approvalsToProcess) {
                    onChunk(buffersRef.current, {
                      message_type: "tool_return_message",
                      id: "dummy",
                      date: new Date().toISOString(),
                      tool_call_id: approvalItem.toolCallId,
                      tool_return: "Cancelled - user sent new message",
                      status: "error",
                    });
                  }
                  refreshDerived();

                  // Queue denial results - dequeue effect will pick them up via onSubmit
                  queueApprovalResults(denialResults);

                  debugLog(
                    "queue",
                    `Queue-cancel completed (requires_approval): ${denialResults.length} denial(s) queued, messages will be processed by dequeue effect`,
                  );

                  if (restoreQueueOnCancelRef.current) {
                    setRestoreQueueOnCancel(false);
                  }

                  // Reset flags - dequeue effect will fire when streaming=false commits
                  waitingForQueueCancelRef.current = false;
                  queueSnapshotRef.current = [];
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  outcome = "interrupted";
                  return;
                }

                // Check if user cancelled before starting permission checks
                if (
                  userCancelledRef.current ||
                  abortControllerRef.current?.signal.aborted
                ) {
                  clearApprovalToolContext();
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  markIncompleteToolsAsCancelled(
                    buffersRef.current,
                    true,
                    "user_interrupt",
                  );
                  refreshDerived();
                  outcome = "interrupted";
                  return;
                }

                // Check permissions for all approvals (including fancy UI tools)
                // Ensure the singleton permission mode matches what the UI shows.
                // This prevents rare races where the footer shows YOLO but approvals still
                // get classified using the default mode.
                const desiredMode = uiPermissionModeRef.current;
                if (permissionMode.getMode() !== desiredMode) {
                  permissionMode.setMode(desiredMode);
                }

                const { needsUserInput, autoAllowed, autoDenied } =
                  await classifyApprovals(approvalsToProcess, {
                    getContext: analyzeToolApproval,
                    alwaysRequiresUserInput,
                    requireArgsForAutoApprove: true,
                    missingNameReason:
                      "Tool call incomplete - missing name or arguments",
                    toolContextId: approvalToolContextIdRef.current,
                  });

                // Precompute diffs for file edit tools before execution (both auto-allowed and needs-user-input)
                // This is needed for inline approval UI to show diffs, and for post-approval rendering
                for (const ac of [...autoAllowed, ...needsUserInput]) {
                  const toolName = ac.approval.toolName;
                  const toolCallId = ac.approval.toolCallId;
                  try {
                    const args = JSON.parse(ac.approval.toolArgs || "{}");

                    if (isFileWriteTool(toolName)) {
                      const filePath = args.file_path as string | undefined;
                      if (filePath) {
                        const result = computeAdvancedDiff({
                          kind: "write",
                          filePath,
                          content: (args.content as string) || "",
                        });
                        if (result.mode === "advanced") {
                          precomputedDiffsRef.current.set(toolCallId, result);
                        }
                      }
                    } else if (isFileEditTool(toolName)) {
                      const filePath = args.file_path as string | undefined;
                      if (filePath) {
                        // Check if it's a multi-edit (has edits array) or single edit
                        if (args.edits && Array.isArray(args.edits)) {
                          const result = computeAdvancedDiff({
                            kind: "multi_edit",
                            filePath,
                            edits: args.edits as Array<{
                              old_string: string;
                              new_string: string;
                              replace_all?: boolean;
                            }>,
                          });
                          if (result.mode === "advanced") {
                            precomputedDiffsRef.current.set(toolCallId, result);
                          }
                        } else {
                          const result = computeAdvancedDiff({
                            kind: "edit",
                            filePath,
                            oldString: (args.old_string as string) || "",
                            newString: (args.new_string as string) || "",
                            replaceAll: args.replace_all as boolean | undefined,
                          });
                          if (result.mode === "advanced") {
                            precomputedDiffsRef.current.set(toolCallId, result);
                          }
                        }
                      }
                    } else if (isPatchTool(toolName) && args.input) {
                      // Patch tools - parse hunks directly (patches ARE diffs)
                      const operations = parsePatchOperations(
                        args.input as string,
                      );
                      for (const op of operations) {
                        const key = `${toolCallId}:${op.path}`;
                        if (op.kind === "add" || op.kind === "update") {
                          const result = parsePatchToAdvancedDiff(
                            op.patchLines,
                            op.path,
                          );
                          if (result) {
                            precomputedDiffsRef.current.set(key, result);
                          }
                        }
                        // Delete operations don't need diffs
                      }
                    }
                  } catch {
                    // Ignore errors in diff computation for auto-allowed tools
                  }
                }

                const autoAllowedToolCallIds = autoAllowed.map(
                  (ac) => ac.approval.toolCallId,
                );
                const autoAllowedAbortController =
                  abortControllerRef.current ?? new AbortController();
                const shouldTrackAutoAllowed =
                  autoAllowedToolCallIds.length > 0;
                let autoAllowedResults: Array<{
                  toolCallId: string;
                  result: ToolExecutionResult;
                }> = [];
                let autoDeniedResults: Array<{
                  approval: ApprovalRequest;
                  reason: string;
                }> = [];

                if (shouldTrackAutoAllowed) {
                  setIsExecutingTool(true);
                  executingToolCallIdsRef.current = autoAllowedToolCallIds;
                  toolAbortControllerRef.current = autoAllowedAbortController;
                  autoAllowedExecutionRef.current = {
                    toolCallIds: autoAllowedToolCallIds,
                    results: null,
                    conversationId: conversationIdRef.current,
                    generation: conversationGenerationRef.current,
                  };
                }

                try {
                  if (autoAllowedToolCallIds.length > 0) {
                    // Set phase to "running" for auto-allowed tools
                    setToolCallsRunning(
                      buffersRef.current,
                      autoAllowedToolCallIds,
                    );
                    refreshDerived();
                  }

                  // Execute auto-allowed tools (sequential for writes, parallel for reads)
                  const approvalToolContextId =
                    approvalToolContextIdRef.current ??
                    (
                      await prepareScopedToolExecutionContext(
                        tempModelOverrideRef.current ?? undefined,
                      )
                    ).preparedToolContext.contextId;
                  autoAllowedResults =
                    autoAllowed.length > 0
                      ? await executeAutoAllowedTools(
                          autoAllowed,
                          (chunk) => onChunk(buffersRef.current, chunk),
                          {
                            abortSignal: autoAllowedAbortController.signal,
                            onStreamingOutput: updateStreamingOutput,
                            toolContextId: approvalToolContextId,
                          },
                        )
                      : [];

                  // Create denial results for auto-denied tools and update buffers
                  autoDeniedResults = autoDenied.map((ac) => {
                    const reason = formatPermissionDenial(ac.permission);

                    // Update buffers with tool rejection for UI
                    onChunk(buffersRef.current, {
                      message_type: "tool_return_message",
                      id: "dummy",
                      date: new Date().toISOString(),
                      tool_call_id: ac.approval.toolCallId,
                      tool_return: `Error: request to call tool denied. User reason: ${reason}`,
                      status: "error",
                      stdout: null,
                      stderr: null,
                    });

                    return {
                      approval: ac.approval,
                      reason,
                    };
                  });

                  const allResults = [
                    ...autoAllowedResults.map((ar) => ({
                      type: "tool" as const,
                      tool_call_id: ar.toolCallId,
                      tool_return: ar.result.toolReturn,
                      status: ar.result.status,
                      stdout: ar.result.stdout,
                      stderr: ar.result.stderr,
                    })),
                    ...autoDeniedResults.map((ad) => ({
                      type: "approval" as const,
                      tool_call_id: ad.approval.toolCallId,
                      approve: false,
                      reason: ad.reason,
                    })),
                  ];

                  if (autoAllowedExecutionRef.current) {
                    autoAllowedExecutionRef.current.results = allResults;
                  }
                  const autoAllowedMetadata = autoAllowedExecutionRef.current
                    ? {
                        conversationId:
                          autoAllowedExecutionRef.current.conversationId,
                        generation: conversationGenerationRef.current,
                      }
                    : undefined;

                  // If all are auto-handled, continue immediately without showing dialog
                  if (needsUserInput.length === 0) {
                    // Check if user cancelled before continuing
                    if (
                      userCancelledRef.current ||
                      abortControllerRef.current?.signal.aborted ||
                      interruptQueuedRef.current
                    ) {
                      if (allResults.length > 0) {
                        queueApprovalResults(allResults, autoAllowedMetadata);
                      }
                      setStreaming(false);
                      closeTrajectorySegment();
                      syncTrajectoryElapsedBase();
                      markIncompleteToolsAsCancelled(
                        buffersRef.current,
                        true,
                        "user_interrupt",
                      );
                      refreshDerived();
                      outcome = "interrupted";
                      return;
                    }

                    const queued =
                      queueModeRef.current === "immediate"
                        ? prepareQueueContinuation(tuiQueueRef.current)
                        : null;
                    if (queued) {
                      toolResultsInFlightRef.current = true;
                      try {
                        const continuationResult = await processConversation(
                          [
                            {
                              type: "approval",
                              approvals: allResults,
                              otid: createClientOtid(),
                            },
                            {
                              type: "message",
                              role: "user",
                              content: queued.content,
                              otid: queued.userOtid,
                            },
                          ],
                          {
                            allowReentry: true,
                            submissionGeneration: myGeneration,
                            admissionCommit: () =>
                              commitQueueContinuation(
                                tuiQueueRef.current,
                                queued,
                                (committed) => {
                                  appendTaskNotificationEvents(
                                    committed.notificationSummaries,
                                  );
                                  appendOptimisticUserLine(
                                    buffersRef.current,
                                    committed.userText,
                                    committed.userOtid,
                                  );
                                  if (committed.userText) {
                                    lastDequeuedMessageRef.current =
                                      committed.userText;
                                  }
                                  setThinkingMessage(getRandomThinkingVerb());
                                  refreshDerived();
                                },
                              ),
                          },
                        );
                        if (
                          continuationResult.type === "not_admitted" &&
                          allResults.length > 0
                        ) {
                          queueApprovalResults(allResults, autoAllowedMetadata);
                        }
                        outcome = continuationOutcome(continuationResult);
                      } finally {
                        toolResultsInFlightRef.current = false;
                      }
                      return;
                    }

                    if (waitingForQueueCancelRef.current) {
                      if (allResults.length > 0) {
                        queueApprovalResults(allResults, autoAllowedMetadata);
                      }

                      debugLog(
                        "queue",
                        `Queue-cancel completed (auto-allowed): ${allResults.length} result(s) queued, messages will be processed by dequeue effect`,
                      );

                      if (restoreQueueOnCancelRef.current) {
                        setRestoreQueueOnCancel(false);
                      }

                      waitingForQueueCancelRef.current = false;
                      queueSnapshotRef.current = [];
                      setStreaming(false);
                      closeTrajectorySegment();
                      syncTrajectoryElapsedBase();
                      outcome = "interrupted";
                      return;
                    }

                    const approvalOtid = randomUUID();
                    toolResultsInFlightRef.current = true;
                    try {
                      const continuationResult = await processConversation(
                        [
                          {
                            type: "approval",
                            approvals: allResults,
                            otid: approvalOtid,
                          },
                        ],
                        {
                          allowReentry: true,
                          allowResponseStateReuse: true,
                          submissionGeneration: myGeneration,
                          admissionCommit: () => {
                            setThinkingMessage(getRandomThinkingVerb());
                            refreshDerived();
                            return true;
                          },
                        },
                      );
                      if (
                        continuationResult.type === "not_admitted" &&
                        allResults.length > 0
                      ) {
                        queueApprovalResults(allResults, autoAllowedMetadata);
                      }
                      outcome = continuationOutcome(continuationResult);
                    } finally {
                      toolResultsInFlightRef.current = false;
                    }
                    return;
                  }

                  if (waitingForQueueCancelRef.current) {
                    const denialResults = needsUserInput.map((ac) => ({
                      type: "approval" as const,
                      tool_call_id: ac.approval.toolCallId,
                      approve: false,
                      reason: "User cancelled - new message queued",
                    }));

                    for (const ac of needsUserInput) {
                      onChunk(buffersRef.current, {
                        message_type: "tool_return_message",
                        id: "dummy",
                        date: new Date().toISOString(),
                        tool_call_id: ac.approval.toolCallId,
                        tool_return: "Cancelled - user sent new message",
                        status: "error",
                      });
                    }
                    refreshDerived();

                    const queuedResults = [...allResults, ...denialResults];
                    if (queuedResults.length > 0) {
                      queueApprovalResults(queuedResults, autoAllowedMetadata);
                    }

                    debugLog(
                      "queue",
                      `Queue-cancel completed (auto-allowed+approvals): ${queuedResults.length} result(s) queued, messages will be processed by dequeue effect`,
                    );

                    if (restoreQueueOnCancelRef.current) {
                      setRestoreQueueOnCancel(false);
                    }

                    // Reset flags - dequeue effect will fire when streaming=false commits
                    waitingForQueueCancelRef.current = false;
                    queueSnapshotRef.current = [];
                    setStreaming(false);
                    closeTrajectorySegment();
                    syncTrajectoryElapsedBase();
                    return;
                  }
                } finally {
                  if (shouldTrackAutoAllowed) {
                    setIsExecutingTool(false);
                    toolAbortControllerRef.current = null;
                    executingToolCallIdsRef.current = [];
                    autoAllowedExecutionRef.current = null;
                    toolResultsInFlightRef.current = false;
                  }
                }

                // Check if user cancelled before showing dialog
                if (
                  userCancelledRef.current ||
                  abortControllerRef.current?.signal.aborted
                ) {
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  markIncompleteToolsAsCancelled(
                    buffersRef.current,
                    true,
                    "user_interrupt",
                  );
                  refreshDerived();
                  outcome = "interrupted";
                  return;
                }

                // Show approval dialog for tools that need user input
                setPendingApprovals(needsUserInput.map((ac) => ac.approval));
                setApprovalContexts(
                  needsUserInput
                    .map((ac) => ac.context)
                    .filter((ctx): ctx is ApprovalContext => ctx !== null),
                );
                setAutoHandledResults(autoAllowedResults);
                setAutoDeniedApprovals(autoDeniedResults);
                setStreaming(false);
                closeTrajectorySegment();
                syncTrajectoryElapsedBase();
                // Notify user that approval is needed
                sendDesktopNotification("Approval needed");
                return;
              }

              // Unexpected stop reason (error, llm_api_error, etc.)
              // Cache desync detection and last failure for consistent handling
              // Check if payload contains approvals (could be approval-only or mixed with user message)
              const hasApprovalInPayload = currentInput.some(
                (item) => item?.type === "approval",
              );

              // Capture the most recent error text in this turn (if any)
              let latestErrorText: string | null = null;
              for (
                let i = buffersRef.current.order.length - 1;
                i >= 0;
                i -= 1
              ) {
                const id = buffersRef.current.order[i];
                if (!id) continue;
                const entry = buffersRef.current.byId.get(id);
                if (entry?.kind === "error" && typeof entry.text === "string") {
                  latestErrorText = entry.text;
                  break;
                }
              }

              const runErrorInfo = await fetchRunErrorInfo(lastRunId),
                detailFromRun = runErrorInfo?.detail ?? runErrorInfo?.message;
              const invalidIdsDetected =
                isInvalidToolCallIdsError(detailFromRun) ||
                isInvalidToolCallIdsError(latestErrorText);

              if (hasApprovalInPayload && invalidIdsDetected) {
                try {
                  const agent = await getBackend().retrieveAgent(
                    agentIdRef.current,
                  );
                  const { pendingApprovals: serverApprovals } =
                    await getResumeDataFromBackend(
                      agent,
                      conversationIdRef.current,
                    );

                  if (serverApprovals && serverApprovals.length > 0) {
                    // Preserve user message from current input (if any)
                    // Filter out system reminders to avoid re-injecting them
                    const userMessage = currentInput.find(
                      (item) => item?.type === "message",
                    );
                    if (userMessage && "content" in userMessage) {
                      const content = userMessage.content;
                      let textToRestore = "";
                      if (typeof content === "string") {
                        textToRestore = stripSystemReminders(content);
                      } else if (Array.isArray(content)) {
                        // Extract text parts, filtering out system reminders
                        textToRestore = content
                          .filter(
                            (c): c is { type: "text"; text: string } =>
                              typeof c === "object" &&
                              c !== null &&
                              "type" in c &&
                              c.type === "text" &&
                              "text" in c &&
                              typeof c.text === "string" &&
                              !c.text.includes(SYSTEM_REMINDER_OPEN) &&
                              !c.text.includes(SYSTEM_ALERT_OPEN),
                          )
                          .map((c) => c.text)
                          .join("\n");
                      }
                      if (textToRestore.trim()) {
                        setRestoredInput(textToRestore);
                      }
                    }

                    // Clear all stale approval state before setting new approvals
                    setApprovalResults([]);
                    setAutoHandledResults([]);
                    setAutoDeniedApprovals([]);
                    setApprovalContexts([]);
                    queueApprovalResults(null);

                    // Set up approval UI with fetched approvals
                    setPendingApprovals(serverApprovals);

                    // Analyze approval contexts
                    try {
                      const contexts = await Promise.all(
                        serverApprovals.map(async (approval) => {
                          const parsedArgs = safeJsonParseOr<
                            Record<string, unknown>
                          >(approval.toolArgs, {});
                          return await analyzeToolApproval(
                            approval.toolName,
                            parsedArgs,
                          );
                        }),
                      );
                      setApprovalContexts(contexts);
                    } catch {
                      // If analysis fails, contexts remain empty (will show basic options)
                    }

                    // Stop streaming and exit - user needs to approve/deny
                    // (finally block will decrement processingConversationRef)
                    setStreaming(false);
                    sendDesktopNotification("Approval needed");
                    outcome = "awaiting_approval";
                    return;
                  }
                  // No approvals found - fall through to error handling below
                } catch {
                  // Fetch failed - fall through to error handling below
                }
              }

              // Check for approval pending error (sent user message while approval waiting).
              // This is the lazy recovery path: fetch real pending approvals, auto-deny, retry.
              // Works regardless of hasApprovalInPayload — stale queued approvals from an
              // interrupt may have been rejected by the backend.
              const approvalPendingDetected =
                isApprovalPendingError(detailFromRun) ||
                isApprovalPendingError(latestErrorText);

              if (
                shouldAttemptApprovalRecovery({
                  approvalPendingDetected,
                  retries: llmApiErrorRetriesRef.current,
                  maxRetries: LLM_API_ERROR_MAX_RETRIES,
                })
              ) {
                llmApiErrorRetriesRef.current += 1;

                try {
                  // Fetch pending approvals and auto-deny them
                  const agent = await getBackend().retrieveAgent(
                    agentIdRef.current,
                  );
                  const { pendingApprovals: existingApprovals } =
                    await getResumeDataFromBackend(
                      agent,
                      conversationIdRef.current,
                    );
                  currentInput = rebuildInputWithFreshDenials(
                    currentInput,
                    existingApprovals ?? [],
                    STALE_APPROVAL_RECOVERY_DENIAL_REASON,
                  );
                } catch {
                  // Fetch failed — strip stale payload and retry plain message
                  currentInput = rebuildInputWithFreshDenials(
                    currentInput,
                    [],
                    "",
                  );
                }

                // Reset interrupted flag so retry stream chunks are processed
                buffersRef.current.interrupted = false;
                continue;
              }

              if (
                chatgptPlanSwapsRef.current <
                CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN
              ) {
                const rotation = await rotateChatGPTPlanOnQuotaLimit({
                  agentId: agentIdRef.current,
                  conversationId: conversationIdRef.current,
                  currentHandle: currentModelId,
                  error: streamErrorInfo ?? runErrorInfo ?? fallbackError,
                  exhaustedProviders: chatgptExhaustedProvidersRef.current,
                  signal: activeTurnAbortController.signal,
                });
                if (rotation) {
                  chatgptPlanSwapsRef.current += 1;
                  const statusId = uid("status");
                  buffersRef.current.byId.set(statusId, {
                    kind: "status",
                    id: statusId,
                    lines: [formatPlanRotationNotice(rotation)],
                  });
                  buffersRef.current.order.push(statusId);
                  refreshDerived();

                  currentInput = refreshInputOtidsForNewRequest(currentInput);
                  buffersRef.current.interrupted = false;
                  continue;
                }
                // No sibling plan available; try the hosted Auto fallback below.
              }

              // Quota-limit fallback: hosted Letta API can recover by switching to
              // Auto. Local/embedded mode has no hosted Auto router, so surface the
              // provider quota error and let the user choose/connect a local model.
              const autoSwapOnQuotaLimitEnabled =
                settingsManager.getSetting("autoSwapOnQuotaLimit") !== false;
              const supportsHostedAutoQuotaFallback =
                !getBackend().capabilities.localModelCatalog;
              const isQuotaLimit = isQuotaLimitErrorDetail(
                detailFromRun ?? fallbackError,
              );
              const alreadyOnTempAuto =
                tempModelOverrideRef.current === TEMP_QUOTA_OVERRIDE_MODEL;
              const canAttemptQuotaAutoSwap =
                autoSwapOnQuotaLimitEnabled &&
                supportsHostedAutoQuotaFallback &&
                isQuotaLimit &&
                !alreadyOnTempAuto &&
                !quotaAutoSwapAttemptedRef.current;

              if (canAttemptQuotaAutoSwap) {
                quotaAutoSwapAttemptedRef.current = true;
                setTempModelOverride(TEMP_QUOTA_OVERRIDE_MODEL);

                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    "Quota limit reached; temporarily switching to Auto and continuing...",
                  ],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();

                currentInput = [
                  ...currentInput,
                  {
                    type: "message",
                    role: "user",
                    content: "Keep going.",
                  },
                ];

                buffersRef.current.byId.delete(statusId);
                buffersRef.current.order = buffersRef.current.order.filter(
                  (id: string) => id !== statusId,
                );
                refreshDerived();

                buffersRef.current.interrupted = false;
                continue;
              }

              // Empty LLM response retry (e.g. Opus 4.6 occasionally returns no content).
              // Retry 1: same input unchanged. Retry 2: append system reminder nudging the model.
              if (
                isEmptyResponseRetryable(
                  stopReasonToHandle === "llm_api_error"
                    ? "llm_error"
                    : undefined,
                  detailFromRun,
                  emptyResponseRetriesRef.current,
                  EMPTY_RESPONSE_MAX_RETRIES,
                )
              ) {
                emptyResponseRetriesRef.current += 1;
                const attempt = emptyResponseRetriesRef.current;
                const delayMs = getRetryDelayMs({
                  category: "empty_response",
                  attempt,
                });

                // Only append a nudge on the last attempt
                if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
                  currentInput = [
                    ...currentInput,
                    {
                      type: "message" as const,
                      role: "user" as const,
                      content: `<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>`,
                      otid: randomUUID(),
                    },
                  ];
                }

                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    `Empty LLM response, retrying (attempt ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES})...`,
                  ],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();

                await new Promise((resolve) => setTimeout(resolve, delayMs));

                buffersRef.current.byId.delete(statusId);
                buffersRef.current.order = buffersRef.current.order.filter(
                  (id: string) => id !== statusId,
                );
                refreshDerived();

                // Empty-response retry starts a new request/run, so refresh OTIDs.
                currentInput = refreshInputOtidsForNewRequest(currentInput);
                buffersRef.current.interrupted = false;
                continue;
              }

              // Check if this is a retriable error (transient LLM API error)
              const retriable = await isRetriableError(
                stopReasonToHandle,
                lastRunId,
                detailFromRun ?? latestErrorText ?? fallbackError,
              );

              if (
                retriable &&
                llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
              ) {
                // Do NOT replay the same run for terminal post-stream errors
                // (e.g. llm_api_error). A retry should create a new run.

                llmApiErrorRetriesRef.current += 1;
                const attempt = llmApiErrorRetriesRef.current;

                const delayMs = getRetryDelayMs({
                  category: "transient_provider",
                  attempt,
                  detail: detailFromRun ?? fallbackError,
                });

                // Log the error that triggered the retry
                telemetry.trackError(
                  "retry_post_stream_error",
                  formatTelemetryErrorMessage(
                    detailFromRun ||
                      fallbackError ||
                      `Stream stopped: ${stopReasonToHandle}`,
                  ),
                  "post_stream_retry",
                  {
                    modelId: currentModelId || undefined,
                    runId: lastRunId ?? undefined,
                  },
                );

                // Show subtle grey status message (skip for silently-retried errors)
                debugLog(
                  "retry",
                  "Post-stream retry (run=%s, stop=%s): %s",
                  lastRunId ?? "unknown",
                  stopReasonToHandle ?? "unknown",
                  detailFromRun || fallbackError || "unknown error",
                );
                const retryStatusMsg = getRetryStatusMessage(detailFromRun);
                const retryStatusId =
                  retryStatusMsg != null ? uid("status") : null;
                if (retryStatusId && retryStatusMsg) {
                  buffersRef.current.byId.set(retryStatusId, {
                    kind: "status",
                    id: retryStatusId,
                    lines: [retryStatusMsg],
                  });
                  buffersRef.current.order.push(retryStatusId);
                  refreshDerived();
                }

                // Wait before retry (check abort signal periodically for ESC cancellation)
                let cancelled = false;
                const startTime = Date.now();
                while (Date.now() - startTime < delayMs) {
                  if (
                    abortControllerRef.current?.signal.aborted ||
                    userCancelledRef.current
                  ) {
                    cancelled = true;
                    break;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 100)); // Check every 100ms
                }

                // Remove status message
                if (retryStatusId) {
                  buffersRef.current.byId.delete(retryStatusId);
                  buffersRef.current.order = buffersRef.current.order.filter(
                    (id: string) => id !== retryStatusId,
                  );
                  refreshDerived();
                }

                if (!cancelled) {
                  const backendCapabilities = getBackend().capabilities;
                  const retryFromPersistedLocalState =
                    backendCapabilities.localModelCatalog &&
                    !backendCapabilities.remoteMemfs;
                  currentInput = retryFromPersistedLocalState
                    ? []
                    : refreshInputOtidsForNewRequest(currentInput);
                  highestSeqIdSeen = null;
                  // Reset interrupted flag so retry stream chunks are processed
                  buffersRef.current.interrupted = false;
                  continue;
                }
                // User pressed ESC - fall through to error handling
              }

              // Reset retry counters on non-retriable error (or max retries exceeded)
              llmApiErrorRetriesRef.current = 0;
              emptyResponseRetriesRef.current = 0;
              conversationBusyRetriesRef.current = 0;

              // Mark incomplete tool calls as finished to prevent stuck blinking UI
              markIncompleteToolsAsCancelled(
                buffersRef.current,
                true,
                "stream_error",
              );

              // If we have a client-side stream error with no run_id, show it directly.
              // When lastRunId is present, prefer the richer server-side error details below.
              if (fallbackError && !lastRunId) {
                setNetworkPhase("error");
                setExecutionPhase(null);
                const formattedFallback = formatErrorDetails(
                  fallbackError,
                  agentIdRef.current,
                );
                const errorMsg = `Stream error: ${formattedFallback}`;
                appendError(errorMsg, {
                  errorType: "FallbackError",
                  errorMessage: formatTelemetryErrorMessage(fallbackError),
                  context: "message_stream",
                });
                appendError(ERROR_FEEDBACK_HINT, true);

                if (lastDequeuedMessageRef.current) {
                  setRestoredInput(lastDequeuedMessageRef.current);
                  lastDequeuedMessageRef.current = null;
                }

                setStreaming(false);
                sendDesktopNotification("Stream error", "error"); // Notify user of error
                refreshDerived();
                resetTrajectoryBases();
                return;
              }

              // Shared telemetry options for the primary error appendError call.
              // The first appendError in each branch carries the telemetry event;
              // subsequent hint lines pass `true` to skip duplicate tracking.
              const errorTelemetryBase = {
                errorType: stopReasonToHandle || "unknown_stop_reason",
                context: "message_stream" as const,
                runId: lastRunId ?? undefined,
              };

              // Fetch error details from the run if available (server-side errors)
              if (lastRunId) {
                try {
                  const run = await getBackend().retrieveRun(lastRunId);

                  // Check if run has error information in metadata
                  if (run.metadata?.error) {
                    const errorData = run.metadata.error as {
                      type?: string;
                      message?: string;
                      detail?: string;
                    };

                    const serverErrorDetail =
                      errorData.detail || errorData.message || null;

                    // Pass structured error data to our formatter
                    const errorObject = {
                      error: {
                        error: errorData,
                        run_id: lastRunId,
                      },
                    };
                    const errorDetails = formatErrorDetails(
                      errorObject,
                      agentIdRef.current,
                    );

                    // Encrypted content errors are self-explanatory (include /clear advice)
                    // — skip the generic "Something went wrong?" hint
                    appendError(errorDetails, {
                      ...errorTelemetryBase,
                      errorMessage: formatTelemetryErrorMessage(
                        serverErrorDetail ||
                          `Stream stopped with reason: ${stopReasonToHandle}`,
                      ),
                    });

                    if (
                      !isEncryptedContentError(errorObject) &&
                      !(
                        serverErrorDetail &&
                        isProviderStreamDisconnectErrorText(serverErrorDetail)
                      )
                    ) {
                      // Show appropriate error hint based on stop reason
                      appendError(
                        getErrorHintForStopReason(
                          stopReasonToHandle,
                          currentModelId,
                          llmConfigRef.current?.model_endpoint_type,
                        ),
                        true,
                      );
                    }
                  } else {
                    // No error metadata, show generic error with run info
                    appendError(
                      `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`,
                      {
                        ...errorTelemetryBase,
                        errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                      },
                    );

                    // Show appropriate error hint based on stop reason
                    appendError(
                      getErrorHintForStopReason(
                        stopReasonToHandle,
                        currentModelId,
                        llmConfigRef.current?.model_endpoint_type,
                      ),
                      true,
                    );
                  }
                } catch (_e) {
                  // If we can't fetch error details, show generic error
                  appendError(
                    `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})\n(Unable to fetch additional error details from server)`,
                    {
                      ...errorTelemetryBase,
                      errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                    },
                  );

                  // Show appropriate error hint based on stop reason
                  appendError(
                    getErrorHintForStopReason(
                      stopReasonToHandle,
                      currentModelId,
                      llmConfigRef.current?.model_endpoint_type,
                    ),
                    true,
                  );

                  // Restore dequeued message to input on error
                  if (lastDequeuedMessageRef.current) {
                    setRestoredInput(lastDequeuedMessageRef.current);
                    lastDequeuedMessageRef.current = null;
                  }
                  // Other queued entries remain available for later turns.

                  setStreaming(false);
                  sendDesktopNotification();
                  refreshDerived();
                  resetTrajectoryBases();
                  return;
                }
              } else {
                // No run_id available - but this is unusual since errors should have run_ids
                appendError(
                  `An error occurred during agent execution\n(stop_reason: ${stopReason})`,
                  {
                    ...errorTelemetryBase,
                    errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                  },
                );

                // Show appropriate error hint based on stop reason
                appendError(
                  getErrorHintForStopReason(
                    stopReasonToHandle,
                    currentModelId,
                    llmConfigRef.current?.model_endpoint_type,
                  ),
                  true,
                );
              }

              // Restore dequeued message to input on error
              if (lastDequeuedMessageRef.current) {
                setRestoredInput(lastDequeuedMessageRef.current);
                lastDequeuedMessageRef.current = null;
              }
              // Other queued entries remain available for later turns.

              setStreaming(false);
              sendDesktopNotification("Execution error", "error"); // Notify user of error
              refreshDerived();
              resetTrajectoryBases();
              return;
            }
          } catch (e) {
            outcome = reportAdmittedRunError({
              error: e,
              agentId: agentIdRef.current,
              appendError,
              buffers: buffersRef.current,
              runId: currentRunId,
              lastDequeuedMessageRef,
              setRestoredInput,
              setStreaming,
              refreshDerived,
              resetTrajectoryBases,
            });
          }
        };

        await runAdmittedTurn();
        return { type: "admitted", outcome };
      } catch (e) {
        if (!admitted) {
          wakeAfterFinish = false;
          reportConversationPreparationError(e, appendError);
          return { type: "not_admitted", reason: "prepare_error" };
        }
        outcome = "error";
        reportPostAdmissionSetupError({
          error: e,
          agentId: agentIdRef.current,
          appendError,
          runId: currentRunId,
          ownsController:
            abortControllerRef.current === turnAbortController &&
            myGeneration === conversationGenerationRef.current,
          setStreaming,
          refreshDerived,
          resetTrajectoryBases,
        });
        return { type: "admitted", outcome };
      } finally {
        if (admitted && !preserveTranscriptStartForApproval) {
          pendingTranscriptStartLineIndexRef.current = null;
        }

        finishTuiTurn({
          isStale: myGeneration !== conversationGenerationRef.current,
          turnAbortController,
          abortControllerRef,
          processingConversationRef,
          userCancelledRef,
          setInterruptRequested,
          queueLength: () =>
            wakeAfterFinish ? (tuiQueueRef.current?.length ?? 0) : 0,
          bumpDequeueEpoch: () => setDequeueEpoch((e: number) => e + 1),
        });
        if (processingConversationRef.current === 0) {
          setAdmissionPreparing(false);
        }
      }
    },
    [
      appendError,
      refreshDerived,
      refreshDerivedThrottled,
      setAdmissionPreparing,
      setStreaming,
      setConversationSummary,
      currentModelId,
      updateStreamingOutput,
      needsEagerApprovalCheck,
      queueApprovalResults,
      appendTaskNotificationEvents,
      clearApprovalToolContext,
      openTrajectorySegment,
      syncTrajectoryTokenBase,
      syncTrajectoryElapsedBase,
      closeTrajectorySegment,
      resetTrajectoryBases,
      setUiPermissionMode,
      prepareScopedToolExecutionContext,
      maybeStreamSyntheticNoModelResponse,
      modAdapter,
    ],
  );

  return processConversation;
}
