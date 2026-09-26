import { describe, expect, test } from "bun:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  supportsMidConversationSystemPromptApi,
  withMidConversationSystemPrompt,
} from "@/backend/dev/mid-conversation-system-prompt";

const model = { id: "provider-model" } as Model<string>;

describe("withMidConversationSystemPrompt", () => {
  test("supports Anthropic and OpenAI-completions payload APIs", () => {
    expect(supportsMidConversationSystemPromptApi("anthropic-messages")).toBe(
      true,
    );
    expect(supportsMidConversationSystemPromptApi("openai-completions")).toBe(
      true,
    );
    expect(supportsMidConversationSystemPromptApi("openai-responses")).toBe(
      false,
    );
  });

  test("inserts fresh memory after conversation messages and before trailing metadata", async () => {
    const transform = withMidConversationSystemPrompt(
      undefined,
      "fresh memory",
    );
    const rewritten = await transform?.(
      {
        messages: [
          { role: "system", content: "initial" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "working" },
          { role: "developer", content: "trailing metadata" },
        ],
      },
      model,
    );

    expect(rewritten).toMatchObject({
      messages: [
        { role: "system", content: "initial" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "working" },
        { role: "system", content: "fresh memory" },
        { role: "developer", content: "trailing metadata" },
      ],
    });
  });

  test("composes with an existing payload transform", async () => {
    const existing: SimpleStreamOptions["onPayload"] = async (payload) => ({
      ...(payload as Record<string, unknown>),
      messages: [{ role: "user", content: "from upstream" }],
    });
    const transform = withMidConversationSystemPrompt(existing, "fresh memory");

    expect(await transform?.({}, model)).toMatchObject({
      messages: [
        { role: "user", content: "from upstream" },
        { role: "system", content: "fresh memory" },
      ],
    });
  });

  test("leaves metadata-only payloads unchanged", async () => {
    const transform = withMidConversationSystemPrompt(
      undefined,
      "fresh memory",
    );

    expect(
      await transform?.(
        { messages: [{ role: "system", content: "metadata" }] },
        model,
      ),
    ).toBeUndefined();
  });
});
