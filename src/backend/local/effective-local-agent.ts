import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { isRecord } from "@/utils/type-guards";
import type { LocalAgentRecord } from "./local-types";

/** Shared by dispatch and its manual-selection fence, including outer context overrides. */
export function effectiveLocalAgent(
  agent: LocalAgentRecord,
  conversation: Conversation,
): LocalAgentRecord {
  const record = conversation as unknown as Record<string, unknown>;
  return {
    ...agent,
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    model_settings: {
      ...agent.model_settings,
      ...(isRecord(record.model_settings) ? record.model_settings : {}),
      ...(typeof record.context_window_limit === "number"
        ? { context_window_limit: record.context_window_limit }
        : {}),
    },
  };
}
