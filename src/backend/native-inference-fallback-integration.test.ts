import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type {
  NativeInferenceFallbackPolicy,
  NativeInferenceModelAttempt,
} from "@/backend/dev/native-inference-fallback";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

const PRIMARY = "openai/gpt-5.5";
const SECONDARY = "openai/gpt-5.4";
const roots: string[] = [];

afterEach(async () => {
  clearRegisteredPiProviders();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function message(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  responseId: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId,
    usage: emptyLocalUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function quota(
  model: Model<string>,
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    ...message(model, content, "error", `quota-${model.id}`),
    errorMessage:
      '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
  };
}

function result(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), { result: async () => finalMessage });
}

function fallbackPolicy(
  attempts: NativeInferenceModelAttempt[],
): NativeInferenceFallbackPolicy {
  return {
    resolveDestination(context, failure, attemptedModels) {
      if (
        context.input.agent.name !== "Clara synthetic" ||
        failure.category !== "quota_exhausted" ||
        attemptedModels.includes(SECONDARY)
      ) {
        return null;
      }
      return {
        model: SECONDARY,
        modelSettings: { reasoning_effort: "xhigh" },
      };
    },
    onModelAttempt(attempt) {
      attempts.push(attempt);
    },
  };
}

async function collect(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function fixture(stream: PiStreamFunction) {
  const root = await mkdtemp(join(tmpdir(), "letta-native-fallback-"));
  roots.push(root);
  const storageDir = join(root, "local-backend");
  const attempts: NativeInferenceModelAttempt[] = [];
  const backend = new LocalBackend({
    storageDir,
    stateStorageDir: storageDir,
    stream,
    memfsEnabled: false,
    nativeInferenceFallback: fallbackPolicy(attempts),
  });
  const agent = await backend.createAgent({
    name: "Clara synthetic",
    model: PRIMARY,
    model_settings: { reasoning_effort: "low" },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  return { root, storageDir, attempts, backend, agent, conversation };
}

function textChunks(chunks: LettaStreamingResponse[]): string {
  return chunks
    .filter((chunk) => chunk.message_type === "assistant_message")
    .flatMap((chunk) =>
      "content" in chunk && Array.isArray(chunk.content) ? chunk.content : [],
    )
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
}

describe("native inference fallback through LocalBackend and ProviderTurnExecutor", () => {
  test("uses both provider-published models through real pi-ai HTTP drivers", async () => {
    const requests: Array<{
      model: string;
      authorization?: string;
      input: unknown;
    }> = [];
    const server = createServer((request, response) => {
      const body: Buffer[] = [];
      request.on("data", (chunk) => body.push(Buffer.from(chunk)));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(body).toString("utf8")) as {
          model?: string;
          messages?: unknown;
        };
        requests.push({
          model: payload.model ?? "",
          authorization: request.headers.authorization,
          input: payload.messages,
        });
        if (payload.model === "primary-model") {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "1310",
                message: "Weekly/Monthly Limit Exhausted",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (choices: unknown[]) =>
          `data: ${JSON.stringify({
            id: "secondary-http-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "secondary-model",
            choices,
          })}\n\n`;
        response.write(
          chunk([
            {
              index: 0,
              delta: { role: "assistant", content: "secondary-http-success" },
              finish_reason: null,
            },
          ]),
        );
        response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback HTTP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "letta-native-fallback-http-"));
    roots.push(root);
    const storageDir = join(root, "backend");
    const primary = "fixture-primary/primary-model";
    const secondary = "fixture-secondary/secondary-model";
    const modelRegistration = (id: string) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    });
    registerPiProvider("fixture-primary", {
      api: "openai-completions",
      baseUrl,
      apiKey: "fake-primary-key",
      models: [modelRegistration("primary-model")],
    });
    registerPiProvider("fixture-secondary", {
      api: "openai-completions",
      baseUrl,
      apiKey: "fake-secondary-key",
      models: [modelRegistration("secondary-model")],
    });
    const modelsRuntime = new LocalPiModelsRuntime({ storageDir });
    const dispatches: Array<{
      model: string;
      provider: string;
      baseUrl: string;
    }> = [];
    const attempts: NativeInferenceModelAttempt[] = [];
    const stream: PiStreamFunction = (model, context, options) => {
      dispatches.push({
        model: model.id,
        provider: model.provider,
        baseUrl: model.baseUrl,
      });
      if (model.api !== "openai-completions") {
        throw new Error(`Expected openai-completions, got ${model.api}`);
      }
      return streamSimple(
        { ...model, api: model.api },
        normalizeContext(context),
        { ...options, maxRetries: 0 },
      );
    };
    const backend = new LocalBackend({
      storageDir,
      stateStorageDir: storageDir,
      modelsRuntime,
      stream,
      memfsEnabled: false,
      nativeInferenceFallback: {
        resolveDestination(_context, failure, attemptedModels) {
          if (
            failure.category !== "quota_exhausted" ||
            attemptedModels.includes(secondary)
          ) {
            return null;
          }
          return { model: secondary, modelSettings: {} };
        },
        onModelAttempt(attempt) {
          attempts.push(attempt);
        },
      },
    });

    try {
      const agent = await backend.createAgent({
        name: "Clara HTTP synthetic",
        model: primary,
        model_settings: {},
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const sink = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "same HTTP input" }],
        } as ConversationMessageCreateBody),
      );

      expect(requests.map((request) => request.model)).toEqual([
        "primary-model",
        "secondary-model",
      ]);
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer fake-primary-key",
        "Bearer fake-secondary-key",
      ]);
      expect(requests[0]?.input).toEqual(requests[1]?.input);
      expect(dispatches).toEqual([
        { model: "primary-model", provider: "fixture-primary", baseUrl },
        { model: "secondary-model", provider: "fixture-secondary", baseUrl },
      ]);
      expect(textChunks(sink)).toBe("secondary-http-success");
      expect(
        attempts
          .filter((attempt) => attempt.outcome !== "started")
          .map((attempt) => ({
            model: attempt.model,
            provider: attempt.provider,
            outcome: attempt.outcome,
            status: attempt.status,
            code: attempt.code,
          })),
      ).toEqual([
        {
          model: primary,
          provider: "fixture-primary",
          outcome: "quota",
          status: 429,
          code: "1310",
        },
        {
          model: secondary,
          provider: "fixture-secondary",
          outcome: "success",
          status: undefined,
          code: undefined,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("persists one input and delivers one secondary answer to the same synthetic channel sink", async () => {
    const dispatches: Array<{ model: string; messages: number }> = [];
    const stream: PiStreamFunction = (model, context) => {
      dispatches.push({
        model: `${model.provider}/${model.id}`,
        messages: context.messages.length,
      });
      if (model.id === "gpt-5.5") {
        const failure = quota(model, [
          { type: "text", text: "partial-primary" },
        ]);
        return result(
          [
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial-primary",
              partial: failure,
            },
            { type: "error", reason: "error", error: failure },
          ],
          failure,
        );
      }
      const success = message(
        model,
        [{ type: "text", text: "single-delivery" }],
        "stop",
        "secondary-success",
      );
      return result(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "single-delivery",
            partial: success,
          },
          { type: "done", reason: "stop", message: success },
        ],
        success,
      );
    };
    const { backend, agent, conversation, attempts } = await fixture(stream);

    const sink = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "one inbound" }],
      } as ConversationMessageCreateBody),
    );
    expect(textChunks(sink)).toBe("single-delivery");
    expect(JSON.stringify(sink)).not.toContain("partial-primary");
    expect(dispatches).toEqual([
      { model: PRIMARY, messages: 1 },
      { model: SECONDARY, messages: 1 },
    ]);

    const persisted = (
      await backend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never)
    ).getPaginatedItems();
    expect(
      persisted.filter((row) => row.message_type === "user_message"),
    ).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("partial-primary");
    expect(JSON.stringify(persisted)).toContain("single-delivery");
    expect(
      attempts
        .filter((attempt) => attempt.outcome !== "started")
        .map((attempt) => `${attempt.model}:${attempt.outcome}`),
    ).toEqual([`${PRIMARY}:quota`, `${SECONDARY}:success`]);
  });

  test("keeps a completed file effect and tool result while only retrying the following inference", async () => {
    const contexts: Context[] = [];
    const dispatches: string[] = [];
    const stream: PiStreamFunction = (model, context) => {
      contexts.push(context);
      dispatches.push(`${model.provider}/${model.id}`);
      const hasToolResult = context.messages.some(
        (entry) => entry.role === "toolResult",
      );
      if (!hasToolResult) {
        const tool = message(
          model,
          [
            {
              type: "toolCall",
              id: "count-file-once",
              name: "SyntheticFileCounter",
              arguments: { relativePath: "effect.log" },
            },
          ],
          "toolUse",
          "tool-request",
        );
        return result(
          [
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: tool.content[0] as Extract<
                AssistantMessage["content"][number],
                { type: "toolCall" }
              >,
              partial: tool,
            },
            { type: "done", reason: "toolUse", message: tool },
          ],
          tool,
        );
      }
      if (model.id === "gpt-5.5") {
        const failure = quota(model);
        return result(
          [{ type: "error", reason: "error", error: failure }],
          failure,
        );
      }
      const success = message(
        model,
        [{ type: "text", text: "observed counter=1" }],
        "stop",
        "after-tool-secondary",
      );
      return result(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "observed counter=1",
            partial: success,
          },
          { type: "done", reason: "stop", message: success },
        ],
        success,
      );
    };
    const { root, backend, agent, conversation } = await fixture(stream);
    const firstSink = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "count once" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      firstSink.filter(
        (chunk) => chunk.message_type === "approval_request_message",
      ),
    ).toHaveLength(1);

    const effectPath = join(root, "effect.log");
    await appendFile(effectPath, "1\n", "utf8");
    const secondSink = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: "count-file-once",
                status: "success",
                tool_return: "counter=1",
              },
            ],
          },
        ],
      } as never),
    );

    expect(textChunks(secondSink)).toBe("observed counter=1");
    expect((await readFile(effectPath, "utf8")).trim().split("\n")).toEqual([
      "1",
    ]);
    expect(dispatches).toEqual([PRIMARY, PRIMARY, SECONDARY]);
    const fallbackContext = contexts.at(-1);
    expect(
      fallbackContext?.messages.some(
        (entry) =>
          entry.role === "toolResult" &&
          JSON.stringify(entry.content).includes("counter=1"),
      ),
    ).toBe(true);
  });

  test("does not dispatch while approval is pending and preserves deny without executing the effect", async () => {
    const dispatches: string[] = [];
    const stream: PiStreamFunction = (model, context) => {
      dispatches.push(`${model.provider}/${model.id}`);
      const toolResult = context.messages.find(
        (entry) => entry.role === "toolResult",
      );
      if (!toolResult) {
        const tool = message(
          model,
          [
            {
              type: "toolCall",
              id: "denied-file-effect",
              name: "SyntheticFileCounter",
              arguments: {},
            },
          ],
          "toolUse",
          "deny-request",
        );
        return result(
          [
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: tool.content[0] as Extract<
                AssistantMessage["content"][number],
                { type: "toolCall" }
              >,
              partial: tool,
            },
            { type: "done", reason: "toolUse", message: tool },
          ],
          tool,
        );
      }
      if (model.id === "gpt-5.5") {
        const failure = quota(model);
        return result(
          [{ type: "error", reason: "error", error: failure }],
          failure,
        );
      }
      const success = message(
        model,
        [{ type: "text", text: "deny preserved" }],
        "stop",
        "deny-secondary",
      );
      return result(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "deny preserved",
            partial: success,
          },
          { type: "done", reason: "stop", message: success },
        ],
        success,
      );
    };
    const { root, backend, agent, conversation } = await fixture(stream);
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "request effect" }],
      } as ConversationMessageCreateBody),
    );
    expect(dispatches).toEqual([PRIMARY]);

    const sink = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: "denied-file-effect",
                status: "error",
                tool_return: "Denied by user",
              },
            ],
          },
        ],
      } as never),
    );
    expect(textChunks(sink)).toBe("deny preserved");
    expect(dispatches).toEqual([PRIMARY, PRIMARY, SECONDARY]);
    await expect(readFile(join(root, "effect.log"), "utf8")).rejects.toThrow();
  });
});
