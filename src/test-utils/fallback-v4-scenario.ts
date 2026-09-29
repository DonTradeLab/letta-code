import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackendForMode } from "@/backend";
import {
  registerPiProvider,
  unregisterPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  disableLocalBackendMemfsForProcess,
  resetLocalBackendMemfsForProcess,
} from "@/backend/local/paths";
import {
  clearTools,
  executeTool,
  getClientToolsFromRegistry,
  loadSpecificTools,
} from "@/tools/manager";

export interface FallbackScenarioOptions {
  listener?: boolean;
  partial?: boolean;
  manualChange?: boolean;
  lowPrimaryEffort?: boolean;
  unlisted?: boolean;
  missingReserve?: boolean;
  toolsIncompatible?: boolean;
  enabled?: boolean;
  status?: number;
  incompatible?: boolean;
  cancel?: boolean;
  timeout?: boolean;
}

/** Real factory + real pi-ai HTTP drivers + real Write tool. No effect is written by this harness. */
export async function runFallbackV4Scenario(
  options: FallbackScenarioOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fallback-v4-"));
  const storage = join(root, "backend");
  await mkdir(storage);
  const effect = join(root, "effect.txt");
  const effectTool = options.listener ? "Bash" : "Write";
  const requests: Array<{
    model: string;
    messages: unknown;
    effort: unknown;
    credentialMatchedReference: boolean;
  }> = [];
  let invalidateSelection = async () => {};
  const server = createServer((req, res) => {
    const data: Buffer[] = [];
    req.on("data", (chunk) => data.push(Buffer.from(chunk)));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(data).toString());
      requests.push({
        model: body.model,
        messages: body.messages,
        effort: body.reasoning_effort,
        credentialMatchedReference:
          req.headers.authorization === `Bearer fake-v4-${body.model}`,
      });
      const hasToolResult = body.messages.some(
        (m: { role: string }) => m.role === "tool",
      );
      if (body.model === "primary" && hasToolResult && !options.partial) {
        if (options.timeout || options.cancel) return;
        if (options.manualChange) await invalidateSelection();
        res.writeHead(options.status ?? 429, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: { code: "1310", message: "Weekly/Monthly Limit Exhausted" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `response-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (body.model === "primary" && hasToolResult && options.partial) {
        send({ role: "assistant", content: "must-not-escape-primary" }, null);
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: "must-not-run",
                type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify({
                    file_path: join(root, "forbidden.txt"),
                    content: "must not execute",
                  }),
                },
              },
            ],
          },
          null,
        );
        res.end(
          `data: ${JSON.stringify({ error: { message: '429: {"code":"1310","message":"Quota after partial SSE"}' } })}\n\n`,
        );
        return;
      }
      if (!hasToolResult) {
        send(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-once",
                type: "function",
                function: {
                  name: effectTool,
                  arguments: JSON.stringify(
                    effectTool === "Bash"
                      ? {
                          command: `printf 'one real tool effect\\n' >> "${effect}"`,
                          description: "Append one isolated test effect",
                        }
                      : {
                          file_path: effect,
                          content: "one real tool effect\n",
                        },
                  ),
                },
              },
            ],
          },
          null,
        );
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "task-completed-on-reserve" }, null);
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "[::1]"
    )
      throw new Error("Non-loopback fetch blocked in V4 proof");
    return realFetch(input, init);
  }) as typeof fetch;
  const previousStorage = process.env.LETTA_LOCAL_BACKEND_DIR;
  const previousMode = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
  process.env.LETTA_LOCAL_BACKEND_DIR = storage;
  disableLocalBackendMemfsForProcess();
  for (const provider of ["v4-primary", "v4-reserve"]) {
    const id = provider === "v4-primary" ? "primary" : "reserve";
    registerPiProvider(provider, {
      api: "openai-completions",
      baseUrl,
      apiKey: `fake-${provider}`,
      models: [
        {
          id,
          name: id,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow:
            provider === "v4-reserve" && options.incompatible ? 4096 : 128000,
          maxTokens: 4096,
        },
      ],
    });
  }
  try {
    const bootstrap = getBackendForMode("local");
    const agent = await bootstrap.createAgent({
      name: "fallback-v4-fixture",
      model: "v4-primary/primary",
      model_settings: {
        context_window_limit: 128000,
        max_tokens: 4096,
        reasoning_effort: options.lowPrimaryEffort ? "low" : "high",
      },
    } as never);
    const conversation = await bootstrap.createConversation({
      agent_id: agent.id,
    } as never);
    await writeFile(
      join(storage, "native-inference-fallback.json"),
      JSON.stringify({
        version: 1,
        enabled: options.enabled !== false,
        owner: "native-inference",
        externalController: "disabled-for-scopes",
        timeoutMs: options.timeout ? 80 : 5000,
        scopes: [
          {
            agentId: options.unlisted ? "agent-local-unlisted" : agent.id,
            lineage: "self",
            chain: [
              {
                model: "v4-primary/primary",
                provider: "v4-primary",
                credentialProvider: "v4-primary",
                contextWindow: 128000,
                maxOutputTokens: 4096,
                effort: "high",
                tools: true,
                input: ["text"],
              },
              {
                model: options.missingReserve
                  ? "v4-reserve/missing"
                  : "v4-reserve/reserve",
                provider: "v4-reserve",
                credentialProvider: "v4-reserve",
                contextWindow: 128000,
                maxOutputTokens: 4096,
                effort: "high",
                tools: !options.toolsIncompatible,
                input: ["text"],
              },
            ],
          },
        ],
      }),
    );
    // The actual production factory, NOT a directly constructed adapter/controller/backend.
    const backend = getBackendForMode("local");
    invalidateSelection = async () => {
      await backend.updateConversation(conversation.id, {
        model: "v4-reserve/reserve",
      } as never);
    };
    await loadSpecificTools([effectTool]);
    if (options.listener) {
      const { runFallbackV4Listener } = await import("./fallback-v4-listener");
      const listener = await runFallbackV4Listener(
        backend,
        agent.id,
        conversation.id,
        root,
      );
      const history = (
        await backend.listConversationMessages(conversation.id, {
          limit: 100,
          order: "asc",
        } as never)
      ).getPaginatedItems();
      const content = await readFile(effect, "utf8");
      return {
        runtime: process.versions.bun
          ? `bun ${process.versions.bun}`
          : `node ${process.version}`,
        options,
        root,
        taskId: "v4-task-input",
        agentId: agent.id,
        conversationId: conversation.id,
        requests,
        effects: history.filter((m) => m.message_type === "tool_return_message")
          .length,
        toolReturn: "listener-executed",
        effect: content,
        chunks: history as unknown as Array<Record<string, unknown>>,
        history,
        listener,
      };
    }
    const chunks: Array<Record<string, unknown>> = [];
    const body = {
      agent_id: agent.id,
      client_tools: getClientToolsFromRegistry(),
      messages: [
        {
          role: "user",
          content: "write once then answer",
          otid: "v4-task-input",
          client_message_id: "v4-task-input",
        },
      ],
    };
    const first = await backend.createConversationMessageStream(
      conversation.id,
      body as never,
    );
    for await (const chunk of first)
      chunks.push(chunk as unknown as Record<string, unknown>);
    const approval = chunks.find(
      (c) => c.message_type === "approval_request_message",
    ) as
      | {
          tool_call?: { tool_call_id: string; name: string; arguments: string };
        }
      | undefined;
    const call = approval?.tool_call;
    assert(
      call,
      `actual provider must produce a tool call: ${JSON.stringify(chunks)}`,
    );
    let effects = 0;
    const result = await executeTool(call.name, JSON.parse(call.arguments), {
      toolCallId: call.tool_call_id,
      onFileWrite: () => {
        effects += 1;
      },
    });
    assert.equal(result.status, "success", JSON.stringify(result));
    const next = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        client_tools: getClientToolsFromRegistry(),
        messages: [
          {
            type: "approval",
            otid: "v4-approval-input",
            approvals: [
              {
                type: "tool",
                tool_call_id: call.tool_call_id,
                tool_return: result.toolReturn,
                status: result.status,
              },
            ],
          },
        ],
      } as never,
    );
    const timer = options.cancel
      ? setTimeout(() => next.controller.abort(), 50)
      : undefined;
    try {
      for await (const chunk of next)
        chunks.push(chunk as unknown as Record<string, unknown>);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const history = await backend.listConversationMessages(conversation.id, {
      limit: 100,
      order: "asc",
    } as never);
    const report = {
      listener: undefined,
      runtime: process.versions.bun
        ? `bun ${process.versions.bun}`
        : `node ${process.version}`,
      options,
      root,
      taskId: "v4-task-input",
      agentId: agent.id,
      conversationId: conversation.id,
      requests,
      effects,
      toolReturn: result.status,
      effect: await readFile(effect, "utf8"),
      chunks,
      history: history.getPaginatedItems(),
    };
    return report;
  } finally {
    globalThis.fetch = realFetch;
    clearTools();
    unregisterPiProvider("v4-primary");
    unregisterPiProvider("v4-reserve");
    resetLocalBackendMemfsForProcess();
    if (previousMode === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = previousMode;
    if (previousStorage === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    else process.env.LETTA_LOCAL_BACKEND_DIR = previousStorage;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
