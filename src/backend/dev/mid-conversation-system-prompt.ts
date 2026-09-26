import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRecord } from "@/utils/type-guards";

export function supportsMidConversationSystemPromptApi(api: string): boolean {
  return api === "anthropic-messages" || api === "openai-completions";
}

export function withMidConversationSystemPrompt(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  systemPrompt: string | undefined,
): SimpleStreamOptions["onPayload"] {
  if (!systemPrompt) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) {
      return upstreamChanged ? next : undefined;
    }
    const messages = Array.isArray(next.messages) ? next.messages : undefined;
    if (!messages) return upstreamChanged ? next : undefined;
    let lastConversationIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const entry = messages[index];
      if (
        isRecord(entry) &&
        entry.role !== "system" &&
        entry.role !== "developer"
      ) {
        lastConversationIndex = index;
        break;
      }
    }
    if (lastConversationIndex < 0) {
      return upstreamChanged ? next : undefined;
    }
    return {
      ...next,
      messages: [
        ...messages.slice(0, lastConversationIndex + 1),
        { role: "system", content: systemPrompt },
        ...messages.slice(lastConversationIndex + 1),
      ],
    };
  };
}
