import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type { Buffers } from "@/cli/helpers/accumulator";
import { markIncompleteToolsAsCancelled } from "@/cli/helpers/accumulator";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { debugWarn } from "@/utils/debug";
import { EAGER_CANCEL, ERROR_FEEDBACK_HINT } from "./constants";
import { extractErrorMeta } from "./errors";
import { sendDesktopNotification } from "./notifications";
import type { AppendError, TuiTurnOutcome } from "./types";

type Ref<T> = { current: T };

export function reportConversationPreparationError(
  error: unknown,
  appendError: AppendError,
): void {
  const message = error instanceof Error ? error.message : String(error);
  debugWarn(
    "message_stream",
    "Conversation preparation failed before admission: %s",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  appendError(
    `Turn preparation failed before admission: ${message}. Your input was retained; press Enter to retry.`,
    {
      errorType: "TurnPreparationError",
      errorMessage: message,
      context: "turn_prepare",
    },
  );
}

export function reportPostAdmissionSetupError(args: {
  error: unknown;
  agentId: string;
  appendError: AppendError;
  runId?: string;
  ownsController: boolean;
  setStreaming: (value: boolean) => void;
  refreshDerived: () => void;
  resetTrajectoryBases: () => void;
}): void {
  debugWarn(
    "message_stream",
    "Conversation failed after admission: %s",
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error),
  );
  args.appendError(formatErrorDetails(args.error, args.agentId), {
    ...extractErrorMeta(args.error),
    errorMessage:
      args.error instanceof Error ? args.error.message : String(args.error),
    context: "message_stream",
    runId: args.runId,
  });
  if (args.ownsController) args.setStreaming(false);
  args.refreshDerived();
  args.resetTrajectoryBases();
}

export function reportAdmittedRunError(args: {
  error: unknown;
  agentId: string;
  appendError: AppendError;
  buffers: Buffers;
  runId?: string;
  lastDequeuedMessageRef: Ref<string | null>;
  setRestoredInput: (value: string | null) => void;
  setStreaming: (value: boolean) => void;
  refreshDerived: () => void;
  resetTrajectoryBases: () => void;
}): TuiTurnOutcome {
  const interrupted = args.error instanceof APIUserAbortError;
  debugWarn(
    "message_stream",
    "Unhandled conversation error: %s",
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error),
  );
  markIncompleteToolsAsCancelled(
    args.buffers,
    true,
    interrupted ? "user_interrupt" : "stream_error",
  );
  if (!(EAGER_CANCEL && interrupted)) {
    args.appendError(formatErrorDetails(args.error, args.agentId), {
      ...extractErrorMeta(args.error),
      errorMessage:
        args.error instanceof Error ? args.error.message : String(args.error),
      context: "message_stream",
      runId: args.runId,
    });
    args.appendError(ERROR_FEEDBACK_HINT, true);
    if (args.lastDequeuedMessageRef.current) {
      args.setRestoredInput(args.lastDequeuedMessageRef.current);
      args.lastDequeuedMessageRef.current = null;
    }
    sendDesktopNotification("Processing error", "error");
    args.resetTrajectoryBases();
  }
  args.setStreaming(false);
  args.refreshDerived();
  return interrupted ? "interrupted" : "error";
}
