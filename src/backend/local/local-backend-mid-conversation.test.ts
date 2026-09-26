import { describe, expect, test } from "bun:test";
import {
  formatMidConversationMemoryUpdate,
  supportsMidConversationSystemMessages,
} from "@/backend/local/local-backend-mid-conversation";

describe("supportsMidConversationSystemMessages", () => {
  test("formats committed memory as authoritative mid-conversation context", () => {
    expect(
      formatMidConversationMemoryUpdate({
        memfsRevision: "abc123",
        coreMemory: "fresh persona\n",
      } as never),
    ).toBe(
      [
        "<memory_update>",
        "The local memory filesystem has been edited and committed at revision abc123.",
        "This updates part of your persona/system memory. Treat the following freshly rendered memory context as authoritative from now on; where it conflicts with earlier memory context, this newer memory context wins.",
        "",
        "fresh persona",
        "</memory_update>",
      ].join("\n"),
    );
  });

  test.each([
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-mythos-5",
    "anthropic/claude-mythos-5-1",
    "deepseek/deepseek-chat",
    "zai/glm-5",
  ])("supports memory updates for %s", (model) => {
    expect(supportsMidConversationSystemMessages({ model } as never)).toBe(
      true,
    );
  });

  test.each([
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.2",
    "openrouter/deepseek/deepseek-chat",
    "claude-opus-5",
    "",
  ])("does not broaden memory updates to %s", (model) => {
    expect(supportsMidConversationSystemMessages({ model } as never)).toBe(
      false,
    );
  });
});
