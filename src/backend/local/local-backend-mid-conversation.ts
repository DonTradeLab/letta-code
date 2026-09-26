import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";

const MID_CONVERSATION_SYSTEM_ANTHROPIC_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
]);

export function formatMidConversationMemoryUpdate(
  compiled: LocalCompiledSystemPrompt,
): string {
  return [
    "<memory_update>",
    `The local memory filesystem has been edited and committed at revision ${compiled.memfsRevision ?? "unknown"}.`,
    "This updates part of your persona/system memory. Treat the following freshly rendered memory context as authoritative from now on; where it conflicts with earlier memory context, this newer memory context wins.",
    "",
    compiled.coreMemory.trimEnd(),
    "</memory_update>",
  ].join("\n");
}

export function supportsMidConversationSystemMessages(agent: {
  model?: string | null;
}): boolean {
  const model = agent.model ?? "";
  const slash = model.indexOf("/");
  const provider = slash >= 0 ? model.slice(0, slash) : "";
  const id = slash >= 0 ? model.slice(slash + 1) : model;
  if (provider === "anthropic") {
    return MID_CONVERSATION_SYSTEM_ANTHROPIC_MODELS.has(id);
  }
  return provider === "deepseek" || provider === "zai";
}
