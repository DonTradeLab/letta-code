import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
} from "@earendil-works/pi-ai";
import {
  classifyNativeInferenceFailure,
  type NativeInferenceFailureCategory,
  type NativeInferenceFallbackPolicy,
  type NativeInferenceModelAttempt,
  parseNativeInferenceProviderErrorEnvelope,
} from "@/backend/dev/native-inference-fallback";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";

const PRIMARY = "openai/gpt-5.5";
const SECONDARY = "openai/gpt-5.4";

function input(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    conversationId: "local-conv-new-channel",
    agentId: "agent-local-clara-synthetic",
    agent: {
      id: "agent-local-clara-synthetic",
      name: "Clara synthetic",
      description: null,
      system: "system",
      tags: [],
      model: PRIMARY,
      model_settings: { reasoning_effort: "low" },
    },
    body: {
      messages: [{ role: "user", content: "same input" }],
    } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-input-otid-1",
        role: "user",
        content: "same input",
        timestamp: 1,
      },
    ],
    clientTools: [],
    clientSkills: [],
    ...overrides,
  };
}

function assistantMessage(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
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

function quotaMessage(
  model: Model<string>,
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    ...assistantMessage(model, content, "error"),
    errorMessage:
      '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
  };
}

function streamFromEvents(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), { result: async () => finalMessage });
}

function quotaThenSuccessStream(dispatches: string[]): PiStreamFunction {
  return (model) => {
    dispatches.push(`${model.provider}/${model.id}`);
    if (model.id === "gpt-5.5") {
      const partial = quotaMessage(model, [
        { type: "text", text: "discard me" },
        {
          type: "toolCall",
          id: "discarded-call",
          name: "Write",
          arguments: { path: "must-not-run" },
        },
      ]);
      return streamFromEvents(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "discard me",
            partial,
          },
          {
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: partial.content[1] as Extract<
              AssistantMessage["content"][number],
              { type: "toolCall" }
            >,
            partial,
          },
          { type: "error", reason: "error", error: partial },
        ],
        partial,
      );
    }
    const success = assistantMessage(model, [
      { type: "text", text: "secondary answer" },
    ]);
    return streamFromEvents(
      [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "secondary answer",
          partial: success,
        },
        { type: "done", reason: "stop", message: success },
      ],
      success,
    );
  };
}

function effectfulSuccessStream(): PiStreamFunction {
  return (model) => {
    const success = assistantMessage(
      model,
      [
        { type: "text", text: "text-before-invalidation" },
        {
          type: "toolCall",
          id: "write-after-invalidation",
          name: "Write",
          arguments: { path: "must-not-run" },
        },
      ],
      "toolUse",
    );
    return streamFromEvents(
      [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "text-before-invalidation",
          partial: success,
        },
        {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: success.content[1] as Extract<
            AssistantMessage["content"][number],
            { type: "toolCall" }
          >,
          partial: success,
        },
        { type: "done", reason: "toolUse", message: success },
      ],
      success,
    );
  };
}

function syntheticPolicy(
  options: {
    current?: () => boolean;
    eligible?: (input: ProviderTurnInput) => boolean;
    maxBufferedBytes?: number;
    attempts?: NativeInferenceModelAttempt[];
  } = {},
): NativeInferenceFallbackPolicy {
  return {
    maxBufferedBytes: options.maxBufferedBytes,
    isAttemptCurrent: () => options.current?.() ?? true,
    resolveDestination(context, failure, attemptedModels) {
      if (failure.category !== "quota_exhausted") return null;
      if (options.eligible && !options.eligible(context.input)) return null;
      if (attemptedModels.includes(SECONDARY)) return null;
      return {
        model: SECONDARY,
        modelSettings: { reasoning_effort: "xhigh" },
      };
    },
    onModelAttempt(attempt) {
      options.attempts?.push(attempt);
    },
  };
}

async function collect(adapter: PiStreamAdapter, turnInput = input()) {
  const events: ProviderStreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of adapter.stream(turnInput)) events.push(event);
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

function outputText(events: ProviderStreamEvent[]): string {
  return events
    .filter(
      (
        event,
      ): event is Extract<ProviderStreamEvent, { type: "provider-part" }> =>
        event.type === "provider-part" && event.part.type === "text_delta",
    )
    .map((event) => (event.part.type === "text_delta" ? event.part.delta : ""))
    .join("");
}

describe("native inference fallback classifier", () => {
  test("uses structured status and code already preserved at the provider boundary", () => {
    expect(
      classifyNativeInferenceFailure({
        statusCode: 429,
        code: 1310,
        provider: "zai",
        message: "opaque",
      }),
    ).toEqual({
      category: "quota_exhausted",
      status: 429,
      code: "1310",
      provider: "zai",
    });
  });

  test("strictly parses only a complete provider HTTP envelope", () => {
    const envelope = parseNativeInferenceProviderErrorEnvelope(
      "zai",
      '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
    );
    expect(envelope).toEqual({
      source: "pi_provider_error",
      provider: "zai",
      status: 429,
      code: "1310",
    });
    expect(classifyNativeInferenceFailure(envelope).category).toBe(
      "quota_exhausted",
    );
    expect(
      parseNativeInferenceProviderErrorEnvelope(
        "zai",
        'prefix 429: {"code":"1310"}',
      ),
    ).toBeUndefined();
    expect(
      parseNativeInferenceProviderErrorEnvelope("zai", '429: {"code":'),
    ).toBeUndefined();
    expect(
      parseNativeInferenceProviderErrorEnvelope(
        "zai",
        "429 status code (no body)",
      ),
    ).toBeUndefined();
  });

  test.each([
    [{ message: "quoted HTTP 429 code 1310 quota" }, "other"],
    [new Error('429: {"code":"1310"}'), "other"],
    ['429: {"code":"1310"}', "other"],
    [{ status: 429, code: 14290 }, "transient_provider"],
    [{ status: 401, code: 1310 }, "authentication"],
    [{ status: 403, code: 1310 }, "permission"],
    [{ message: "silence" }, "other"],
    [{ status: 500, code: "tool_failure" }, "other"],
  ])("does not infer quota from negative case %#", (failure, category) => {
    expect(classifyNativeInferenceFailure(failure).category).toBe(
      category as NativeInferenceFailureCategory,
    );
  });
});

describe("native inference fallback buffered dispatch", () => {
  test.each(["abort", "owner", "manual"] as const)(
    "revalidates %s between flushed events before a tool can escape",
    async (invalidation) => {
      const controller = new AbortController();
      let ownerCurrent = true;
      let manualSelectionCurrent = true;
      const adapter = new PiStreamAdapter({
        stream: effectfulSuccessStream(),
        abortSignal: controller.signal,
        nativeInferenceFallback: {
          resolveDestination: () => null,
          isAttemptCurrent: () => ownerCurrent && manualSelectionCurrent,
        },
      });
      const iterator = adapter.stream(input())[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(
        !first.done && first.value.type === "provider-part"
          ? first.value.part.type
          : undefined,
      ).toBe("text_delta");

      if (invalidation === "abort") controller.abort();
      if (invalidation === "owner") ownerCurrent = false;
      if (invalidation === "manual") manualSelectionCurrent = false;

      await expect(iterator.next()).rejects.toThrow(
        "Native inference attempt was invalidated",
      );
    },
  );

  test.each([
    '429: {"code":',
    '429: {"code":"14290","message":"retry-after-ms: 0 "}',
    '401: {"code":"1310","message":"auth"}',
    '403: {"code":"1310","message":"permission"}',
    "429 status code (no body)",
    "quoted 429 code 1310",
  ])(
    "does not fall back for a non-qualifying provider envelope: %s",
    async (errorMessage) => {
      const dispatches: string[] = [];
      let resolutions = 0;
      const stream: PiStreamFunction = (model) => {
        dispatches.push(`${model.provider}/${model.id}`);
        const failure = {
          ...assistantMessage(model, [], "error"),
          errorMessage,
        };
        return streamFromEvents(
          [{ type: "error", reason: "error", error: failure }],
          failure,
        );
      };
      const policy = syntheticPolicy();
      const originalResolve = policy.resolveDestination;
      policy.resolveDestination = (...args) => {
        resolutions += 1;
        return originalResolve(...args);
      };
      const { events, error } = await collect(
        new PiStreamAdapter({ stream, nativeInferenceFallback: policy }),
      );
      expect(error).toBeDefined();
      expect(events.every((event) => event.type === "letta-chunk")).toBe(true);
      expect(dispatches).toEqual(
        errorMessage.includes("14290")
          ? [PRIMARY, PRIMARY, PRIMARY, PRIMARY]
          : [PRIMARY],
      );
      expect(resolutions).toBe(0);
    },
  );

  test("discards partial primary output and completes the same input on an approved secondary", async () => {
    const dispatches: string[] = [];
    const attempts: NativeInferenceModelAttempt[] = [];
    const turnInput = input();
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        nativeInferenceFallback: syntheticPolicy({ attempts }),
      }),
      turnInput,
    );

    expect(error).toBeUndefined();
    expect(dispatches).toEqual([PRIMARY, SECONDARY]);
    expect(outputText(events)).toBe("secondary answer");
    expect(JSON.stringify(events)).not.toContain("discard me");
    expect(JSON.stringify(events)).not.toContain("discarded-call");
    expect(turnInput.body).toEqual({
      messages: [{ role: "user", content: "same input" }],
    });
    expect(turnInput.uiMessages.map((message) => message.id)).toEqual([
      "ui-input-otid-1",
    ]);
    expect(attempts.filter((attempt) => attempt.outcome !== "started")).toEqual(
      [
        expect.objectContaining({
          model: PRIMARY,
          outcome: "quota",
          status: 429,
          code: "1310",
        }),
        expect.objectContaining({ model: SECONDARY, outcome: "success" }),
      ],
    );
    expect(
      attempts.find(
        (attempt) =>
          attempt.model === SECONDARY && attempt.outcome === "started",
      )?.effort,
    ).toBe("xhigh");
  });

  test("fails closed when the destination is incompatible or unapproved", async () => {
    const dispatches: string[] = [];
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        nativeInferenceFallback: {
          resolveDestination: () => null,
        },
      }),
    );
    expect(String(error)).toContain("Weekly/Monthly Limit Exhausted");
    expect(dispatches).toEqual([PRIMARY]);
    expect(events).toEqual([]);
  });

  test("rejects an unavailable destination before provider dispatch", async () => {
    const dispatches: string[] = [];
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        nativeInferenceFallback: {
          resolveDestination: () => ({
            model: "openai/not-an-available-model",
            modelSettings: { reasoning_effort: "xhigh" },
          }),
        },
      }),
    );
    expect(error).toBeDefined();
    expect(dispatches).toEqual([PRIMARY]);
    expect(events).toEqual([]);
  });

  test("fails closed before dispatch when manual selection or ownership changes", async () => {
    const dispatches: string[] = [];
    let current = true;
    const policy = syntheticPolicy({
      current: () => current,
    });
    policy.resolveDestination = (...args) => {
      current = false;
      return syntheticPolicy().resolveDestination(...args);
    };
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        nativeInferenceFallback: policy,
      }),
    );
    expect(error?.constructor.name).toBe(
      "NativeInferenceAttemptInvalidatedError",
    );
    expect(dispatches).toEqual([PRIMARY]);
    expect(events).toEqual([]);
  });

  test("does not dispatch a fallback after the owning turn is aborted", async () => {
    const dispatches: string[] = [];
    const controller = new AbortController();
    const policy = syntheticPolicy();
    policy.resolveDestination = (...args) => {
      controller.abort();
      return syntheticPolicy().resolveDestination(...args);
    };
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        abortSignal: controller.signal,
        nativeInferenceFallback: policy,
      }),
    );
    expect(error?.constructor.name).toBe(
      "NativeInferenceAttemptInvalidatedError",
    );
    expect(dispatches).toEqual([PRIMARY]);
    expect(events).toEqual([]);
  });

  test("fails visibly without retry after the bounded output buffer is exceeded", async () => {
    const dispatches: string[] = [];
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream: quotaThenSuccessStream(dispatches),
        nativeInferenceFallback: syntheticPolicy({ maxBufferedBytes: 10 }),
      }),
    );
    expect(error?.constructor.name).toBe("NativeInferenceBufferLimitError");
    expect(dispatches).toEqual([PRIMARY]);
    expect(events).toEqual([]);
  });

  test("terminates a finite chain when the secondary also exhausts quota", async () => {
    const dispatches: string[] = [];
    const stream: PiStreamFunction = (model) => {
      dispatches.push(`${model.provider}/${model.id}`);
      const failure = quotaMessage(model);
      return streamFromEvents(
        [{ type: "error", reason: "error", error: failure }],
        failure,
      );
    };
    const { events, error } = await collect(
      new PiStreamAdapter({
        stream,
        nativeInferenceFallback: syntheticPolicy(),
      }),
    );
    expect(String(error)).toContain("Weekly/Monthly Limit Exhausted");
    expect(dispatches).toEqual([PRIMARY, SECONDARY]);
    expect(events).toEqual([]);
  });

  test("applies identity and proven-delegation eligibility without conversation enumeration", async () => {
    const eligible = (turnInput: ProviderTurnInput) => {
      if (turnInput.agentId === "agent-local-clara-synthetic") return true;
      const lineage = (
        turnInput.body as { delegation?: Record<string, unknown> }
      ).delegation;
      return (
        lineage?.parentAgentId === "agent-local-clara-synthetic" &&
        lineage.receipt === "receipt-live" &&
        lineage.owner === "owner-live" &&
        lineage.cycle !== true &&
        turnInput.agentId !== "agent-local-nina-synthetic"
      );
    };

    for (const [name, turnInput, expectedCalls] of [
      ["new channel", input({ conversationId: "never-configured" }), 2],
      [
        "delegated child",
        input({
          agentId: "agent-local-child-synthetic",
          body: {
            messages: [{ role: "user", content: "child task" }],
            delegation: {
              parentAgentId: "agent-local-clara-synthetic",
              receipt: "receipt-live",
              owner: "owner-live",
            },
          } as never,
        }),
        2,
      ],
      [
        "unproven peer",
        input({
          agentId: "agent-local-peer-synthetic",
          body: {
            delegation: { parentAgentId: "agent-local-clara-synthetic" },
          } as never,
        }),
        1,
      ],
      [
        "excluded agent",
        input({
          agentId: "agent-local-nina-synthetic",
          body: {
            delegation: {
              parentAgentId: "agent-local-clara-synthetic",
              receipt: "receipt-live",
              owner: "owner-live",
            },
          } as never,
        }),
        1,
      ],
      [
        "cyclic lineage",
        input({
          agentId: "agent-local-child-synthetic",
          body: {
            delegation: {
              parentAgentId: "agent-local-clara-synthetic",
              receipt: "receipt-live",
              owner: "owner-live",
              cycle: true,
            },
          } as never,
        }),
        1,
      ],
    ] as const) {
      const dispatches: string[] = [];
      await collect(
        new PiStreamAdapter({
          stream: quotaThenSuccessStream(dispatches),
          nativeInferenceFallback: syntheticPolicy({ eligible }),
        }),
        turnInput,
      );
      expect(dispatches.length, name).toBe(expectedCalls);
    }
  });
});
