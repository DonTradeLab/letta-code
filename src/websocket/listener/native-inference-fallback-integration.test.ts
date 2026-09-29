import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
} from "@earendil-works/pi-ai";
import { __testSetBackend } from "@/backend";
import type { NativeInferenceModelAttempt } from "@/backend/dev/native-inference-fallback";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import { __listenerWarmupTestUtils } from "./warmup";

const roots: string[] = [];
let listenerForCleanup: ReturnType<typeof createRuntime> | undefined;

afterEach(async () => {
  if (listenerForCleanup) {
    disposeListenerModAdapter(listenerForCleanup);
    listenerForCleanup = undefined;
  }
  await settingsManager.reset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function providerMessage(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyLocalUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function providerResult(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), { result: async () => finalMessage });
}

test("listener owns one turn while native fallback switches only the provider dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "listener-native-fallback-"));
  roots.push(root);
  const storageDir = join(root, "backend");
  const modDir = join(root, "mods");
  const cacheDir = join(root, "cache");
  await Promise.all([
    mkdir(storageDir, { recursive: true }),
    mkdir(modDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);
  process.env.HOME = root;
  process.env.LETTA_HOME = join(root, "letta-home");
  process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
  await settingsManager.reset();
  await settingsManager.initialize();

  const dispatches: string[] = [];
  const attempts: NativeInferenceModelAttempt[] = [];
  const stream: PiStreamFunction = (model) => {
    dispatches.push(`${model.provider}/${model.id}`);
    if (model.id === "gpt-5.5") {
      const failure = {
        ...providerMessage(
          model,
          [{ type: "text", text: "listener-must-not-see-primary" }],
          "error",
        ),
        errorMessage:
          '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
      };
      return providerResult(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "listener-must-not-see-primary",
            partial: failure,
          },
          { type: "error", reason: "error", error: failure },
        ],
        failure,
      );
    }
    const success = providerMessage(
      model,
      [{ type: "text", text: "listener-secondary-only" }],
      "stop",
    );
    return providerResult(
      [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "listener-secondary-only",
          partial: success,
        },
        { type: "done", reason: "stop", message: success },
      ],
      success,
    );
  };
  const backend = new LocalBackend({
    storageDir,
    stateStorageDir: storageDir,
    stream,
    memfsEnabled: false,
    nativeInferenceFallback: {
      resolveDestination(context, failure, attemptedModels) {
        if (
          context.input.agent.name !== "Clara listener synthetic" ||
          failure.category !== "quota_exhausted" ||
          attemptedModels.includes("openai/gpt-5.4")
        ) {
          return null;
        }
        return {
          model: "openai/gpt-5.4",
          modelSettings: { reasoning_effort: "xhigh" },
        };
      },
      onModelAttempt(attempt) {
        attempts.push(attempt);
      },
    },
  });
  __testSetBackend(backend);
  const agent = await backend.createAgent({
    name: "Clara listener synthetic",
    model: "openai/gpt-5.5",
    model_settings: { reasoning_effort: "low" },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);

  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  const listener = createRuntime();
  listenerForCleanup = listener;
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: modDir,
    cacheDirectory: cacheDir,
  });
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, agent.id, conversation.id);
  const payloads: string[] = [];
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => {
      payloads.push(payload);
    },
  };

  await handleIncomingMessage(
    {
      type: "message",
      agentId: agent.id,
      conversationId: conversation.id,
      processOwnedTurn: true,
      excludeInteractiveTools: true,
      messages: [
        {
          role: "user",
          content: "one listener inbound",
          client_message_id: "listener-input-otid",
        },
      ],
    },
    transport,
    runtime,
    undefined,
    undefined,
    "batch-native-fallback",
  );

  expect(dispatches).toEqual(["openai/gpt-5.5", "openai/gpt-5.4"]);
  expect(payloads.join("\n")).toContain("listener-secondary-only");
  expect(payloads.join("\n")).not.toContain("listener-must-not-see-primary");
  expect(runtime.turnLifecycle.snapshot().kind).toBe("idle");
  expect(
    attempts
      .filter((attempt) => attempt.outcome !== "started")
      .map((attempt) => `${attempt.model}:${attempt.outcome}`),
  ).toEqual(["openai/gpt-5.5:quota", "openai/gpt-5.4:success"]);
});
