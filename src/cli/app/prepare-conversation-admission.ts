import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { Buffers } from "@/cli/helpers/accumulator";
import { checkTuiAdmission } from "@/cli/helpers/tui-admission";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";
import { uid } from "./ids";
import type { ProcessConversationOptions, TuiTurnAdmission } from "./types";

type Ref<T> = { current: T };
type TurnInput = Array<MessageCreate | ApprovalCreate>;

type AdmissionPreparation =
  | {
      admitted: false;
      result: TuiTurnAdmission;
      suppressWake: boolean;
    }
  | {
      admitted: true;
      input: TurnInput;
      transcriptStartLineIndex?: number | null;
    };

function hasUserMessage(input: TurnInput): boolean {
  return input.some(
    (item) =>
      item.type !== "approval" && "role" in item && item.role === "user",
  );
}

function isTurnInput(value: unknown): value is TurnInput {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

export async function prepareConversationAdmission(args: {
  initialInput: TurnInput;
  options?: ProcessConversationOptions;
  myGeneration: number;
  turnAbortController: AbortController;
  conversationGenerationRef: Ref<number>;
  conversationIdRef: Ref<string>;
  userCancelledRef: Ref<boolean>;
  agentIdRef: Ref<string>;
  modAdapter: LocalModAdapter;
  buffersRef: Ref<Buffers>;
  refreshDerived: () => void;
}): Promise<AdmissionPreparation> {
  let input: TurnInput;
  let transcriptStartLineIndex = args.options?.transcriptStartLineIndex;
  let admissionCommit = args.options?.admissionCommit;

  if (args.options?.prepare) {
    const prepared = await args.options.prepare();
    input = Array.isArray(prepared.input) ? [...prepared.input] : [];
    if (prepared.transcriptStartLineIndex !== undefined) {
      transcriptStartLineIndex = prepared.transcriptStartLineIndex;
    }
    if (prepared.refusal) {
      return {
        admitted: false,
        result: { type: "not_admitted", reason: prepared.refusal },
        suppressWake:
          prepared.refusal === "blocked" ||
          prepared.refusal === "prepare_error",
      };
    }
    if (prepared.admissionCommit) {
      const outer = admissionCommit;
      const inner = prepared.admissionCommit;
      admissionCommit = outer ? () => outer() && inner() : inner;
    }
  } else {
    input = Array.isArray(args.initialInput) ? [...args.initialInput] : [];
  }

  let cancelReason: string | null = null;
  if (hasUserMessage(input)) {
    const original = input;
    try {
      const event = {
        agentId: args.agentIdRef.current ?? null,
        conversationId: args.conversationIdRef.current ?? null,
        input,
      };
      await args.modAdapter.events.emit(
        "turn_start",
        event,
        args.modAdapter.context,
      );
      input = isTurnInput(event.input) ? event.input : original;
      cancelReason = getTurnStartCancel(event)?.reason ?? null;
    } catch {
      input = original;
    }
  }

  const refusal = checkTuiAdmission({
    processingConversation: 0,
    allowReentry: true,
    submissionGeneration: args.myGeneration,
    currentGeneration: args.conversationGenerationRef.current,
    userCancelled:
      args.userCancelledRef.current || args.turnAbortController.signal.aborted,
  });
  if (refusal) {
    return { admitted: false, result: refusal, suppressWake: false };
  }
  if (
    args.options?.submissionConversationId !== undefined &&
    args.options.submissionConversationId !== args.conversationIdRef.current
  ) {
    return {
      admitted: false,
      result: { type: "not_admitted", reason: "stale" },
      suppressWake: false,
    };
  }
  if (cancelReason) {
    const id = uid("status");
    args.buffersRef.current.byId.set(id, {
      kind: "status",
      id,
      lines: [cancelReason],
    });
    args.buffersRef.current.order.push(id);
    args.refreshDerived();
    return {
      admitted: false,
      result: { type: "not_admitted", reason: "blocked" },
      suppressWake: true,
    };
  }
  if (admissionCommit && !admissionCommit()) {
    return {
      admitted: false,
      result: { type: "not_admitted", reason: "queue_changed" },
      suppressWake: true,
    };
  }
  return { admitted: true, input, transcriptStartLineIndex };
}

export function promoteReadyServerToolCalls(buffers: Buffers): boolean {
  let promoted = false;
  for (const [toolCallId, toolInfo] of buffers.serverToolCalls) {
    const lineId = buffers.toolCallIdToLineId.get(toolCallId);
    if (!lineId) continue;
    const line = buffers.byId.get(lineId);
    if (!line || line.kind !== "tool_call" || line.phase === "finished") {
      continue;
    }
    const argsText = toolInfo.toolArgs ?? "";
    let complete = argsText.trim().length === 0;
    if (!complete) {
      try {
        JSON.parse(argsText);
        complete = true;
      } catch {
        // Incomplete JSON remains pending.
      }
    }
    if (complete && line.phase !== "running") {
      buffers.byId.set(lineId, {
        ...line,
        phase: "running",
        argsText: line.argsText ?? argsText,
      });
      promoted = true;
    }
  }
  return promoted;
}
