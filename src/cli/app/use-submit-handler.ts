// src/cli/app/useSubmitHandler.ts

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import {
  ensureMemoryFilesystemDirs,
  getScopedMemoryFilesystemRoot,
} from "@/agent/memory-filesystem";
import {
  getActiveMemoryDirectory,
  isActiveMemfsEnabled,
} from "@/agent/memory-runtime";
import { buildReflectionMemoryScope } from "@/agent/memory-worktree";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { detectPersonalityFromPersonaFile } from "@/agent/personality";
import type { PersonalityId } from "@/agent/personality-presets";
import { recordSessionEnd } from "@/agent/session-history";
import type { SessionStats } from "@/agent/stats";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import type { CustomCommand } from "@/cli/commands/custom";
import {
  handleModsCommand,
  parseModsGenerateEnvCommand,
} from "@/cli/commands/mods";
import type { CommandHandle } from "@/cli/commands/runner";
import { validateAgentName } from "@/cli/components/PinDialog";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import {
  CHDIR_USAGE,
  parseChdirCommand,
  resolveChdirTarget,
} from "@/cli/helpers/chdir-command";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { resetContextHistory } from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import { buildDoctorMessage } from "@/cli/helpers/doctor-command";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import {
  buildInitMessage,
  gatherInitGitContext,
} from "@/cli/helpers/init-command";
import { buildLogoutSuccessMessage } from "@/cli/helpers/logout-message";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "@/cli/helpers/paste-registry";
import { buildContentFromQueueItems } from "@/cli/helpers/queued-message-parts";
import { resolveReasoningTabToggleCommand } from "@/cli/helpers/reasoning-tab-toggle";
import {
  buildReflectionArenaChoiceQuestions,
  finalizeReflectionArenaChoice,
  formatReflectionArenaAwaitingChoice,
  launchReflectionArena,
  loadReflectionArenaRun,
  REFLECTION_ARENA_MODEL_A_DEFAULT,
  type ReflectionArenaChoice,
  type ReflectionArenaChoiceQuestion,
  sampleReflectionArenaComparisonModel,
  startReflectionArenaRun,
} from "@/cli/helpers/reflection-arena";
import { finalizeMultiReflectionCompletion } from "@/cli/helpers/reflection-completion";
import {
  AUTO_REFLECTION_DESCRIPTION,
  finalizeReflectionMemoryWorktreeLaunch,
  getReflectionLaunchSkippedMessage,
  getReflectionMergeLaunchOptions,
  launchReflectionSubagent,
  prepareReflectionMemoryWorktreeLaunch,
  releaseReflectionLaunch,
  tryReserveReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import {
  buildAutoReflectionPayload,
  buildMultiReflectionPayload,
  buildReflectionAutoPayload,
  buildReflectionSelectorPrompt,
  readReflectionAutoSelection,
} from "@/cli/helpers/reflection-transcript";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  estimateSystemTokens,
  setSystemPromptDoctorState,
} from "@/cli/helpers/system-prompt-warning.ts";
import {
  buildModCommandPrompt,
  parseModCommandArgv,
  parseModSlashCommand,
  runModCommandWithTimeout,
} from "@/cli/mods/command-runtime";
import type {
  ModCommandContext,
  ModConversationCloseReason,
} from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { experimentManager } from "@/experiments/manager";
import {
  runPreCompactHooks,
  runSessionStartHooks,
  runUserPromptSubmitHooks,
} from "@/hooks";
import { createModConversationHandle } from "@/mods/conversation-handle";
import type { QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import {
  enqueueMemoryGitSyncReminder,
  markPostCompactionContextRemindersPending,
  markSecretsInfoReminderPending,
  type SharedReminderState,
} from "@/reminders/state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { debugLog, debugWarn } from "@/utils/debug";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";
import { switchCurrentRuntimeWorkingDirectory } from "@/websocket/listener/cwd-change";

import { shouldSlashCommandBypassQueue } from "./command-routing";
import { buildTextParts } from "./content-parts";
import { createClientOtid, uid } from "./ids";
import {
  prepareTuiSubmit,
  type QueuedApprovalInputPlan,
} from "./prepare-tui-submit";
import { saveLastSessionBeforeExit } from "./session";
import { handleConnectionCommand } from "./submit-connection-commands";
import { handleDiagnosticsCommand } from "./submit-diagnostics-commands";
import { handleNavigationCommand } from "./submit-navigation-commands";
import { handleProfileCommand } from "./submit-profile-commands";
import type {
  ActiveOverlay,
  AppCommandRunner,
  ProcessConversation,
  StaticItem,
  TuiSubmitResult,
} from "./types";

type BashCommandCacheEntry = {
  input: string;
  output: string;
};

type PendingGitReminder = {
  dirty: boolean;
  aheadOfRemote: boolean;
  summary: string;
};

type ProfileConfirmPending = {
  name: string;
  agentId: string;
  cmdId: string;
};

type WorktreeDiffSelectorPending = {
  worktrees: import("@/web/worktree-diff-list").WorktreeDiffOption[];
};

type ModelSelectorOptions = {
  filterProvider?: string;
  forceRefresh?: boolean;
};

export type TuiSubmitAttemptOptions = {
  /** Original native queue items selected by peekQueueBatch. */
  queueItems?: readonly QueueItem[];
  /** Generation/scope captured before the dequeue attempt began. */
  submissionGeneration?: number;
  submissionConversationId?: string;
  /** Synchronous effect applied inside the loop's admission commit. */
  onAdmitted?: () => void;
};

async function findCustomCommandByName(
  commandName: string,
): Promise<CustomCommand | undefined> {
  const { findCustomCommand } = await import("@/cli/commands/custom.js");
  return findCustomCommand(commandName);
}

type SubmitHandlerContext = {
  agentDescription: string | null;
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentLastRunAt: string | null;
  agentName: string | null;
  agentState: AgentState | null | undefined;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  bashCommandCacheRef: MutableRefObject<BashCommandCacheEntry[]>;
  buffersRef: MutableRefObject<Buffers>;
  checkPendingApprovalsForSlashCommand: () => Promise<
    { blocked: true } | { blocked: false }
  >;
  commandRunner: AppCommandRunner;
  commandRunning: boolean;
  peekQueuedApprovalInputForCurrentConversation: (
    otid?: string,
  ) => QueuedApprovalInputPlan | null;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationId: string;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandle: string | null;
  currentModelId: string | null;
  currentModelLabel: string | null;
  currentModelProvider: string | null;
  effectiveContextWindowSize: number | undefined;
  emittedIdsRef: MutableRefObject<Set<string>>;
  modAdapter: LocalModAdapter;
  firstUserQueryRef: MutableRefObject<string | null>;
  flushPendingReasoningEffort: () => Promise<void>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  generateConversationTitle: () => Promise<string | null>;
  handleAgentSelect: (
    targetAgentId: string,
    opts?: {
      profileName?: string;
      conversationId?: string;
      commandId?: string;
    },
  ) => Promise<void>;
  handleBtwCommand: (question: string) => Promise<void>;
  handleExit: () => Promise<void>;
  hasBackfilledRef: MutableRefObject<boolean>;
  isAgentBusy: () => boolean;
  isExecutingTool: boolean;
  lastDequeuedMessageRef: MutableRefObject<string | null>;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  maybeCarryOverActiveConversationModel: (
    targetConversationId: string,
  ) => Promise<void>;
  needsEagerApprovalCheck: boolean;
  pendingApprovals: ApprovalRequest[];
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  pendingGitReminderRef: MutableRefObject<PendingGitReminder | null>;
  processConversation: ProcessConversation;
  processConversationWithQueuedApprovals: ProcessConversation;
  profileConfirmPending: ProfileConfirmPending | null;
  projectDirectory: string;
  queuedSystemPromptRecompileByConversationRef: MutableRefObject<Set<string>>;
  reasoningTabCycleEnabled: boolean;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  refreshDerived: () => void;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  resetDeferredToolCallCommits: () => void;
  resetPendingReasoningCycle: () => void;
  resetTrajectoryBases: () => void;
  runEndHooks: (reason?: ModConversationCloseReason) => Promise<void>;
  sessionHooksRanRef: MutableRefObject<boolean>;
  sessionStartFeedbackRef: MutableRefObject<string[]>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  setAgentDescription: Dispatch<SetStateAction<string | null>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setConversationSummary: (summary: string | null) => void;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setCurrentPersonalityId: Dispatch<SetStateAction<PersonalityId | null>>;
  setDequeueEpoch: Dispatch<SetStateAction<number>>;
  setFeedbackPrefill: Dispatch<SetStateAction<string>>;
  setHasConversationModelOverride: (value: boolean) => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  markLocalModelsAvailable: () => void;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  setNeedsEagerApprovalCheck: Dispatch<SetStateAction<boolean>>;
  setProfileConfirmPending: Dispatch<
    SetStateAction<ProfileConfirmPending | null>
  >;
  setReflectionArenaChoicePending: Dispatch<
    SetStateAction<{
      questions: ReflectionArenaChoiceQuestion[];
      runId: string;
    } | null>
  >;
  setWorktreeDiffSelectorPending: Dispatch<
    SetStateAction<WorktreeDiffSelectorPending | null>
  >;
  setReasoningTabCycleEnabled: Dispatch<SetStateAction<boolean>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: Dispatch<SetStateAction<string>>;
  setTokenStreamingEnabled: Dispatch<SetStateAction<boolean>>;
  setTrajectoryTokenBase: Dispatch<SetStateAction<number>>;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
  shouldAutoGenerateConversationTitleRef: MutableRefObject<boolean>;

  streaming: boolean;
  systemInfoReminderEnabled: boolean;
  systemPromptRecompileByConversationRef: MutableRefObject<
    Map<string, Promise<void>>
  >;
  tokenStreamingEnabled: boolean;
  trajectoryRunTokenStartRef: MutableRefObject<number>;
  trajectoryTokenDisplayRef: MutableRefObject<number>;
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
  updateAgentName: (name: string) => void;
  updateMemorySyncCommand: (
    commandId: string,
    output: string,
    success: boolean,
    input?: string,
    keepRunning?: boolean,
  ) => void;
  userCancelledRef: MutableRefObject<boolean>;
  onReload?: () => Promise<void>;
};

type ReflectCommandArgs =
  | { instruction?: string; kind: "single" }
  | { instruction?: string; kind: "recent"; limit: number }
  | { conversationIds: string[]; instruction?: string; kind: "conversations" }
  | { instruction?: string; kind: "auto" };

type ReflectArenaCommandArgs =
  | {
      instruction?: string;
      kind: "launch";
      modelA?: string;
      modelB?: string;
    }
  | {
      choice: ReflectionArenaChoice;
      kind: "choose";
      notes?: string;
      runId: string;
    }
  | { kind: "resume"; runId: string };

function isReflectCommandFlag(value: string): boolean {
  return (
    value === "--" ||
    value === "--auto" ||
    value === "--conversation" ||
    value === "--instruction" ||
    value === "--instructions" ||
    value === "--recent" ||
    value === "-i" ||
    value.startsWith("--instruction=")
  );
}

function parseReflectArenaCommandArgs(input: string): ReflectArenaCommandArgs {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? "/reflect-arena";
  const parts = parseModCommandArgv(trimmed.slice(command.length).trim());
  if (parts[0] === "choose") {
    const runId = parts[1];
    const rawChoice = parts[2];
    if (!runId || !rawChoice) {
      throw new Error(
        "Usage: /reflect-arena choose <run-id> <1|2|tie> [notes]",
      );
    }
    if (rawChoice !== "1" && rawChoice !== "2" && rawChoice !== "tie") {
      throw new Error(
        "Usage: /reflect-arena choose <run-id> <1|2|tie> [notes]",
      );
    }
    return {
      kind: "choose",
      runId,
      choice: rawChoice,
      notes: parts.slice(3).join(" ").trim() || undefined,
    };
  }
  if (parts[0] === "resume") {
    const runId = parts[1];
    if (!runId) {
      throw new Error("Usage: /reflect-arena resume <run-id>");
    }
    return { kind: "resume", runId };
  }

  let modelA: string | undefined;
  let modelB: string | undefined;
  const instructions: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part === "--model-a") {
      modelA = parts[index + 1];
      if (!modelA) throw new Error("Usage: /reflect-arena --model-a <model>");
      index += 1;
      continue;
    }
    if (part.startsWith("--model-a=")) {
      modelA = part.slice("--model-a=".length).trim();
      if (!modelA) throw new Error("Usage: /reflect-arena --model-a <model>");
      continue;
    }
    if (part === "--model-b") {
      modelB = parts[index + 1];
      if (!modelB) throw new Error("Usage: /reflect-arena --model-b <model>");
      index += 1;
      continue;
    }
    if (part.startsWith("--model-b=")) {
      modelB = part.slice("--model-b=".length).trim();
      if (!modelB) throw new Error("Usage: /reflect-arena --model-b <model>");
      continue;
    }
    if (
      part === "--instruction" ||
      part === "--instructions" ||
      part === "-i"
    ) {
      const instruction = parts
        .slice(index + 1)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena --instruction <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    if (part.startsWith("--instruction=")) {
      const instruction = part.slice("--instruction=".length).trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena --instruction <instruction>");
      }
      instructions.push(instruction);
      continue;
    }
    if (part === "--") {
      const instruction = parts
        .slice(index + 1)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena -- <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    throw new Error(
      "Usage: /reflect-arena [--model-a <model>] [--model-b <model>] [--instruction <instruction>]",
    );
  }

  return {
    kind: "launch",
    modelA,
    modelB,
    instruction: instructions.join("\n").trim() || undefined,
  };
}

function parseReflectCommandArgs(input: string): ReflectCommandArgs {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? "/reflect";
  const parts = parseModCommandArgv(trimmed.slice(command.length).trim());
  if (parts.length === 0) {
    return { kind: "single" };
  }

  let recentLimit: number | null = null;
  const conversationIds: string[] = [];
  const instructions: string[] = [];
  let auto = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (
      part === "--instruction" ||
      part === "--instructions" ||
      part === "-i"
    ) {
      let instructionEnd = index + 1;
      while (instructionEnd < parts.length) {
        const instructionPart = parts[instructionEnd];
        if (!instructionPart || isReflectCommandFlag(instructionPart)) break;
        instructionEnd += 1;
      }
      const instruction = parts
        .slice(index + 1, instructionEnd)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect --instruction <instruction>");
      }
      instructions.push(instruction);
      index = instructionEnd - 1;
      continue;
    }
    if (part.startsWith("--instruction=")) {
      const instruction = part.slice("--instruction=".length).trim();
      if (!instruction) {
        throw new Error("Usage: /reflect --instruction <instruction>");
      }
      instructions.push(instruction);
      continue;
    }
    if (part === "--") {
      const instruction = parts
        .slice(index + 1)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect -- <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    if (part === "--auto") {
      auto = true;
      continue;
    }
    if (part === "--recent") {
      const raw = parts[index + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Usage: /reflect --recent <positive integer>");
      }
      recentLimit = parsed;
      index += 1;
      continue;
    }
    if (part === "--conversation") {
      const conversationId = parts[index + 1];
      if (!conversationId) {
        throw new Error("Usage: /reflect --conversation <conversation-id>");
      }
      conversationIds.push(conversationId);
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: /reflect [--recent N | --conversation <id> ... | --auto] [--instruction <instruction>]",
    );
  }

  const instruction = instructions.join("\n").trim() || undefined;
  const modes = [recentLimit !== null, conversationIds.length > 0, auto].filter(
    Boolean,
  ).length;
  if (modes > 1) {
    throw new Error("Use only one of --recent, --conversation, or --auto.");
  }
  if (auto) {
    return { instruction, kind: "auto" };
  }
  if (recentLimit !== null) {
    return { instruction, kind: "recent", limit: recentLimit };
  }
  if (conversationIds.length > 0) {
    return { conversationIds, instruction, kind: "conversations" };
  }
  return { instruction, kind: "single" };
}

function aliasBareExitCommand(input: string): string {
  if (input === "exit" || input === "quit") return "/exit";
  return input;
}

function commandHandledSubmit(): TuiSubmitResult {
  return { submitted: true, status: "command_handled" };
}

function retainedSubmit(
  admission?: TuiSubmitResult["admission"],
): TuiSubmitResult {
  return {
    submitted: false,
    status: "retained",
    retained: true,
    ...(admission ? { admission } : {}),
  };
}

function adaptSubmitCommandResult(result: {
  submitted: boolean;
}): TuiSubmitResult {
  return result.submitted ? commandHandledSubmit() : retainedSubmit();
}

export function useSubmitHandler(ctx: SubmitHandlerContext) {
  const {
    agentDescription,
    agentId,
    agentIdRef,
    agentLastRunAt,
    agentName,
    agentState,
    agentStateRef,
    appendTaskNotificationEvents,
    bashCommandCacheRef,
    buffersRef,
    checkPendingApprovalsForSlashCommand,
    commandRunner,
    commandRunning,
    peekQueuedApprovalInputForCurrentConversation,
    contextTrackerRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    currentModelHandle,
    currentModelId,
    currentModelLabel,
    currentModelProvider,
    effectiveContextWindowSize,
    emittedIdsRef,
    modAdapter,
    firstUserQueryRef,
    flushPendingReasoningEffort,
    generateConversationDescription,
    generateConversationTitle,
    handleAgentSelect,
    handleBtwCommand,
    handleExit,
    hasBackfilledRef,
    isAgentBusy,
    isExecutingTool,
    lastDequeuedMessageRef,
    llmConfigRef,
    maybeCarryOverActiveConversationModel,
    needsEagerApprovalCheck,
    pendingApprovals,
    pendingConversationSwitchRef,
    pendingGitReminderRef,
    processConversation,
    processConversationWithQueuedApprovals,
    profileConfirmPending,
    projectDirectory,
    queuedSystemPromptRecompileByConversationRef,
    reasoningTabCycleEnabled,
    recoverRestoredPendingApprovals,
    refreshDerived,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetPendingReasoningCycle,
    resetTrajectoryBases,
    runEndHooks,
    sessionHooksRanRef,
    sessionStartFeedbackRef,
    sessionStatsRef,
    openOverlay,
    setAgentDescription,
    setAgentState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationSummary,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentPersonalityId,
    setDequeueEpoch,
    setFeedbackPrefill,
    setHasConversationModelOverride,
    setLines,
    setLlmConfig,
    markLocalModelsAvailable,
    setModelSelectorOptions,
    setNeedsEagerApprovalCheck,
    setProfileConfirmPending,
    setReflectionArenaChoicePending,
    setWorktreeDiffSelectorPending,
    setReasoningTabCycleEnabled,
    setSearchQuery,
    setStaticItems,
    setStaticRenderEpoch,
    setStreaming,
    setThinkingMessage,
    setTokenStreamingEnabled,
    setTrajectoryTokenBase,
    sharedReminderStateRef,
    shouldAutoGenerateConversationTitleRef,

    streaming,
    systemInfoReminderEnabled,
    systemPromptRecompileByConversationRef,
    tokenStreamingEnabled,
    trajectoryRunTokenStartRef,
    trajectoryTokenDisplayRef,
    tuiQueueRef,
    updateAgentName,
    updateMemorySyncCommand,
    userCancelledRef,
    onReload,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: moved from AppCoordinator; dependencies are preserved from the original callback.
  const onSubmit = useCallback(
    async (
      message?: string,
      attempt: TuiSubmitAttemptOptions = {},
    ): Promise<TuiSubmitResult> => {
      const msg = message?.trim() ?? "";
      const queueItems = attempt.queueItems ?? [];
      const hasOverrideContent = queueItems.length > 0;
      // Capture identity and scope before flushPendingReasoningEffort, hooks or
      // any other await. The loop revalidates both before its commit boundary.
      const submissionGeneration =
        attempt.submissionGeneration ?? conversationGenerationRef.current;
      const submissionConversationId =
        attempt.submissionConversationId ?? conversationIdRef.current;
      const { notifications: taskNotifications, cleanedText } =
        extractTaskNotificationsForDisplay(msg);
      const userTextForInput = cleanedText.trim();
      const routedUserText = aliasBareExitCommand(userTextForInput);
      const isSystemOnly =
        taskNotifications.length > 0 && userTextForInput.length === 0;

      // Handle profile load confirmation (Enter to continue)
      if (profileConfirmPending && !msg && !hasOverrideContent) {
        // User pressed Enter with empty input - proceed with loading
        const { name, agentId: targetAgentId, cmdId } = profileConfirmPending;
        const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
        cmd.update({ output: "Loading profile...", phase: "running" });
        setProfileConfirmPending(null);
        await handleAgentSelect(targetAgentId, {
          profileName: name,
          commandId: cmdId,
        });
        return commandHandledSubmit();
      }

      // Cancel profile confirmation if user types something else
      if (profileConfirmPending && msg) {
        const { cmdId, name } = profileConfirmPending;
        const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
        cmd.fail("Cancelled");
        setProfileConfirmPending(null);
        // Continue processing the new message
      }

      if (!msg && !hasOverrideContent) {
        // Empty Enter resumes parked messages and also re-examines a ready
        // batch retained after prepare_error/queue_changed. No polling loop:
        // this explicit user action provides the retry edge.
        const paused = tuiQueueRef.current?.pausedCount ?? 0;
        const ready = tuiQueueRef.current?.readyLength ?? 0;
        if (paused === 0 && ready === 0) return retainedSubmit();
        if (paused > 0) {
          tuiQueueRef.current?.resume();
        }
        userCancelledRef.current = false;
        setDequeueEpoch((e: number) => e + 1);
        return { submitted: true, status: "queued" };
      }

      const isCommand = routedUserText.startsWith("/");
      let userPromptSubmitHookFeedback = "";
      if (isCommand) {
        // Commands must be classified before entering the conversation loop.
        // Normal turns defer these awaits into processConversation.prepare so
        // reservation/controller ownership begins first.
        await flushPendingReasoningEffort();
        const hookResult = await runUserPromptSubmitHooks(
          userTextForInput,
          true,
          agentId,
          conversationIdRef.current,
        );
        if (hookResult.blocked) {
          const feedbackId = uid("status");
          const feedback = hookResult.feedback.join("\n") || "Blocked by hook";
          buffersRef.current.byId.set(feedbackId, {
            kind: "status",
            id: feedbackId,
            lines: [
              `<user-prompt-submit-hook>${feedback}</user-prompt-submit-hook>`,
            ],
          });
          buffersRef.current.order.push(feedbackId);
          refreshDerived();
          return retainedSubmit();
        }
        userPromptSubmitHookFeedback =
          hookResult.feedback.length > 0
            ? `${SYSTEM_REMINDER_OPEN}\n${hookResult.feedback.join("\n")}\n${SYSTEM_REMINDER_CLOSE}`
            : "";
      }

      // Track user input (agent_id automatically added from telemetry.currentAgentId)
      if (!isSystemOnly && userTextForInput.length > 0) {
        telemetry.trackUserInput(
          userTextForInput,
          "user",
          currentModelId || "unknown",
        );
      }

      // Block submission while approvals are pending (input is hidden anyway).
      if (pendingApprovals.length > 0) {
        return retainedSubmit();
      }

      // Release cancellation, but wake dequeue only after the new input is queued.
      userCancelledRef.current = false;

      const isSlashCommand = isCommand;
      const parsedModCommand = isSlashCommand
        ? parseModSlashCommand(routedUserText.trim())
        : null;
      const parsedSlashCommandName = parsedModCommand?.command ?? null;
      const matchedCustomCommand = parsedSlashCommandName
        ? await findCustomCommandByName(parsedSlashCommandName)
        : undefined;
      const matchedModCommand = parsedSlashCommandName
        ? modAdapter.registry?.commands[parsedSlashCommandName]
        : undefined;
      // Interactive/non-state slash commands bypass queueing so menus stay responsive
      // while the agent is busy. Overlay writes are still deferred via queuedOverlayAction.
      const shouldBypassQueue =
        isSlashCommand &&
        shouldSlashCommandBypassQueue(routedUserText, {
          hasCustomCommand: Boolean(matchedCustomCommand),
          ...(matchedModCommand ? { modCommand: matchedModCommand } : {}),
        });

      if (isAgentBusy() && isSlashCommand && !shouldBypassQueue) {
        const attemptedCommand = routedUserText.split(/\s+/)[0] || "/";
        const disabledMessage = `'${attemptedCommand}' is disabled while the agent is running.`;
        const cmd = commandRunner.start(routedUserText, disabledMessage);
        cmd.fail(disabledMessage);
        return commandHandledSubmit(); // Clears input
      }

      if (
        !shouldBypassQueue &&
        (isAgentBusy() ||
          (!hasOverrideContent && (tuiQueueRef.current?.length ?? 0) > 0))
      ) {
        if (hasOverrideContent) {
          // This batch is already in the native queue. A race with another
          // owner retains the original ids/origin/content — never enqueue XML
          // or flattened text as a new user message.
          return retainedSubmit({ type: "not_admitted", reason: "busy" });
        }

        const clientMessageId = createClientOtid();
        tuiQueueRef.current?.enqueue({
          kind: "message",
          source: "user",
          content: buildMessageContentFromDisplay(msg),
          clientMessageId,
          agentId: agentIdRef.current,
          conversationId: submissionConversationId,
        } as Parameters<typeof tuiQueueRef.current.enqueue>[0]);
        if (!isSystemOnly) tuiQueueRef.current?.resume();
        setDequeueEpoch((e: number) => e + 1);
        return { submitted: true, status: "queued" };
      }

      const aliasedMsg = routedUserText;

      // Handle commands (messages starting with "/")
      if (aliasedMsg.startsWith("/")) {
        const trimmed = aliasedMsg.trim();

        // Custom commands and mod commands override built-ins.
        if (matchedCustomCommand) {
          const { substituteArguments, expandBashCommands } = await import(
            "@/cli/commands/custom.js"
          );
          const cmd = commandRunner.start(
            trimmed,
            `Running /${matchedCustomCommand.id}...`,
          );

          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              `Pending approval(s). Resolve approvals before running /${matchedCustomCommand.id}.`,
            );
            return retainedSubmit(); // Keep custom command in input box, user handles approval first
          }

          // Extract arguments (everything after command name)
          const args = trimmed
            .slice(`/${matchedCustomCommand.id}`.length)
            .trim();

          // Build prompt: 1) substitute args, 2) expand bash commands
          let prompt = substituteArguments(matchedCustomCommand.content, args);
          prompt = await expandBashCommands(prompt);

          // Show command in transcript (running phase for visual feedback)
          setCommandRunning(true);

          try {
            // Mark command as finished BEFORE sending to agent
            // (matches /remember pattern - command succeeded in triggering agent)
            cmd.finish("Running custom command...", true);

            // Send prompt to agent
            // NOTE: Unlike /remember, we DON'T append args separately because
            // they're already substituted into the prompt via $ARGUMENTS
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(
                    `${SYSTEM_REMINDER_OPEN}\n${prompt}\n${SYSTEM_REMINDER_CLOSE}`,
                  ),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            // Only catch errors from processConversation setup, not agent execution
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to run command: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        if (parsedModCommand && matchedModCommand) {
          const showInTranscript = matchedModCommand.showInTranscript;
          const shouldLockCommand = !matchedModCommand.runWhenBusy;
          const cmd = showInTranscript
            ? commandRunner.start(
                trimmed,
                `Running /${matchedModCommand.id}...`,
              )
            : null;
          const getFeedbackCommand = () =>
            cmd ??
            commandRunner.start(trimmed, `Running /${matchedModCommand.id}...`);
          if (shouldLockCommand) {
            setCommandRunning(true);
          }

          try {
            const modContext = modAdapter.context;
            const cwd = getCurrentWorkingDirectory();
            const conversation = createModConversationHandle({
              agentId,
              backend: modAdapter.getBackend(),
              conversationId: conversationIdRef.current,
              sendMessageStream: sendMessageStreamWithBackend,
              workingDirectory: cwd,
            });
            const commandContext: ModCommandContext = {
              ...modContext,
              args: parsedModCommand.args,
              argv: parseModCommandArgv(parsedModCommand.args),
              command: parsedModCommand.command,
              conversation: { ...conversation, id: conversationIdRef.current },
              cwd,
              model: {
                ...modContext.model,
                id:
                  currentModelId ??
                  llmConfigRef.current?.model ??
                  modContext.model.id,
              },
              permissionMode: modContext.permissionMode,
              rawInput: trimmed,
            };
            const result = await runModCommandWithTimeout(
              matchedModCommand,
              commandContext,
            );

            if (result.type === "prompt") {
              if (!showInTranscript) {
                getFeedbackCommand().fail(
                  `/${matchedModCommand.id} returned a prompt with showInTranscript: false. Hidden mod commands must return output or handled and own their UI.`,
                );
                return commandHandledSubmit();
              }

              if (matchedModCommand.runWhenBusy && isAgentBusy()) {
                getFeedbackCommand().fail(
                  `/${matchedModCommand.id} returned a prompt while the agent is running. Busy-safe mod commands must handle their own SDK calls or return output.`,
                );
                return commandHandledSubmit();
              }

              const approvalCheck =
                await checkPendingApprovalsForSlashCommand();
              if (approvalCheck.blocked) {
                getFeedbackCommand().fail(
                  `Pending approval(s). Resolve approvals before running /${matchedModCommand.id}.`,
                );
                return retainedSubmit();
              }

              cmd?.finish(`Running /${matchedModCommand.id}...`, true);
              const commandAdmission =
                await processConversationWithQueuedApprovals([
                  {
                    type: "message",
                    role: "user",
                    content: buildTextParts(buildModCommandPrompt(result)),
                    otid: randomUUID(),
                  },
                ]);
              if (commandAdmission.type === "not_admitted") {
                getFeedbackCommand().fail(
                  `Command was retained: ${commandAdmission.reason}`,
                );
                return retainedSubmit(commandAdmission);
              }
            } else if (result.type === "output") {
              getFeedbackCommand().finish(
                result.output,
                result.success ?? true,
              );
            } else {
              cmd?.finish("Handled.", true, true);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            getFeedbackCommand().fail(
              `Failed to run /${matchedModCommand.id}: ${errorDetails}`,
            );
          } finally {
            if (shouldLockCommand) {
              setCommandRunning(false);
            }
          }

          return commandHandledSubmit();
        }

        const modsGenerateEnvCommand = parseModsGenerateEnvCommand(trimmed);
        if (modsGenerateEnvCommand) {
          const args = modsGenerateEnvCommand.args;
          const cmd = commandRunner.start(
            trimmed,
            args
              ? `Starting mod env generation for: ${args}`
              : "Starting mod env generation...",
          );

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /mods generate-env.",
            );
            return retainedSubmit();
          }

          setCommandRunning(true);
          try {
            const { loadRenderedSkillContent, wrapSkillContent } = await import(
              "@/tools/impl/skill"
            );
            const skillContent = await loadRenderedSkillContent(
              "generating-mod-envs",
              {
                agentId,
                allowDisabledModelInvocation: true,
              },
            );
            const request = args
              ? `The user ran \`/mods generate-env ${args}\`. Use the loaded skill to help them generate, review, validate, or improve a mod learning env JSON.`
              : "The user ran `/mods generate-env` without arguments. Use the loaded skill's bare behavior for mod learning env generation.";

            cmd.finish("Running mod env generation...", true);
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(
                    `${wrapSkillContent("generating-mod-envs", skillContent)}\n\n${SYSTEM_REMINDER_OPEN}\n${request}\n${SYSTEM_REMINDER_CLOSE}`,
                  ),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to run /mods generate-env: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        const modsCommand = handleModsCommand(trimmed, {
          commandRunner,
          currentModelId,
          cwd: getCurrentWorkingDirectory(),
        });
        if (modsCommand.handled) {
          return commandHandledSubmit();
        }

        // Special handling for /model command - opens selector
        if (trimmed === "/model") {
          setModelSelectorOptions({}); // Clear any filters from previous connection
          openOverlay(
            "model",
            "/model",
            "Opening model selector...",
            "Models dialog dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /install-github-app command - interactive setup wizard
        if (trimmed === "/install-github-app") {
          if (getBackend().capabilities.localModelCatalog) {
            const cmd = commandRunner.start(
              trimmed,
              "Checking GitHub App installer support...",
            );
            cmd.fail(
              "GitHub App installation is not supported by the local backend.",
            );
            return commandHandledSubmit();
          }
          openOverlay(
            "install-github-app",
            "/install-github-app",
            "Opening GitHub App installer...",
            "GitHub App installer dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /sleeptime command - opens reflection settings
        if (trimmed === "/sleeptime") {
          openOverlay(
            "sleeptime",
            "/sleeptime",
            "Opening sleeptime settings...",
            "Sleeptime settings dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /compaction command - opens compaction mode settings
        if (trimmed === "/compaction") {
          openOverlay(
            "compaction",
            "/compaction",
            "Opening compaction settings...",
            "Compaction settings dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /toolset command - opens selector
        if (trimmed === "/toolset") {
          openOverlay(
            "toolset",
            "/toolset",
            "Opening toolset selector...",
            "Toolset dialog dismissed",
          );
          return commandHandledSubmit();
        }

        if (trimmed === "/experiments") {
          openOverlay(
            "experiment",
            "/experiments",
            "Opening experiments selector...",
            "Experiments dialog dismissed",
          );
          return commandHandledSubmit();
        }

        const [slashCommand, experimentsSubcommand, ...experimentsArgs] =
          trimmed.split(/\s+/);
        if (
          slashCommand === "/experiments" &&
          experimentsSubcommand === "diffs"
        ) {
          const args = experimentsArgs;
          if (args.length > 1) {
            const cmd = commandRunner.start(
              "/experiments",
              "Usage: /experiments diffs [path]",
            );
            cmd.fail("Usage: /experiments diffs [path]");
            return commandHandledSubmit();
          }
          if (!experimentManager.isEnabled("diffs")) {
            const cmd = commandRunner.start(
              "/experiments",
              "Diffs experiment is disabled.",
            );
            cmd.fail("Enable the diffs experiment with /experiments first.");
            return commandHandledSubmit();
          }

          if (!args[0]) {
            const cmd = openOverlay(
              "worktree-diff",
              "/experiments diffs",
              "Loading worktrees...",
              "Worktree diff selector dismissed",
            );
            const { listWorktreeDiffOptions } = await import(
              "@/web/worktree-diff-list"
            );
            listWorktreeDiffOptions()
              .then((worktrees) => {
                setWorktreeDiffSelectorPending({ worktrees });
                cmd.update({ output: "Select a worktree to diff" });
              })
              .catch((err: unknown) => {
                cmd.fail(
                  `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            return commandHandledSubmit();
          }

          const cmd = commandRunner.start(
            "/experiments",
            "Opening worktree diff...",
          );
          const { generateAndOpenDiffViewer } = await import(
            "@/web/generate-diff-viewer"
          );
          generateAndOpenDiffViewer(args[0])
            .then((result) => {
              const fileSummary = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"}`;
              if (result.opened) {
                cmd.finish(`Opened worktree diff (${fileSummary})`, true);
              } else {
                cmd.finish(
                  `Open manually: ${result.filePath} (${fileSummary})`,
                  true,
                );
              }
            })
            .catch((err: unknown) => {
              cmd.finish(
                `Failed to open diff: ${err instanceof Error ? err.message : String(err)}`,
                false,
              );
            });
          return commandHandledSubmit();
        }

        if (trimmed === "/title") {
          if (isAgentBusy()) {
            const cmd = commandRunner.start(
              "/title",
              "Cannot configure title while the agent is running.",
            );
            cmd.fail("Wait for the current turn to finish and try again.");
            return commandHandledSubmit();
          }
          openOverlay(
            "window-title",
            "/title",
            "Opening title configurator...",
            "Title configurator dismissed",
          );
          return commandHandledSubmit();
        }

        if (trimmed === "/reload") {
          if (isAgentBusy()) {
            const cmd = commandRunner.start(
              "/reload",
              "Cannot reload while the agent is running.",
            );
            cmd.fail("Wait for the current turn to finish and try again.");
            return commandHandledSubmit();
          }
          if (onReload) {
            const cmd = commandRunner.start(
              "/reload",
              "Reloading settings and local mods...",
            );
            setCommandRunning(true);
            // Defer the reload to let the command UI render first
            setTimeout(() => {
              void (async () => {
                try {
                  await onReload();
                  cmd.finish("Reloaded settings and local mods", true);
                } catch (error) {
                  const errorDetails = formatErrorDetails(error, agentId);
                  cmd.fail(`Failed: ${errorDetails}`);
                } finally {
                  setCommandRunning(false);
                }
              })();
            }, 0);
          } else {
            const cmd = commandRunner.start("/reload", "Reload not available");
            cmd.fail("Reload is not available in this context");
          }
          return commandHandledSubmit();
        }

        const chdirCommand = parseChdirCommand(trimmed);
        if (chdirCommand) {
          const cmd = commandRunner.start(
            chdirCommand.command,
            "Changing working directory...",
          );
          if (!chdirCommand.pathArg) {
            cmd.fail(CHDIR_USAGE);
            return commandHandledSubmit();
          }

          try {
            const nextWorkingDirectory = await resolveChdirTarget(
              chdirCommand.pathArg,
              getCurrentWorkingDirectory(),
            );
            await switchCurrentRuntimeWorkingDirectory(nextWorkingDirectory);
            sharedReminderStateRef.current.hasSentSessionContext = false;
            sharedReminderStateRef.current.pendingSessionContextReason =
              "cwd_changed";
            cmd.finish(
              `Working directory changed to ${nextWorkingDirectory}`,
              true,
            );
          } catch (error) {
            const errorDetails =
              error instanceof Error ? error.message : String(error);
            cmd.fail(`Failed to change working directory: ${errorDetails}`);
          }
          return commandHandledSubmit();
        }

        // Special handling for /ade command - open agent in browser
        if (trimmed === "/ade") {
          const cmd = commandRunner.start("/ade", "Opening ADE...");

          if (isLocalAgentId(agentId)) {
            cmd.finish(
              `ADE is not available for local backend agents.\n→ ${agentId}`,
              true,
            );
            return commandHandledSubmit();
          }

          const adeUrl = buildChatUrl(agentId, {
            conversationId: conversationIdRef.current,
          });

          // Fire-and-forget browser open
          import("open")
            .then(({ default: open }) => open(adeUrl, { wait: false }))
            .catch(() => {
              // Silently ignore - user can use the URL from the output
            });

          // Always show the URL in case browser doesn't open
          cmd.finish(`Opening ADE...\n→ ${adeUrl}`, true);
          return commandHandledSubmit();
        }

        // Special handling for /system command - opens system prompt selector
        if (trimmed === "/system") {
          openOverlay(
            "system",
            "/system",
            "Opening system prompt selector...",
            "System prompt dialog dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /personality command - opens personality selector
        if (trimmed === "/personality") {
          openOverlay(
            "personality",
            "/personality",
            "Opening personality selector...",
            "Personality selector dismissed",
          );

          if (isActiveMemfsEnabled(agentId)) {
            try {
              const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
              const personaCandidates = [
                join(memoryRoot, "system", "persona.md"),
                join(memoryRoot, "memory", "system", "persona.md"),
              ];
              const personaPath = personaCandidates.find((candidate) =>
                existsSync(candidate),
              );

              if (personaPath) {
                const personaContent = readFileSync(personaPath, "utf-8");
                setCurrentPersonalityId(
                  detectPersonalityFromPersonaFile(personaContent),
                );
              } else {
                setCurrentPersonalityId(null);
              }
            } catch {
              setCurrentPersonalityId(null);
            }
          } else {
            setCurrentPersonalityId(null);
          }

          return commandHandledSubmit();
        }

        // Special handling for /subagents command - opens subagent manager
        if (trimmed === "/subagents") {
          openOverlay(
            "subagent",
            "/subagents",
            "Opening subagent manager...",
            "Subagent manager dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /memory command - opens memory viewer overlay
        if (trimmed === "/memory") {
          openOverlay(
            "memory",
            "/memory",
            "Opening memory viewer...",
            "Memory viewer dismissed",
          );
          return commandHandledSubmit();
        }

        // /palace - open Memory Palace directly in the browser (skips TUI overlay)
        if (trimmed === "/palace") {
          const cmd = commandRunner.start(
            "/palace",
            "Opening Memory Palace...",
          );

          if (!isActiveMemfsEnabled(agentId)) {
            cmd.finish(
              "Memory Palace requires memfs. Run /memfs enable first.",
              false,
            );
            return commandHandledSubmit();
          }

          const { generateAndOpenMemoryViewer } = await import(
            "@/web/generate-memory-viewer"
          );
          const latestContextTokens =
            contextTrackerRef.current.lastContextTokens;
          generateAndOpenMemoryViewer(agentId, {
            agentName: agentName ?? undefined,
            conversationId:
              conversationId !== "default" ? conversationId : undefined,
            contextUsage:
              latestContextTokens > 0
                ? {
                    usedTokens: latestContextTokens,
                    contextWindow: effectiveContextWindowSize ?? 0,
                    model: llmConfigRef.current?.model ?? "unknown",
                  }
                : undefined,
          })
            .then((result) => {
              if (result.opened) {
                cmd.finish("Opened Memory Palace in browser", true);
              } else {
                cmd.finish(`Open manually: ${result.filePath}`, true);
              }
            })
            .catch((err: unknown) => {
              cmd.finish(
                `Failed to open: ${err instanceof Error ? err.message : String(err)}`,
                false,
              );
            });

          return commandHandledSubmit();
        }

        const connectionCommandResult = await handleConnectionCommand(
          msg,
          trimmed,
          {
            agentId,
            buffersRef,
            commandRunner,
            conversationIdRef,
            refreshDerived,
            openOverlay,
            setCommandRunning,
            markLocalModelsAvailable,
            setModelSelectorOptions,
          },
        );
        if (connectionCommandResult) {
          return adaptSubmitCommandResult(connectionCommandResult);
        }

        // Special handling for /help command - opens help dialog
        if (trimmed === "/help") {
          openOverlay(
            "help",
            "/help",
            "Opening help...",
            "Help dialog dismissed",
          );
          return commandHandledSubmit();
        }

        // Special handling for /hooks command - opens hooks manager
        if (trimmed === "/hooks") {
          openOverlay(
            "hooks",
            "/hooks",
            "Opening hooks manager...",
            "Hooks manager dismissed",
          );
          return commandHandledSubmit();
        }

        if (trimmed === "/statusline" || trimmed.startsWith("/statusline ")) {
          const args = trimmed.slice("/statusline".length).trim();
          const cmd = commandRunner.start(
            msg,
            args
              ? `Starting statusline setup for: ${args}`
              : "Starting statusline setup...",
          );

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /statusline.",
            );
            return retainedSubmit();
          }

          setCommandRunning(true);
          try {
            const { loadRenderedSkillContent, wrapSkillContent } = await import(
              "@/tools/impl/skill"
            );
            const skillContent = await loadRenderedSkillContent(
              "customizing-statusline",
              {
                agentId,
                allowDisabledModelInvocation: true,
              },
            );
            const request = args
              ? `The user ran \`/statusline ${args}\`. Use the loaded skill to help them create, edit, or migrate their Letta Code statusline mod.`
              : "The user ran `/statusline` without arguments. Use the loaded skill's bare `/statusline` behavior.";

            cmd.finish("Running statusline setup...", true);
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(
                    `${wrapSkillContent("customizing-statusline", skillContent)}\n\n${SYSTEM_REMINDER_OPEN}\n${request}\n${SYSTEM_REMINDER_CLOSE}`,
                  ),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to run statusline setup: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        const diagnosticsCommandResult = await handleDiagnosticsCommand(
          trimmed,
          {
            agentId,
            agentIdRef,
            commandRunner,
            contextTrackerRef,
            conversationIdRef,
            currentModelHandle,
            currentModelId,
            effectiveContextWindowSize,
            llmConfigRef,
            sessionStatsRef,
            setAgentState,
            setCommandRunning,
            setConversationOverrideContextWindowLimit,
            setConversationOverrideModelSettings,
            setHasConversationModelOverride,
            setLlmConfig,
          },
        );
        if (diagnosticsCommandResult) {
          return adaptSubmitCommandResult(diagnosticsCommandResult);
        }

        // Special handling for /recompile command - recompile agent + current conversation
        if (trimmed === "/recompile") {
          const cmd = commandRunner.start(
            trimmed,
            "Recompiling agent and conversation...",
          );

          setCommandRunning(true);

          try {
            const currentConversationId = conversationIdRef.current;
            const { recompileAgentSystemPrompt } = await import(
              "@/agent/modify"
            );
            const compiledSystemPrompt = await recompileAgentSystemPrompt(
              currentConversationId,
              agentId,
            );
            setSystemPromptDoctorState(
              agentId,
              estimateSystemTokens(compiledSystemPrompt),
            );

            cmd.finish(
              [
                "Recompiled current agent and conversation.",
                "(warning: this will evict the cache and increase costs)",
              ].join("\n"),
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        // Special handling for /exit command - exit without stats
        if (trimmed === "/exit") {
          const cmd = commandRunner.start(trimmed, "See ya!");
          cmd.finish("See ya!", true);
          handleExit();
          return commandHandledSubmit();
        }

        // Special handling for /login command - sign in with Letta
        if (trimmed === "/login") {
          openOverlay("login", "/login", "Opening login...", "Login dismissed");
          return commandHandledSubmit();
        }

        // Special handling for /logout command
        if (trimmed === "/logout") {
          if (isAgentBusy()) {
            const cmd = commandRunner.start(
              "/logout",
              "Cannot log out while the agent is running.",
            );
            cmd.fail("Wait for the current turn to finish and try again.");
            return commandHandledSubmit();
          }

          const cmd = commandRunner.start(msg.trim(), "Logging out...");

          setCommandRunning(true);

          try {
            const { settingsManager } = await import("@/settings-manager");
            const currentSettings =
              await settingsManager.getSettingsWithSecureTokens();
            const hasEnvApiKey = Boolean(process.env.LETTA_API_KEY);
            const hasStoredCloudAuth = Boolean(
              currentSettings.refreshToken ||
                currentSettings.env?.LETTA_API_KEY,
            );

            if (!hasEnvApiKey && !hasStoredCloudAuth) {
              cmd.finish(
                "Already logged out. Run /login to sign in with Letta.",
                true,
              );
              return commandHandledSubmit();
            }

            const currentAgentId = agentIdRef.current;
            const currentConversationId =
              conversationIdRef.current ?? "default";
            const currentAgentIsLocal = isLocalAgentId(currentAgentId);

            // Revoke refresh token on server if we have one
            if (currentSettings.refreshToken) {
              const { revokeToken } = await import("@/auth/oauth");
              await revokeToken(currentSettings.refreshToken);
            }

            // Clear all credentials including secrets
            await settingsManager.logout();

            // Logged out while already using a local agent → stay in place.
            if (currentAgentIsLocal) {
              const localAgentLabel = agentName ?? currentAgentId;
              const baseMessage = `Logged out successfully. You're still using your local agent ${localAgentLabel}.`;
              cmd.finish(
                hasEnvApiKey
                  ? `${baseMessage}\n\n${buildLogoutSuccessMessage(true)}`
                  : baseMessage,
                true,
              );
              refreshDerived();
              return commandHandledSubmit();
            }

            cmd.finish(buildLogoutSuccessMessage(hasEnvApiKey), true);

            saveLastSessionBeforeExit(currentConversationId);

            // Track session end explicitly (before exit) with stats
            const stats = sessionStatsRef.current.getSnapshot();
            telemetry.trackSessionEnd(stats, "logout");

            // Record session to local history file
            try {
              recordSessionEnd(
                agentId,
                telemetry.getSessionId(),
                stats,
                {
                  project: projectDirectory,
                  model: currentModelLabel ?? "",
                  provider: currentModelProvider ?? "",
                },
                undefined,
                {
                  messageCount: telemetry.getMessageCount(),
                  toolCallCount: telemetry.getToolCallCount(),
                  exitReason: "logout",
                },
              );
            } catch {
              // Non-critical, don't fail the exit
            }

            // Flush telemetry before exit
            await telemetry.flush();

            // No valid local session to return to after logging out of cloud.
            // Exit after a brief delay to show the message.
            setTimeout(() => process.exit(0), 500);
          } catch (error) {
            let errorOutput = formatErrorDetails(error, agentId);

            // Add helpful tip for summarization failures
            if (errorOutput.includes("Summarization failed")) {
              errorOutput +=
                "\n\nTip: Use /clear instead to clear the current message buffer.";
            }

            cmd.fail(`Failed: ${errorOutput}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /stream command - toggle and save
        if (msg.trim() === "/stream") {
          const newValue = !tokenStreamingEnabled;

          // Immediately add command to transcript with "running" phase and loading message
          const cmd = commandRunner.start(
            msg.trim(),
            `${newValue ? "Enabling" : "Disabling"} token streaming...`,
          );

          // Lock input during async operation
          setCommandRunning(true);

          try {
            setTokenStreamingEnabled(newValue);

            // Save to settings
            const { settingsManager } = await import("@/settings-manager");
            settingsManager.updateSettings({ tokenStreaming: newValue });

            // Update the same command with final result
            cmd.finish(
              `Token streaming ${newValue ? "enabled" : "disabled"}`,
              true,
            );
          } catch (error) {
            // Mark command as failed
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            // Unlock input
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /reasoning-tab command - opt-in toggle for Tab tier cycling
        if (
          trimmed === "/reasoning-tab" ||
          trimmed.startsWith("/reasoning-tab ")
        ) {
          const resolution = resolveReasoningTabToggleCommand(
            trimmed,
            reasoningTabCycleEnabled,
          );
          if (!resolution) {
            return retainedSubmit();
          }
          const cmd = commandRunner.start(
            trimmed,
            "Updating reasoning Tab shortcut...",
          );

          setCommandRunning(true);

          try {
            if (resolution.kind === "status") {
              cmd.finish(resolution.message, true);
              return commandHandledSubmit();
            }

            if (resolution.kind === "invalid") {
              cmd.fail(resolution.message);
              return commandHandledSubmit();
            }

            setReasoningTabCycleEnabled(resolution.enabled);
            settingsManager.updateSettings({
              reasoningTabCycleEnabled: resolution.enabled,
            });

            cmd.finish(resolution.message, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        // Special handling for /new command - start new conversation
        const newMatch = msg.trim().match(/^\/new(?:\s+(.+))?$/);
        if (newMatch) {
          const conversationName = newMatch[1]?.trim();
          const cmd = commandRunner.start(
            msg.trim(),
            conversationName
              ? `Starting new conversation: ${conversationName}...`
              : "Starting new conversation...",
          );

          // New conversations should not inherit pending reasoning-tier debounce.
          resetPendingReasoningCycle();
          setCommandRunning(true);

          const prevConversationId = conversationIdRef.current;

          // Run SessionEnd hooks for current session before starting new one
          await runEndHooks("new");

          try {
            const backend = getBackend();

            // Create a new conversation for the current agent
            const conversation = await backend.createConversation({
              agent_id: agentId,
              ...(conversationName && { summary: conversationName }),
            });

            setConversationAutoTitleEligibility(!conversationName);
            await maybeCarryOverActiveConversationModel(conversation.id);

            // Update conversationId state and ref together so the next turn
            // cannot observe a stale conversation handoff.
            setConversationIdAndRef(conversation.id);

            pendingConversationSwitchRef.current = {
              origin: "new",
              conversationId: conversation.id,
              isDefault: false,
            };

            // Save the new session to settings
            settingsManager.persistSession(agentId, conversation.id);

            // Reset context tokens for new conversation
            resetContextHistory(contextTrackerRef.current);

            // Ensure bootstrap reminders are re-injected for the new conversation.
            resetBootstrapReminderState(true);

            // Re-run SessionStart hooks for new conversation
            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true, // isNewSession
              agentId,
              agentName ?? undefined,
              conversation.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;
            void modAdapter.events.emit(
              "conversation_open",
              {
                agentId,
                agentName: agentName ?? null,
                conversationId: conversation.id,
                previousConversationId: prevConversationId ?? null,
                reason: "new",
              },
              modAdapter.context,
            );

            // Update command with success
            cmd.finish(
              "Started new conversation (use /resume to change convos)",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /fork command - fork the current conversation
        const forkMatch = msg.trim().match(/^\/fork(?:\s+(.+))?$/);
        if (forkMatch) {
          const conversationSummary = forkMatch[1]?.trim();
          const cmd = commandRunner.start(
            msg.trim(),
            conversationSummary
              ? `Forking conversation: ${conversationSummary}...`
              : "Forking conversation...",
          );

          resetPendingReasoningCycle();
          setCommandRunning(true);

          const forkPrevConversationId = conversationIdRef.current;

          await runEndHooks("fork");

          try {
            // For default conversation, pass agent_id
            const isDefault = conversationIdRef.current === "default";
            const backend = getBackend();
            const forked = await backend.forkConversation(
              conversationIdRef.current,
              {
                ...(isDefault ? { agentId } : {}),
              },
            );

            // If we forked with an explicit summary, update it
            if (conversationSummary) {
              await backend.updateConversation(forked.id, {
                summary: conversationSummary,
              });
            }
            setConversationAutoTitleEligibility(false);

            await maybeCarryOverActiveConversationModel(forked.id);

            setConversationIdAndRef(forked.id);

            pendingConversationSwitchRef.current = {
              origin: "fork",
              conversationId: forked.id,
              isDefault: false,
            };

            settingsManager.persistSession(agentId, forked.id, process.cwd());

            resetContextHistory(contextTrackerRef.current);
            resetBootstrapReminderState();

            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true,
              agentId,
              agentName ?? undefined,
              forked.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;
            void modAdapter.events.emit(
              "conversation_open",
              {
                agentId,
                agentName: agentName ?? null,
                conversationId: forked.id,
                previousConversationId: forkPrevConversationId ?? null,
                reason: "fork",
              },
              modAdapter.context,
            );

            cmd.finish(
              "Forked conversation (use /resume to switch back)",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /btw command - fork in background, stream response to ephemeral pane
        const btwMatch = msg.trim().match(/^\/btw\s+(.+)$/);
        if (btwMatch?.[1]) {
          const question = btwMatch[1].trim();

          // Don't await - run in background, user stays in current conversation
          handleBtwCommand(question).catch((err: unknown) => {
            debugWarn("btw", "unhandled error: %s", err);
          });

          return commandHandledSubmit();
        }

        const resetAllAgentMessages = trimmed === "/clear-messages";

        if (trimmed === "/clear" || resetAllAgentMessages) {
          const cmd = commandRunner.start(
            trimmed,
            resetAllAgentMessages
              ? "Resetting agent messages..."
              : "Clearing in-context messages...",
          );

          resetPendingReasoningCycle();
          setCommandRunning(true);

          const clearPrevConversationId = conversationIdRef.current;

          try {
            const backend = getBackend();
            if (
              resetAllAgentMessages &&
              backend.capabilities.localModelCatalog
            ) {
              throw new Error(
                "/clear-messages is unsupported by local backend.",
              );
            }
            await runEndHooks("new");

            // /clear-messages always resets the API agent's message history.
            // /clear only resets when leaving the default API conversation.
            if (
              !backend.capabilities.localModelCatalog &&
              (resetAllAgentMessages || conversationIdRef.current === "default")
            ) {
              const client = await getClient();
              await client.agents.messages.reset(agentId, {
                add_default_initial_messages: false,
              });
            }

            const conversation = await backend.createConversation({
              agent_id: agentId,
            });

            setConversationAutoTitleEligibility(true);
            await maybeCarryOverActiveConversationModel(conversation.id);
            setConversationIdAndRef(conversation.id);
            pendingConversationSwitchRef.current = {
              origin: "clear",
              conversationId: conversation.id,
              isDefault: false,
            };

            settingsManager.persistSession(agentId, conversation.id);
            resetContextHistory(contextTrackerRef.current);
            resetBootstrapReminderState(true);
            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true, // isNewSession
              agentId,
              agentName ?? undefined,
              conversation.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;
            void modAdapter.events.emit(
              "conversation_open",
              {
                agentId,
                agentName: agentName ?? null,
                conversationId: conversation.id,
                previousConversationId: clearPrevConversationId ?? null,
                reason: "new",
              },
              modAdapter.context,
            );

            cmd.finish(
              resetAllAgentMessages
                ? "All agent messages reset"
                : "Agent's in-context messages cleared & moved to conversation history",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /compact command - summarize conversation history
        // Supports: /compact, /compact all, /compact sliding_window, /compact self_compact_all, /compact self_compact_sliding_window
        if (msg.trim().startsWith("/compact")) {
          const parts = msg.trim().split(/\s+/);
          const rawModeArg = parts[1];
          const validModes = [
            "all",
            "sliding_window",
            "self_compact_all",
            "self_compact_sliding_window",
          ];

          if (rawModeArg === "help") {
            const cmd = commandRunner.start(
              msg.trim(),
              "Showing compact help...",
            );
            const output = [
              "/compact help",
              "",
              "Summarize conversation history (compaction).",
              "",
              "USAGE",
              "  /compact                   — compact with default mode",
              "  /compact all               — compact all messages",
              "  /compact sliding_window    — compact with sliding window",
              "  /compact self_compact_all  — compact with self compact all",
              "  /compact self_compact_sliding_window  — compact with self compact sliding window",
              "  /compact help              — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return commandHandledSubmit();
          }

          const modeArg = rawModeArg as
            | "all"
            | "sliding_window"
            | "self_compact_all"
            | "self_compact_sliding_window"
            | undefined;

          // Validate mode if provided
          if (modeArg && !validModes.includes(modeArg)) {
            const cmd = commandRunner.start(
              msg.trim(),
              `Invalid mode "${modeArg}".`,
            );
            cmd.fail(`Invalid mode "${modeArg}". Run /compact help for usage.`);
            return commandHandledSubmit();
          }

          const modeDisplay = modeArg ? ` (mode: ${modeArg})` : "";
          const cmd = commandRunner.start(
            msg.trim(),
            `Compacting conversation history${modeDisplay}...`,
          );

          setCommandRunning(true);

          try {
            // Run PreCompact hooks - can block the compact operation
            const preCompactResult = await runPreCompactHooks(
              undefined, // context_length - not available here
              undefined, // max_context_length - not available here
              agentId,
              conversationIdRef.current,
            );
            if (preCompactResult.blocked) {
              const feedback =
                preCompactResult.feedback.join("\n") || "Blocked by hook";
              cmd.fail(`Compact blocked: ${feedback}`);
              setCommandRunning(false);
              return commandHandledSubmit();
            }

            // If mode changed, server compaction uses that mode's default prompt.
            const compactParams = modeArg
              ? {
                  compaction_settings: {
                    mode: modeArg,
                    model:
                      agentStateRef.current?.compaction_settings?.model?.trim() ||
                      DEFAULT_SUMMARIZATION_MODEL,
                  },
                }
              : undefined;

            const compactConversationId = conversationIdRef.current;
            const compactBody =
              compactConversationId === "default"
                ? {
                    agent_id: agentId,
                    ...(compactParams ?? {}),
                  }
                : compactParams;
            const result = await getBackend().compactConversationMessages(
              compactConversationId,
              compactBody,
            );
            markPostCompactionContextRemindersPending(
              sharedReminderStateRef.current,
            );
            const outputLines = [
              `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
              "",
              `Summary: ${result.summary}`,
            ];
            cmd.finish(outputLines.join("\n"), true);

            // Manual /compact bypasses stream compaction events, so launch
            // reflection directly instead of waiting for post-turn evaluation.
            // Best-effort — never fail the /compact itself.
            try {
              if (
                getReflectionSettings(agentId).trigger === "compaction-event" &&
                isActiveMemfsEnabled(agentId)
              ) {
                if (experimentManager.isEnabled("reflection_arena")) {
                  void launchReflectionArena({
                    agentId,
                    conversationId: compactConversationId,
                    triggerSource: "compaction-event",
                    models: [
                      REFLECTION_ARENA_MODEL_A_DEFAULT,
                      sampleReflectionArenaComparisonModel(),
                    ],
                    feedbackContext: {
                      parentAgentName: agentName,
                      parentAgentDescription: agentDescription,
                      surface: "letta_code_tui",
                    },
                    onReady: (message, readyRun) => {
                      appendTaskNotificationEvents([message]);
                      setReflectionArenaChoicePending({
                        runId: readyRun.runId,
                        questions: buildReflectionArenaChoiceQuestions(
                          readyRun.runId,
                        ),
                      });
                    },
                  }).catch((reflectionError) => {
                    debugLog(
                      "memory",
                      "Skipping post-compaction reflection arena:",
                      reflectionError instanceof Error
                        ? reflectionError.message
                        : String(reflectionError),
                    );
                  });
                } else {
                  void launchReflectionSubagent({
                    agentId,
                    conversationId: compactConversationId,
                    memfsEnabled: isActiveMemfsEnabled(agentId),
                    triggerSource: "compaction-event",
                    description: AUTO_REFLECTION_DESCRIPTION,
                    completionConversationId: () => conversationIdRef.current,
                    recompileByConversation:
                      systemPromptRecompileByConversationRef.current,
                    recompileQueuedByConversation:
                      queuedSystemPromptRecompileByConversationRef.current,
                    onCompletionMessage: (completionMessage) => {
                      appendTaskNotificationEvents([completionMessage]);
                    },
                    feedbackContext: {
                      parentAgentName: agentName,
                      parentAgentDescription: agentDescription,
                      surface: "letta_code_tui",
                    },
                  });
                }
              }
            } catch (reflectionError) {
              debugLog(
                "memory",
                "Skipping post-compaction reflection:",
                reflectionError instanceof Error
                  ? reflectionError.message
                  : String(reflectionError),
              );
            }
            void generateConversationDescription({ force: true });
          } catch (error) {
            const apiError = error as {
              status?: number;
              error?: { detail?: string };
            };
            const detail = apiError?.error?.detail;
            if (
              apiError?.status === 400 &&
              detail?.includes(
                "Summarization failed to reduce the number of messages",
              )
            ) {
              cmd.finish(
                "Compaction run, but the number of messages is the same",
                true,
              );
              return commandHandledSubmit();
            }

            const errorOutput = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorOutput}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /rename command - rename agent or conversation
        if (msg.trim().startsWith("/rename")) {
          const parts = msg.trim().split(/\s+/);
          const subcommand = parts[1]?.toLowerCase();
          const cmd = commandRunner.start(msg.trim(), "Processing rename...");

          if (subcommand === "help") {
            const output = [
              "/rename help",
              "",
              "Rename the current agent or conversation.",
              "",
              "USAGE",
              "  /rename agent [name]      — rename the agent",
              "  /rename convo [name]      — rename a non-default convo, or auto-generate when omitted",
              "  /rename help              — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return commandHandledSubmit();
          }

          if (
            !subcommand ||
            (subcommand !== "agent" && subcommand !== "convo")
          ) {
            cmd.fail("Usage: /rename agent [name] or /rename convo [name]");
            return commandHandledSubmit();
          }

          const newValue = parts.slice(2).join(" ");
          if (subcommand === "agent" && !newValue) {
            cmd.fail("Please provide a name: /rename agent <name>");
            return commandHandledSubmit();
          }

          if (subcommand === "convo") {
            const shouldAutoGenerate = newValue.trim().length === 0;
            cmd.update({
              output: shouldAutoGenerate
                ? "Generating conversation title..."
                : `Renaming conversation to "${newValue}"...`,
              phase: "running",
            });

            setCommandRunning(true);

            try {
              const backend = getBackend();
              if (shouldAutoGenerate) {
                const conversationTitle = await generateConversationTitle();
                if (!conversationTitle) {
                  cmd.fail(
                    "No conversation content available to generate a title",
                  );
                  return commandHandledSubmit();
                }
                await backend.updateConversation(conversationId, {
                  summary: conversationTitle,
                });
                setConversationSummary(conversationTitle);
                setConversationAutoTitleEligibility(false);
                cmd.finish(
                  `Conversation title set to "${conversationTitle}"`,
                  true,
                );
              } else {
                await backend.updateConversation(conversationId, {
                  summary: newValue,
                });
                setConversationSummary(newValue);
                setConversationAutoTitleEligibility(false);
                cmd.finish(`Conversation renamed to "${newValue}"`, true);
              }
            } catch (error) {
              const errorDetails = formatErrorDetails(error, agentId);
              cmd.fail(`Failed: ${errorDetails}`);
            } finally {
              setCommandRunning(false);
            }
            return commandHandledSubmit();
          }

          // Rename agent (default behavior)
          const validationError = validateAgentName(newValue);
          if (validationError) {
            cmd.fail(validationError);
            return commandHandledSubmit();
          }

          cmd.update({
            output: `Renaming agent to "${newValue}"...`,
            phase: "running",
          });

          setCommandRunning(true);

          try {
            await getBackend().updateAgent(agentId, {
              name: newValue,
            });
            updateAgentName(newValue);

            cmd.agentHint = `Your name is now "${newValue}" — acknowledge this and save your new name to memory.`;
            cmd.finish(`Agent renamed to "${newValue}"`, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /description command - update agent description
        if (msg.trim().startsWith("/description")) {
          const parts = msg.trim().split(/\s+/);
          const newDescription = parts.slice(1).join(" ");
          const cmd = commandRunner.start(
            msg.trim(),
            "Updating description...",
          );

          if (newDescription === "help") {
            const output = [
              "/description help",
              "",
              "Update the current agent's description.",
              "",
              "USAGE",
              "  /description <text>   — set agent description",
              "  /description help     — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return commandHandledSubmit();
          }

          if (!newDescription) {
            cmd.fail("Usage: /description <text>");
            return commandHandledSubmit();
          }

          cmd.update({ output: "Updating description...", phase: "running" });

          setCommandRunning(true);

          try {
            await getBackend().updateAgent(agentId, {
              description: newDescription,
            });
            setAgentState((prev: AgentState | null | undefined) =>
              prev ? { ...prev, description: newDescription } : prev,
            );
            setAgentDescription(newDescription);

            cmd.finish(`Description updated to "${newDescription}"`, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Special handling for /agents command - routed through navigation commands.
        const navigationCommandResult = await handleNavigationCommand(trimmed, {
          agentId,
          agentState,
          buffersRef,
          commandRunner,
          contextTrackerRef,
          conversationId,
          emittedIdsRef,
          hasBackfilledRef,
          pendingConversationSwitchRef,
          recoverRestoredPendingApprovals,
          resetBootstrapReminderState,
          resetDeferredToolCallCommits,
          resetTrajectoryBases,
          openOverlay,
          setCommandRunning,
          setConversationAutoTitleEligibility,
          setConversationIdAndRef,
          setLines,
          setSearchQuery,
          setStaticItems,
          setStaticRenderEpoch,
        });
        if (navigationCommandResult) {
          return adaptSubmitCommandResult(navigationCommandResult);
        }

        const profileCommandResult = await handleProfileCommand(msg, trimmed, {
          agentId,
          agentName,
          buffersRef,
          commandRunner,
          handleAgentSelect,
          refreshDerived,
          openOverlay,
          setCommandRunning,
          setProfileConfirmPending,
          updateAgentName,
        });
        if (profileCommandResult) {
          return adaptSubmitCommandResult(profileCommandResult);
        }

        // Special handling for /bg command - show background shell processes
        if (msg.trim() === "/bg") {
          const { backgroundProcesses } = await import(
            "@/tools/impl/process_manager"
          );
          const cmd = commandRunner.start(
            msg.trim(),
            "Checking background processes...",
          );

          let output: string;
          if (backgroundProcesses.size === 0) {
            output = "No background processes running";
          } else {
            const lines = ["Background processes:"];
            for (const [id, proc] of backgroundProcesses) {
              const status =
                proc.status === "running"
                  ? "running"
                  : proc.status === "completed"
                    ? `completed (exit ${proc.exitCode})`
                    : `failed (exit ${proc.exitCode})`;
              lines.push(`  ${id}: ${proc.command} [${status}]`);
            }
            output = lines.join("\n");
          }

          cmd.finish(output, true);
          return commandHandledSubmit();
        }

        // Special handling for /memfs command - manage filesystem-backed memory
        if (trimmed.startsWith("/memfs")) {
          const [, subcommand] = trimmed.split(/\s+/);
          const cmd = commandRunner.start(
            msg.trim(),
            "Processing memfs command...",
          );
          const cmdId = cmd.id;

          if (!subcommand || subcommand === "help") {
            const output = [
              "/memfs help",
              "",
              "Manage filesystem-backed memory.",
              "",
              "USAGE",
              "  /memfs status    — show status",
              "  /memfs enable    — enable filesystem-backed memory",
              "  /memfs sync      — sync blocks and files now",
              "  /memfs reset     — move local memfs to /tmp and recreate dirs",
              "  /memfs help      — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return commandHandledSubmit();
          }

          if (subcommand === "status") {
            // Show status
            const enabled = isActiveMemfsEnabled(agentId);
            let output: string;
            if (enabled) {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              output = `Memory filesystem is enabled.\nPath: ${memoryDir}`;
            } else {
              output =
                "Memory filesystem is disabled. Run `/memfs enable` to enable.";
            }
            cmd.finish(output, true);
            return commandHandledSubmit();
          }

          if (subcommand === "enable") {
            updateMemorySyncCommand(
              cmdId,
              "Enabling memory filesystem...",
              true,
              msg,
              true,
            );
            setCommandRunning(true);

            try {
              const { applyMemfsFlags } = await import(
                "@/agent/memory-filesystem"
              );
              const result = await applyMemfsFlags(agentId, true);
              updateMemorySyncCommand(
                cmdId,
                `Memory filesystem enabled (git-backed).\nPath: ${result.memoryDir}`,
                true,
                msg,
              );
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(
                cmdId,
                `Failed to enable memfs: ${errorText}`,
                false,
                msg,
              );
            } finally {
              setCommandRunning(false);
            }

            return commandHandledSubmit();
          }

          if (subcommand === "sync") {
            // Check if memfs is enabled for this agent
            if (!isActiveMemfsEnabled(agentId)) {
              cmd.fail(
                "Memory filesystem is disabled. Run `/memfs enable` first.",
              );
              return commandHandledSubmit();
            }

            if (getBackend().capabilities.localMemfs) {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              try {
                const { initializeLocalMemoryRepo } = await import(
                  "@/agent/memory-git"
                );
                await initializeLocalMemoryRepo({
                  memoryDir,
                  agentId,
                  authorName: agentName ?? undefined,
                  files: [],
                });
                cmd.finish(
                  `Local backend MemFS is stored locally; no remote sync is required.\nPath: ${memoryDir}`,
                  true,
                );
              } catch (error) {
                const errorText =
                  error instanceof Error ? error.message : String(error);
                cmd.fail(`Failed: ${errorText}`);
              }
              return commandHandledSubmit();
            }

            updateMemorySyncCommand(
              cmdId,
              "Pulling latest memory from server...",
              true,
              msg,
              true,
            );

            setCommandRunning(true);

            try {
              const { pullMemory } = await import("@/agent/memory-git");
              const result = await pullMemory(agentId);
              updateMemorySyncCommand(cmdId, result.summary, true, msg);
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(cmdId, `Failed: ${errorText}`, false);
            } finally {
              setCommandRunning(false);
            }

            return commandHandledSubmit();
          }

          if (subcommand === "reset") {
            updateMemorySyncCommand(
              cmdId,
              "Resetting memory filesystem...",
              true,
              msg,
              true,
            );
            setCommandRunning(true);

            try {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              if (!existsSync(memoryDir)) {
                updateMemorySyncCommand(
                  cmdId,
                  "No local memory filesystem found to reset.",
                  true,
                  msg,
                );
                return commandHandledSubmit();
              }

              const backupDir = join(
                tmpdir(),
                `letta-memfs-reset-${agentId}-${Date.now()}`,
              );
              renameSync(memoryDir, backupDir);

              if (getBackend().capabilities.localMemfs) {
                const { initializeLocalMemoryRepo } = await import(
                  "@/agent/memory-git"
                );
                await initializeLocalMemoryRepo({
                  memoryDir,
                  agentId,
                  authorName: agentName ?? undefined,
                  files: [],
                });
              } else {
                ensureMemoryFilesystemDirs(agentId);
              }

              updateMemorySyncCommand(
                cmdId,
                getBackend().capabilities.localMemfs
                  ? `Memory filesystem reset.\nBackup moved to ${backupDir}\nInitialized a fresh local MemFS repo.`
                  : `Memory filesystem reset.\nBackup moved to ${backupDir}\nRun \`/memfs sync\` to repopulate from API.`,
                true,
                msg,
              );
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(
                cmdId,
                `Failed to reset memfs: ${errorText}`,
                false,
                msg,
              );
            } finally {
              setCommandRunning(false);
            }

            return commandHandledSubmit();
          }

          // Unknown subcommand
          cmd.fail(
            `Unknown subcommand: "${subcommand}". Run /memfs help for usage.`,
          );
          return commandHandledSubmit();
        }

        // /skills - browse available skills overlay
        if (trimmed === "/skills") {
          openOverlay(
            "skills",
            "/skills",
            "Opening skills browser...",
            "Skills browser dismissed",
          );
          return commandHandledSubmit();
        }

        // /skill-creator - enter skill creation mode
        if (
          trimmed === "/skill-creator" ||
          trimmed.startsWith("/skill-creator ")
        ) {
          const [, ...rest] = trimmed.split(/\s+/);
          const description = rest.join(" ").trim();

          const initialOutput = description
            ? `Starting skill creation for: ${description}`
            : "Starting skill creation. I’ll load the creating-skills skill and ask a few questions about the skill you want to build...";

          const cmd = commandRunner.start(msg, initialOutput);

          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /skill-creator.",
            );
            return retainedSubmit(); // Keep /skill in input box, user handles approval first
          }

          setCommandRunning(true);

          try {
            // Import the skill-creation prompt
            const { SKILL_CREATOR_PROMPT } = await import(
              "@/agent/prompt-assets.js"
            );

            // Build system-reminder content for skill creation
            const userDescriptionLine = description
              ? `\n\nUser-provided skill description:\n${description}`
              : "\n\nThe user did not provide a description with /skill-creator. Ask what kind of skill they want to create before proceeding.";

            const skillMessage = `${SYSTEM_REMINDER_OPEN}\n${SKILL_CREATOR_PROMPT}${userDescriptionLine}\n${SYSTEM_REMINDER_CLOSE}`;

            // Mark command as finished before sending message
            cmd.finish(
              "Entered skill creation mode. Answer the assistant’s questions to design your new skill.",
              true,
            );

            // Process conversation with the skill-creation prompt
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(skillMessage),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        // Special handling for /remember command - remember something from conversation
        if (trimmed.startsWith("/remember")) {
          // Extract optional description after `/remember`
          const [, ...rest] = trimmed.split(/\s+/);
          const userText = rest.join(" ").trim();

          const initialOutput = userText
            ? "Storing to memory..."
            : "Processing memory request...";

          const cmd = commandRunner.start(msg, initialOutput);

          // Check for pending approvals before sending (mirrors regular message flow)
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /remember.",
            );
            return retainedSubmit(); // Keep /remember in input box, user handles approval first
          }

          setCommandRunning(true);

          try {
            // Import the remember prompt
            const { REMEMBER_PROMPT } = await import(
              "@/agent/prompt-assets.js"
            );

            // Build system-reminder content for memory request
            const rememberReminder = userText
              ? `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n${SYSTEM_REMINDER_CLOSE}`
              : `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n\nThe user did not specify what to remember. Look at the recent conversation context to identify what they likely want you to remember, or ask them to clarify.\n${SYSTEM_REMINDER_CLOSE}`;
            const rememberParts = userText
              ? buildTextParts(rememberReminder, userText)
              : buildTextParts(rememberReminder);

            // Mark command as finished before sending message
            cmd.finish(
              userText
                ? "Storing to memory..."
                : "Processing memory request from conversation context...",
              true,
            );

            // Process conversation with the remember prompt
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: rememberParts,
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return commandHandledSubmit();
        }

        // Experimental reflection arena - blind A/B reflection model comparison
        if (
          trimmed === "/reflect-arena" ||
          trimmed.startsWith("/reflect-arena ")
        ) {
          const cmd = commandRunner.start(msg, "Preparing reflection arena...");

          if (!experimentManager.isEnabled("reflection_arena")) {
            cmd.fail(
              "Reflection arena is experimental. Enable it with /experiments or LETTA_REFLECTION_ARENA=1.",
            );
            return commandHandledSubmit();
          }

          if (!isActiveMemfsEnabled(agentId)) {
            cmd.fail(
              "Memory filesystem is not enabled. Reflection arena requires MemFS.",
            );
            return commandHandledSubmit();
          }

          try {
            const arenaArgs = parseReflectArenaCommandArgs(trimmed);
            if (arenaArgs.kind === "choose") {
              const { message } = await finalizeReflectionArenaChoice({
                runId: arenaArgs.runId,
                choice: arenaArgs.choice,
                notes: arenaArgs.notes,
                onHfUploadComplete: (message) => {
                  appendTaskNotificationEvents([message]);
                },
                recompileByConversation:
                  systemPromptRecompileByConversationRef.current,
                recompileQueuedByConversation:
                  queuedSystemPromptRecompileByConversationRef.current,
              });
              cmd.finish(message, true);
              return commandHandledSubmit();
            }
            if (arenaArgs.kind === "resume") {
              const run = await loadReflectionArenaRun(arenaArgs.runId);
              if (run.status !== "awaiting_choice") {
                cmd.fail(
                  `Reflection arena run ${arenaArgs.runId} is ${run.status}; expected awaiting_choice.`,
                );
                return commandHandledSubmit();
              }
              setReflectionArenaChoicePending({
                runId: run.runId,
                questions: buildReflectionArenaChoiceQuestions(run.runId),
              });
              cmd.finish(
                `${formatReflectionArenaAwaitingChoice(run)}\n\nResumed reflection arena choice prompt for run ${run.runId}.`,
                true,
              );
              return commandHandledSubmit();
            }

            const reflectionConversationId =
              conversationIdRef.current ?? "default";
            const payload = await buildAutoReflectionPayload(
              agentId,
              reflectionConversationId,
            );
            if (!payload) {
              cmd.fail("No new transcript content to reflect on.");
              return commandHandledSubmit();
            }

            const modelA = arenaArgs.modelA ?? REFLECTION_ARENA_MODEL_A_DEFAULT;
            const modelB =
              arenaArgs.modelB ?? sampleReflectionArenaComparisonModel();

            const run = await startReflectionArenaRun({
              agentId,
              conversationId: reflectionConversationId,
              triggerSource: "manual",
              instruction: arenaArgs.instruction,
              models: [modelA, modelB],
              payload,
              feedbackContext: {
                parentAgentName: agentName,
                parentAgentDescription: agentDescription,
                surface: "letta_code_tui",
              },
              onReady: (message, readyRun) => {
                appendTaskNotificationEvents([message]);
                setReflectionArenaChoicePending({
                  runId: readyRun.runId,
                  questions: buildReflectionArenaChoiceQuestions(
                    readyRun.runId,
                  ),
                });
              },
            });
            cmd.finish(
              `Started reflection arena run ${run.runId}. View the transcript payload here: ${run.payloadPath}`,
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to start reflection arena: ${errorDetails}`);
          }

          return commandHandledSubmit();
        }
        // Special handling for /reflect command - manually launch reflection subagent
        if (trimmed === "/reflect" || trimmed.startsWith("/reflect ")) {
          const cmd = commandRunner.start(msg, "Launching reflection agent...");

          if (!isActiveMemfsEnabled(agentId)) {
            cmd.fail(
              "Memory filesystem is not enabled. Use /remember instead.",
            );
            return commandHandledSubmit();
          }

          let reflectionReserved = false;
          let reflectionReservationDelegated = false;
          const releaseReflectionReservation = () => {
            if (!reflectionReserved) return;
            releaseReflectionLaunch(agentId);
            reflectionReserved = false;
          };

          try {
            const reflectArgs = parseReflectCommandArgs(trimmed);
            const reflectionConversationId =
              conversationIdRef.current ?? "default";

            if (reflectArgs.kind === "single") {
              if (experimentManager.isEnabled("reflection_arena")) {
                const arenaResult = await launchReflectionArena({
                  agentId,
                  conversationId: reflectionConversationId,
                  triggerSource: "manual",
                  instruction: reflectArgs.instruction,
                  models: [
                    REFLECTION_ARENA_MODEL_A_DEFAULT,
                    sampleReflectionArenaComparisonModel(),
                  ],
                  feedbackContext: {
                    parentAgentName: agentName,
                    parentAgentDescription: agentDescription,
                    surface: "letta_code_tui",
                  },
                  onReady: (message, readyRun) => {
                    appendTaskNotificationEvents([message]);
                    setReflectionArenaChoicePending({
                      runId: readyRun.runId,
                      questions: buildReflectionArenaChoiceQuestions(
                        readyRun.runId,
                      ),
                    });
                  },
                });
                if (!arenaResult.launched) {
                  cmd.fail(
                    getReflectionLaunchSkippedMessage(arenaResult.reason) ??
                      "Failed to start reflection arena.",
                  );
                  return commandHandledSubmit();
                }
                cmd.finish(
                  `Started reflection arena run ${arenaResult.run.runId}. View the transcript payload here: ${arenaResult.payloadPath}`,
                  true,
                );
                return commandHandledSubmit();
              }

              const result = await launchReflectionSubagent({
                agentId,
                conversationId: reflectionConversationId,
                memfsEnabled: isActiveMemfsEnabled(agentId),
                triggerSource: "manual",
                description: AUTO_REFLECTION_DESCRIPTION,
                instruction: reflectArgs.instruction,
                completionConversationId: () => conversationIdRef.current,
                recompileByConversation:
                  systemPromptRecompileByConversationRef.current,
                recompileQueuedByConversation:
                  queuedSystemPromptRecompileByConversationRef.current,
                onCompletionMessage: (completionMessage) => {
                  appendTaskNotificationEvents([completionMessage]);
                },
                feedbackContext: {
                  parentAgentName: agentName,
                  parentAgentDescription: agentDescription,
                  surface: "letta_code_tui",
                },
              });

              if (!result.launched) {
                const skippedMessage = getReflectionLaunchSkippedMessage(
                  result.reason,
                );
                if (skippedMessage) {
                  cmd.fail(skippedMessage);
                } else {
                  const errorDetails = formatErrorDetails(
                    result.error ?? "Unknown error",
                    agentId,
                  );
                  cmd.fail(`Failed to start reflection agent: ${errorDetails}`);
                }
                return commandHandledSubmit();
              }

              cmd.finish(
                `Reflecting on the recent conversation. View the transcript here: ${result.payloadPath}`,
                true,
              );
              return commandHandledSubmit();
            }

            if (!tryReserveReflectionLaunch(agentId)) {
              cmd.fail(
                "A reflection agent is already running in the background.",
              );
              return commandHandledSubmit();
            }
            reflectionReserved = true;

            if (reflectArgs.kind === "auto") {
              const autoPayload = await buildReflectionAutoPayload({
                agentId,
                currentConversationId: reflectionConversationId,
                instruction: reflectArgs.instruction,
              });
              if (!autoPayload) {
                releaseReflectionReservation();
                cmd.fail("No transcript candidates found for auto selection.");
                return commandHandledSubmit();
              }

              const { spawnBackgroundSubagentTask } = await import(
                "@/tools/impl/task"
              );
              const { subagentId: selectorSubagentId } =
                spawnBackgroundSubagentTask({
                  subagentType: "reflection",
                  prompt: buildReflectionSelectorPrompt({
                    instruction: reflectArgs.instruction,
                  }),
                  description: "Selecting reflection transcripts",
                  silentCompletion: true,
                  transcriptPath: autoPayload.candidatesPath,
                  parentScope: {
                    agentId,
                    conversationId: reflectionConversationId,
                  },
                  onComplete: async ({ success, error, report }) => {
                    if (!success) {
                      releaseReflectionReservation();
                      appendTaskNotificationEvents([
                        `Automatic reflection selection failed: ${error ?? "selector failed"}`,
                      ]);
                      return;
                    }

                    let finalReflectionSpawned = false;
                    try {
                      const selectedConversations =
                        await readReflectionAutoSelection({
                          selectionReport: report,
                          candidates: autoPayload.candidates,
                        });
                      if (selectedConversations.length === 0) {
                        releaseReflectionReservation();
                        appendTaskNotificationEvents([
                          "Automatic reflection selected no transcript candidates.",
                        ]);
                        return;
                      }

                      const autoReflectionPayload =
                        await buildMultiReflectionPayload({
                          agentId,
                          selectionPolicy: {
                            mode: "auto-selected",
                            selectedConversations,
                            candidatesPath: autoPayload.candidatesPath,
                          },
                          instruction: reflectArgs.instruction,
                        });
                      if (!autoReflectionPayload) {
                        releaseReflectionReservation();
                        appendTaskNotificationEvents([
                          "Automatic reflection selected transcript candidates, but no transcript content was available.",
                        ]);
                        return;
                      }

                      const { worktree, reflectionPrompt } =
                        await prepareReflectionMemoryWorktreeLaunch({
                          agentId,
                          instruction: reflectArgs.instruction,
                        });

                      spawnBackgroundSubagentTask({
                        subagentType: "reflection",
                        prompt: reflectionPrompt,
                        description: "Reflecting on auto-selected transcripts",
                        silentCompletion: true,
                        transcriptPath: autoReflectionPayload.payloadPath,
                        memoryScope: buildReflectionMemoryScope(worktree),
                        parentScope: {
                          agentId,
                          conversationId: reflectionConversationId,
                        },
                        onComplete: async ({
                          success: reflectionSuccess,
                          error: reflectionError,
                          agentId: reflectionAgentId,
                          model: reflectionModel,
                        }) => {
                          try {
                            telemetry.trackReflectionEnd(
                              "manual",
                              reflectionSuccess,
                              {
                                subagentId: reflectionAgentId ?? undefined,
                                conversationId: reflectionConversationId,
                                error: reflectionError,
                                model: reflectionModel,
                              },
                            );
                            const { completionSuccess, completionMessage } =
                              await finalizeReflectionMemoryWorktreeLaunch({
                                worktree,
                                subagentSuccess: reflectionSuccess,
                                subagentError: reflectionError,
                                agentId,
                                conversationId: conversationIdRef.current,
                                subagentAgentId: reflectionAgentId ?? undefined,
                                model: reflectionModel,
                                ...getReflectionMergeLaunchOptions(agentId),
                                telemetryContext: { triggerSource: "manual" },
                                recompileByConversation:
                                  systemPromptRecompileByConversationRef.current,
                                recompileQueuedByConversation:
                                  queuedSystemPromptRecompileByConversationRef.current,
                                logRecompileFailure: (message) =>
                                  debugWarn("memory", message),
                              });
                            await finalizeMultiReflectionCompletion(
                              agentId,
                              autoReflectionPayload.manifest,
                              completionSuccess,
                            );
                            appendTaskNotificationEvents([completionMessage]);
                          } finally {
                            releaseReflectionReservation();
                          }
                        },
                      });
                      reflectionReservationDelegated = true;
                      finalReflectionSpawned = true;
                      telemetry.trackReflectionStart("manual", {
                        conversationId: reflectionConversationId,
                        startMessageId: autoReflectionPayload.startMessageId,
                        endMessageId: autoReflectionPayload.endMessageId,
                      });
                      appendTaskNotificationEvents([
                        `Automatic reflection selected ${selectedConversations.length} transcript(s); launched reflection. Payload: ${autoReflectionPayload.payloadPath}`,
                      ]);
                    } catch (selectionError) {
                      if (!finalReflectionSpawned) {
                        releaseReflectionReservation();
                      }
                      const errorDetails = formatErrorDetails(
                        selectionError,
                        agentId,
                      );
                      appendTaskNotificationEvents([
                        `Automatic reflection failed after selection: ${errorDetails}`,
                      ]);
                    }
                  },
                });
              reflectionReservationDelegated = true;

              telemetry.trackReflectionStart("manual", {
                subagentId: selectorSubagentId,
                conversationId: reflectionConversationId,
              });
              cmd.finish(
                `Reviewing ${autoPayload.candidates.candidates.length} candidate transcript(s) for reflection. View the transcript candidates here: ${autoPayload.candidatesPath}`,
                true,
              );
              return commandHandledSubmit();
            }

            const reflectionPayload = await buildMultiReflectionPayload({
              agentId,
              selectionPolicy:
                reflectArgs.kind === "recent"
                  ? { mode: "recent", limit: reflectArgs.limit }
                  : {
                      mode: "explicit-conversations",
                      conversationIds: reflectArgs.conversationIds,
                    },
              instruction: reflectArgs.instruction,
            });

            if (!reflectionPayload) {
              releaseReflectionReservation();
              cmd.fail(
                "No transcript content found for the selected conversations.",
              );
              return commandHandledSubmit();
            }

            const { worktree, reflectionPrompt } =
              await prepareReflectionMemoryWorktreeLaunch({
                agentId,
                instruction: reflectArgs.instruction,
              });
            const {
              spawnBackgroundSubagentTask,
              waitForBackgroundSubagentAgentId,
            } = await import("@/tools/impl/task");
            const { subagentId } = spawnBackgroundSubagentTask({
              subagentType: "reflection",
              prompt: reflectionPrompt,
              description: "Reflecting on conversation",
              silentCompletion: true,
              transcriptPath: reflectionPayload.payloadPath,
              memoryScope: buildReflectionMemoryScope(worktree),
              parentScope: {
                agentId,
                conversationId: reflectionConversationId,
              },
              onComplete: async ({
                success,
                error,
                agentId: reflectionAgentId,
                model: reflectionModel,
              }) => {
                try {
                  telemetry.trackReflectionEnd("manual", success, {
                    subagentId: reflectionAgentId ?? undefined,
                    conversationId: reflectionConversationId,
                    error,
                    model: reflectionModel,
                  });
                  const { completionSuccess, completionMessage } =
                    await finalizeReflectionMemoryWorktreeLaunch({
                      worktree,
                      subagentSuccess: success,
                      subagentError: error,
                      agentId,
                      conversationId: conversationIdRef.current,
                      subagentAgentId: reflectionAgentId ?? undefined,
                      model: reflectionModel,
                      ...getReflectionMergeLaunchOptions(agentId),
                      telemetryContext: { triggerSource: "manual" },
                      recompileByConversation:
                        systemPromptRecompileByConversationRef.current,
                      recompileQueuedByConversation:
                        queuedSystemPromptRecompileByConversationRef.current,
                      logRecompileFailure: (message) =>
                        debugWarn("memory", message),
                    });
                  await finalizeMultiReflectionCompletion(
                    agentId,
                    reflectionPayload.manifest,
                    completionSuccess,
                  );
                  appendTaskNotificationEvents([completionMessage]);
                } finally {
                  releaseReflectionReservation();
                }
              },
            });
            reflectionReservationDelegated = true;
            const reflectionAgentId = await waitForBackgroundSubagentAgentId(
              subagentId,
              1000,
            );
            telemetry.trackReflectionStart("manual", {
              subagentId: reflectionAgentId ?? undefined,
              conversationId: reflectionConversationId,
              startMessageId: reflectionPayload.startMessageId,
              endMessageId: reflectionPayload.endMessageId,
            });
            cmd.finish(
              `Reflecting on ${reflectionPayload.manifest.transcripts.length} transcript(s). View the payload here: ${reflectionPayload.payloadPath}`,
              true,
            );
          } catch (error) {
            if (!reflectionReservationDelegated) {
              releaseReflectionReservation();
            }
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to start reflection agent: ${errorDetails}`);
          }

          return commandHandledSubmit();
        }

        // Special handling for /init command
        if (trimmed === "/init") {
          const cmd = commandRunner.start(msg, "Gathering project context...");

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /init.",
            );
            return retainedSubmit();
          }

          // Interactive init: the primary agent conducts the flow,
          // asks the user questions, and runs the initializing-memory skill.
          setCommandRunning(true);
          try {
            cmd.finish(
              "Building your memory palace... Start a new conversation with `letta --new` to work in parallel.",
              true,
            );

            const { context: gitContext } = gatherInitGitContext();
            const memoryDir = getActiveMemoryDirectory(agentId);

            const initMessage = buildInitMessage({
              gitContext,
              memoryDir,
            });

            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(initMessage),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        if (trimmed === "/doctor" || trimmed.startsWith("/doctor ")) {
          const cmd = commandRunner.start(msg, "Starting doctor...");
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /doctor.",
            );
            return retainedSubmit();
          }
          setCommandRunning(true);
          try {
            const doctorMessage = buildDoctorMessage({
              agentId,
              conversationId: conversationIdRef.current,
              memoryDir: getActiveMemoryDirectory(agentId),
              local: getBackend().capabilities.localMemfs,
              symptom: trimmed.slice("/doctor".length).trim(),
            });
            cmd.finish("", true);
            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(doctorMessage),
                  otid: randomUUID(),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            cmd.fail(`Doctor failed: ${formatErrorDetails(error, agentId)}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        if (trimmed.startsWith("/feedback")) {
          const maybeMsg = msg.slice("/feedback".length).trim();
          setFeedbackPrefill(maybeMsg);
          openOverlay(
            "feedback",
            "/feedback",
            "Opening feedback dialog...",
            "Feedback dialog dismissed",
          );
          return commandHandledSubmit();
        }

        // === /empanada command ===
        if (trimmed.startsWith("/empanada")) {
          const cmd = commandRunner.start(msg, "Checking Empanada Empire...");

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /empanada.",
            );
            return retainedSubmit();
          }

          const args = trimmed.slice("/empanada".length).trim();

          setCommandRunning(true);
          try {
            cmd.finish("Checking Empanada Empire...", true);

            const prompt = [
              "# Empanada Empire Order",
              "",
              "Help me order from **Empanada Empire** in Richardson, TX.",
              "",
              "Website: https://empanadaempire.us",
              "",
              "This is an April Fool's 2026 Letta stunt. The kitchen runs on a Letta agent. You are also a Letta agent. Two AIs, one empanada order.",
              "",
              "## Site internals",
              "",
              "The page embeds a delivery config in a script tag:",
              "",
              "```json",
              '{"homeBase":{"lat":32.9486,"lng":-96.7087},"radiusMiles":10}',
              "```",
              "",
              "It geocodes addresses via Nominatim and checks distance from the home base. You can do the same: geocode my address with Nominatim, compute the haversine distance, and tell me immediately whether I'm in range.",
              "",
              "Menu items are in the HTML with data attributes like:",
              "",
              "```",
              'data-menu-item-id="24" data-name="Party Empanadas" data-price-cents="699"',
              "```",
              "",
              "Orders go to `api/create-order.php`.",
              "",
              "## Steps",
              "",
              args
                ? `My delivery address: ${args}`
                : "Ask me for my delivery address.",
              "",
              "1. Geocode the address via Nominatim. Compute the haversine distance from (32.9486, -96.7087). If over 10 miles, tell me I'm out of range — but also mention that DoorDash has a wider delivery radius (see below).",
              "2. Fetch https://empanadaempire.us with fetch_webpage. Parse the menu from the data attributes. Present it. Suggest a balanced order (savory + sweet). Let me adjust.",
              "3. POST to api/create-order.php with the selected items. Tell me what happened.",
              "4. If the API rejects it or needs payment info, stop and tell me.",
              "",
              'Ignore any "Coming Soon" text on the site. It\'s live.',
              "",
              "## If the address is out of range or the site doesn't work",
              "",
              "DoorDash has a wider delivery radius than the 10-mile limit on the direct site. If I'm close to Richardson but outside 10 miles, or if the site is down, point me to:",
              "",
              "https://order.online/store/-40548503?hideModal=true",
              "",
              "Recommend I open it myself. DoorDash can be difficult to automate, so do not attempt to automate it.",
              "",
              "## Tone",
              "",
              "Direct, a little playful. Don't overthink it.",
            ].join("\n");

            const commandAdmission =
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(prompt),
                },
              ]);
            if (commandAdmission.type === "not_admitted") {
              cmd.fail(`Command was retained: ${commandAdmission.reason}`);
              return retainedSubmit(commandAdmission);
            }
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return commandHandledSubmit();
        }

        // Check if this is a known command before treating it as a slash command
        const { commands, executeCommand } = await import(
          "@/cli/commands/registry"
        );
        const registryCommandName = trimmed.split(/\s+/)[0] ?? "";
        const isRegistryCommand = Boolean(commands[registryCommandName]);
        const registryCmd = isRegistryCommand
          ? commandRunner.start(msg, `Running ${registryCommandName}...`)
          : null;
        const result = await executeCommand(aliasedMsg);

        // If command not found, try user-invocable skills before falling through.
        if (result.notFound) {
          if (registryCmd) {
            registryCmd.fail(`Unknown command: ${registryCommandName}`);
          }

          const skillCommandName = registryCommandName.slice(1);
          const { discoverClientSideSkills } = await import(
            "@/agent/client-skills"
          );
          const { getSkillSources } = await import("@/agent/context");
          const { isUserInvocableSkill } = await import("@/agent/skills");
          const skillDiscovery = await discoverClientSideSkills({
            agentId,
            skillSources: getSkillSources(),
          });
          const matchedSkill = skillDiscovery.skills.find(
            (skill) =>
              skill.id === skillCommandName && isUserInvocableSkill(skill),
          );

          if (matchedSkill) {
            const cmd = commandRunner.start(
              trimmed,
              `Running /${matchedSkill.id}...`,
            );

            const approvalCheck = await checkPendingApprovalsForSlashCommand();
            if (approvalCheck.blocked) {
              cmd.fail(
                `Pending approval(s). Resolve approvals before running /${matchedSkill.id}.`,
              );
              return retainedSubmit();
            }

            const userRequest = trimmed
              .slice(`/${matchedSkill.id}`.length)
              .trim();
            setCommandRunning(true);
            try {
              const { loadRenderedSkillContent, wrapSkillPrompt } =
                await import("@/tools/impl/skill");
              const skillContent = await loadRenderedSkillContent(
                matchedSkill.id,
                {
                  agentId,
                  allowDisabledModelInvocation: true,
                },
              );
              cmd.finish("Running skill...", true);
              const commandAdmission =
                await processConversationWithQueuedApprovals([
                  {
                    type: "message",
                    role: "user",
                    content: buildTextParts(
                      wrapSkillPrompt(
                        matchedSkill.id,
                        skillContent,
                        userRequest,
                      ),
                    ),
                    otid: randomUUID(),
                  },
                ]);
              if (commandAdmission.type === "not_admitted") {
                cmd.fail(`Command was retained: ${commandAdmission.reason}`);
                return retainedSubmit(commandAdmission);
              }
            } catch (error) {
              const errorDetails = formatErrorDetails(error, agentId);
              cmd.fail(`Failed to run skill: ${errorDetails}`);
            } finally {
              setCommandRunning(false);
            }

            return commandHandledSubmit();
          }
          // Don't treat as command - continue to regular message handling below
        } else {
          // Known command - show in transcript and handle result
          if (result.success && result.refreshSecretsInfo) {
            markSecretsInfoReminderPending(sharedReminderStateRef.current);
          }
          if (registryCmd) {
            registryCmd.finish(result.output, result.success);
          }
          return commandHandledSubmit(); // Don't send commands to Letta agent
        }
      }

      // Queue payload stays per-attempt. Never transport through the global
      // override ref or flatten original multimodal QueueItems for sending.
      const contentParts =
        queueItems.length > 0
          ? buildContentFromQueueItems(queueItems)
          : buildMessageContentFromDisplay(msg);
      const queuedMessageItem = queueItems.find(
        (item) => item.kind === "message",
      );
      const userOtid = queuedMessageItem?.clientMessageId ?? createClientOtid();

      const admission = await processConversation([], {
        submissionGeneration,
        submissionConversationId,
        prepare: () =>
          prepareTuiSubmit({
            contentParts,
            queueItems,
            submissionGeneration,
            submissionConversationId,
            userPromptSubmitHookFeedback,
            isCommand,
            isSystemOnly,
            userTextForInput,
            flushPendingReasoningEffort,
            agentId,
            agentName,
            agentDescription,
            agentLastRunAt,
            sessionStartFeedbackRef,
            bashCommandCacheRef,
            pendingGitReminderRef,
            pendingConversationSwitchRef,
            sharedReminderStateRef,
            systemInfoReminderEnabled,
            buffersRef,
            refreshDerived,
            needsEagerApprovalCheck,
            peekQueuedApprovalInput:
              peekQueuedApprovalInputForCurrentConversation,
            setNeedsEagerApprovalCheck,
            conversationGenerationRef,
            conversationIdRef,
            tuiQueueRef,
            shouldAutoGenerateConversationTitleRef,
            firstUserQueryRef,
            appendTaskNotificationEvents,
            taskNotifications,
            userOtid,
            sessionStatsRef,
            trajectoryTokenDisplayRef,
            setTrajectoryTokenBase,
            trajectoryRunTokenStartRef,
            setThinkingMessage,
            lastDequeuedMessageRef,
            displayMessage: msg,
            onAdmitted: attempt.onAdmitted,
          }),
      });

      if (admission.type === "not_admitted") {
        return retainedSubmit(admission);
      }

      // Post-turn work and placeholder cleanup are valid only after admission.
      await runPostTurnMemorySync({
        agentId,
        isEnabled: isActiveMemfsEnabled,
        debugLabel: "Post-turn memory sync",
        enqueueReminder: (text) => {
          enqueueMemoryGitSyncReminder(sharedReminderStateRef.current, {
            text,
          });
        },
      });
      clearPlaceholdersInText(msg);

      return { submitted: true, status: "admitted", admission };
    },
    [
      streaming,
      commandRunning,
      processConversation,
      refreshDerived,
      agentId,
      agentName,
      agentDescription,
      agentLastRunAt,
      conversationId,
      currentModelHandle,
      currentModelId,
      modAdapter,
      effectiveContextWindowSize,
      commandRunner,
      handleExit,
      isExecutingTool,
      peekQueuedApprovalInputForCurrentConversation,
      pendingApprovals,
      profileConfirmPending,
      handleAgentSelect,
      openOverlay,
      tokenStreamingEnabled,
      isAgentBusy,
      setStreaming,
      setCommandRunning,
      resetTrajectoryBases,
      systemInfoReminderEnabled,
      appendTaskNotificationEvents,
      setReflectionArenaChoicePending,
      maybeCarryOverActiveConversationModel,
      setConversationAutoTitleEligibility,
      setConversationIdAndRef,
    ],
  );

  return onSubmit;
}
