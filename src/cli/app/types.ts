import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";
import type { AgentProvenance } from "@/agent/create";
import type { PersonalityId } from "@/agent/personality-presets";
import type { CommandHandle, createCommandRunner } from "@/cli/commands/runner";
import type { ModelSelectorSelection } from "@/cli/components/ModelSelector";
import type { Line } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ExperimentId } from "@/experiments/types";
import type { ToolExecutionResult } from "@/tools/manager";
import type { ToolsetPreference } from "@/tools/toolset";

export type AppLoadingState =
  | "assembling"
  | "initializing"
  | "checking"
  | "ready";

export type AppProps = {
  agentId: string;
  agentState?: AgentState | null;
  conversationId: string; // Required: created at startup
  loadingState?: AppLoadingState;
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null; // Deprecated: use startupApprovals
  startupApprovals?: ApprovalRequest[];
  messageHistory?: Message[];
  resumedExistingConversation?: boolean; // True if we explicitly resumed via --resume
  startupConversationTitleEligible?: boolean;
  tokenStreaming?: boolean;
  reasoningTabCycleEnabled?: boolean;
  showCompactions?: boolean;
  agentProvenance?: AgentProvenance | null;
  startupHasCloudCredentials?: boolean;
  startupHasAvailableLocalModels?: boolean;
  fileAutocompleteFdPath?: string | null;
  releaseNotes?: string | null; // Markdown release notes to display above header
  updateNotification?: string | null; // Latest version when a significant auto-update was applied
  systemInfoReminderEnabled?: boolean;
  modsDisabled?: boolean;
  /** Explicit local mod directory, useful for isolated integration tests. */
  agentModsDirectoryOverride?: string | null;
};

export type ActiveOverlay =
  | "model"
  | "experiment"
  | "worktree-diff"
  | "sleeptime"
  | "compaction"
  | "toolset"
  | "system"
  | "personality"
  | "agent"
  | "resume"
  | "conversations"
  | "search"
  | "subagent"
  | "feedback"
  | "memory"
  | "memfs-sync"
  | "pin"
  | "mcp"
  | "install-github-app"
  | "help"
  | "hooks"
  | "connect"
  | "skills"
  | "window-title"
  | "login"
  | null;

export type QueuedOverlayAction =
  | {
      type: "switch_agent";
      agentId: string;
      commandId?: string;
      backendMode?: "local" | "api";
    }
  | {
      type: "switch_model";
      modelId: string;
      modelSelection?: ModelSelectorSelection;
      commandId?: string;
    }
  | {
      type: "set_experiment";
      experimentId: ExperimentId;
      enabled: boolean;
      commandId?: string;
    }
  | {
      type: "set_sleeptime";
      settings: ReflectionSettings;
      commandId?: string;
    }
  | {
      type: "set_compaction";
      mode: string;
      commandId?: string;
    }
  | {
      type: "switch_conversation";
      conversationId: string;
      commandId?: string;
    }
  | {
      type: "switch_toolset";
      toolsetId: ToolsetPreference;
      commandId?: string;
    }
  | { type: "switch_system"; promptId: string; commandId?: string }
  | {
      type: "switch_personality";
      personalityId: PersonalityId;
      commandId?: string;
    }
  | null;

export type AppCommandRunner = Pick<
  ReturnType<typeof createCommandRunner>,
  "start" | "getHandle"
>;

export type CommandStarter = Pick<
  ReturnType<typeof createCommandRunner>,
  "start"
>;

export type QueuedApprovalMetadata = {
  conversationId: string;
  generation: number;
};

export type QueueApprovalResults = (
  results: ApprovalResult[] | null,
  metadata?: QueuedApprovalMetadata,
) => void;

export type ProcessConversationOptions = {
  allowReentry?: boolean;
  submissionGeneration?: number;
  submissionConversationId?: string;
  transcriptStartLineIndex?: number | null;
  allowResponseStateReuse?: boolean;
  /**
   * Synchronous admission commit, invoked exactly once when the attempt has
   * passed every admission guard and is about to become the turn owner.
   * Must contain no awaits: verify-then-consume has to be atomic with
   * respect to the queue. Return false when the planned batch no longer
   * matches the ready prefix — the attempt is refused as `queue_changed`
   * and nothing is consumed.
   */
  admissionCommit?: () => boolean;
  /**
   * Lazy preparation: awaited while this attempt already holds its turn
   * reservation, so state-consuming preparation (reminder splices, cache
   * reads) only runs for attempts that passed the admission guards. The
   * returned input replaces the eager `input` argument; the returned
   * admissionCommit (if any) is chained after any commit passed here.
   */
  prepare?: () => Promise<{
    input: Array<MessageCreate | ApprovalCreate>;
    admissionCommit?: (() => boolean) | undefined;
    transcriptStartLineIndex?: number | null;
    refusal?: TuiAdmissionRefusalReason;
  }>;
};

/**
 * Why a processConversation attempt did NOT become a turn. A refusal never
 * decrements another owner's reservation, never touches streaming, and never
 * reports success to its caller.
 */
export type TuiAdmissionRefusalReason =
  | "busy" // another admitted turn owns the loop (no reentry allowed)
  | "stale" // conversation generation moved on (Esc / conversation switch)
  | "cancelled" // user cancellation was pending at admission
  | "blocked" // a turn_start mod handler cancelled the turn
  | "prepare_error" // preparation failed after reservation, before commit
  | "queue_changed"; // the planned queue batch no longer matches the ready prefix

/** How an admitted turn ended. Admission is handoff to the loop, not provider success. */
export type TuiTurnOutcome =
  | "completed"
  | "interrupted"
  | "error"
  | "awaiting_approval";

export type TuiTurnAdmission =
  | { type: "not_admitted"; reason: TuiAdmissionRefusalReason }
  | { type: "admitted"; outcome: TuiTurnOutcome };

export type ProcessConversation = (
  input: Array<MessageCreate | ApprovalCreate>,
  options?: ProcessConversationOptions,
) => Promise<TuiTurnAdmission>;

/** Coarse disposition of a submit attempt, for callers that need more than the Input `submitted` flag. */
export type TuiSubmitStatus =
  | "admitted" // the turn was admitted (see admission for the outcome)
  | "queued" // agent was busy: content was enqueued in the native queue
  | "retained" // refused before admission; content preserved for an explicit retry
  | "command_handled"; // a slash command / hook handled the input; no agent turn

export type TuiSubmitResult = {
  /** Legacy Input adaptation flag: true when the input box may clear the draft. */
  submitted: boolean;
  status: TuiSubmitStatus;
  /** Present when the request reached the conversation-loop admission gate. */
  admission?: TuiTurnAdmission;
  /** True when the refused draft should be retained rather than only restored. */
  retained?: boolean;
};

export type AutoHandledToolResult = {
  toolCallId: string;
  result: ToolExecutionResult;
};

export type AutoDeniedApproval = {
  approval: ApprovalRequest;
  reason: string;
};

export type AutoAllowedExecution = {
  toolCallIds: string[];
  results: ApprovalResult[] | null;
  conversationId: string;
  generation: number;
};

export type AppendErrorOptions =
  | boolean
  | {
      skip?: boolean;
      errorType?: string;
      errorMessage?: string;
      context?: string;
      httpStatus?: number;
      runId?: string;
    };

export type AppendError = (
  message: string,
  options?: AppendErrorOptions,
) => void;

export type OverlayCommandConsumer = (
  overlay: ActiveOverlay,
) => CommandHandle | null;

export type { ApprovalDecision };

// Items that have finished rendering and no longer change
export type StaticItem =
  | {
      kind: "welcome";
      id: string;
      snapshot: {
        continueSession: boolean;
        agentState?: AgentState | null;
        startupHasAvailableLocalModels?: boolean;
        terminalWidth: number;
      };
    }
  | {
      kind: "subagent_group";
      id: string;
      agents: Array<{
        id: string;
        type: string;
        description: string;
        status: "completed" | "error" | "running";
        toolCount: number;
        totalTokens: number;
        agentURL: string | null;
        error?: string;
      }>;
    }
  | {
      // Preview content committed early during approval to enable flicker-free UI
      // When an approval's content is tall enough to overflow the viewport,
      // we commit the preview to static and only show small approval options in dynamic
      kind: "approval_preview";
      id: string;
      toolCallId: string;
      toolName: string;
      toolArgs: string;
      // Optional precomputed/cached data for rendering
      precomputedDiff?: AdvancedDiffSuccess;
    }
  | Line;
