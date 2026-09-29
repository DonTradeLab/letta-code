import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { type Instance, render } from "ink";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { App } from "@/cli/App";
import { setTuiAdmissionTestHook } from "@/cli/helpers/tui-admission-test-hooks";
import { settingsManager } from "@/settings-manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

class TuiOutputStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  text = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.text += chunk.toString();
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(10);
  }
  if (!predicate()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

function createOneShotPreparationGate(): {
  observed: Promise<void>;
  release: () => void;
} {
  let resolveObserved: (() => void) | null = null;
  let resolveRelease: (() => void) | null = null;
  const observed = new Promise<void>((resolve) => {
    resolveObserved = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let used = false;
  setTuiAdmissionTestHook(async () => {
    if (used) return;
    used = true;
    resolveObserved?.();
    await released;
  });
  return {
    observed,
    release: () => resolveRelease?.(),
  };
}

function notification(summary: string): string {
  return formatTaskNotification({
    taskId: `admission-${summary}`,
    status: "completed",
    summary,
    result: "done",
    outputFile: "/tmp/tui-admission-test.log",
  });
}

class RecordingExecutor implements HeadlessTurnExecutor {
  readonly inputs: HeadlessTurnExecutorInput[] = [];

  async execute(input: HeadlessTurnExecutorInput) {
    this.inputs.push(input);
    return createAssistantMessageStream();
  }
}

const renderedInstances = new Set<Instance>();
let previousBackendMode: BackendMode;
let previousHome: string | undefined;
let previousDisableExtensions: string | undefined;
let previousDisableMods: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  clearPendingMessages();
  setTuiAdmissionTestHook(null);
  previousHome = process.env.HOME;
  previousDisableExtensions = process.env.LETTA_DISABLE_EXTENSIONS;
  previousDisableMods = process.env.LETTA_DISABLE_MODS;
  delete process.env.LETTA_DISABLE_EXTENSIONS;
  delete process.env.LETTA_DISABLE_MODS;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-admission-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  setTuiAdmissionTestHook(null);
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  await settingsManager.reset();
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousDisableExtensions === undefined) {
    delete process.env.LETTA_DISABLE_EXTENSIONS;
  } else {
    process.env.LETTA_DISABLE_EXTENSIONS = previousDisableExtensions;
  }
  if (previousDisableMods === undefined) {
    delete process.env.LETTA_DISABLE_MODS;
  } else {
    process.env.LETTA_DISABLE_MODS = previousDisableMods;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

async function renderTestApp(
  executor: HeadlessTurnExecutor,
  options: { modSource?: string } = {},
): Promise<{
  stdin: NodeJS.ReadStream;
  instance: Instance;
  output: TuiOutputStream;
  agentId: string;
  conversationId: string;
}> {
  const agentId = `agent-tui-admission-${Math.random().toString(16).slice(2)}`;
  const backend = new FakeHeadlessBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });

  let agentModsDirectoryOverride: string | null = null;
  if (options.modSource) {
    agentModsDirectoryOverride = join(tempHome, `mods-${agentId}`);
    mkdirSync(agentModsDirectoryOverride, { recursive: true });
    writeFileSync(
      join(agentModsDirectoryOverride, "admission-test.ts"),
      options.modSource,
    );
  }

  const stdin = createInputStream();
  const stdout = new TuiOutputStream() as TuiOutputStream & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      modsDisabled={!options.modSource}
      agentModsDirectoryOverride={agentModsDirectoryOverride}
      systemInfoReminderEnabled={false}
    />,
    {
      stdout,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");
  if (options.modSource) await sleep(600);
  return {
    stdin,
    instance,
    output: stdout,
    agentId,
    conversationId: conversation.id,
  };
}

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  await sleep(100);
  stdin.push(text);
  await sleep(30);
  stdin.push("\r");
}

function bodies(inputs: readonly HeadlessTurnExecutorInput[]): string[] {
  return inputs.map((input) => JSON.stringify(input.body));
}

function countAcross(values: readonly string[], needle: string): number {
  return values.reduce(
    (count, value) => count + value.split(needle).length - 1,
    0,
  );
}

describe("TUI admission recovery", () => {
  test("direct preparation owns busy; a second prompt and new event drain once after commit", async () => {
    const executor = new RecordingExecutor();
    const { stdin } = await renderTestApp(executor);
    const gate = createOneShotPreparationGate();

    await typePrompt(stdin, "first direct prompt");
    await gate.observed;
    await typePrompt(stdin, "second prompt while preparing");
    addToMessageQueue({
      kind: "task_notification",
      text: notification("event during preparation"),
    });
    await sleep(100);
    expect(executor.inputs).toHaveLength(0);

    gate.release();
    await waitFor(() => executor.inputs.length === 2, "both admitted turns");
    const sent = bodies(executor.inputs);
    expect(sent[0]).toContain("first direct prompt");
    expect(sent[1]).toContain("second prompt while preparing");
    expect(sent[1]).toContain("event during preparation");
    expect(countAcross(sent, "first direct prompt")).toBe(1);
    expect(countAcross(sent, "second prompt while preparing")).toBe(1);
  }, 15_000);

  test("Esc during preparation retains the old draft when a newer draft exists", async () => {
    const executor = new RecordingExecutor();
    const { stdin } = await renderTestApp(executor);
    const gate = createOneShotPreparationGate();

    await typePrompt(stdin, "older refused draft");
    await gate.observed;
    await sleep(200);
    stdin.push("newer visible draft");
    await sleep(250);
    stdin.push("\u001b");
    await sleep(50);
    gate.release();

    await sleep(300);
    expect(executor.inputs).toHaveLength(0);
    stdin.push("\r");
    await waitFor(
      () => bodies(executor.inputs).join("\n").includes("newer visible draft"),
      "both retained drafts to send",
    );
    const sent = bodies(executor.inputs);
    const joined = sent.join("\n");
    expect(joined).toContain("older refused draft");
    expect(joined).toContain("newer visible draft");
    expect(joined.indexOf("older refused draft")).toBeLessThan(
      joined.indexOf("newer visible draft"),
    );
    expect(countAcross(sent, "older refused draft")).toBe(1);
    expect(countAcross(sent, "newer visible draft")).toBe(1);
  }, 15_000);

  test("a queue batch is peeked exactly; enqueue during preparation becomes the next turn", async () => {
    const executor = new RecordingExecutor();
    await renderTestApp(executor);
    const gate = createOneShotPreparationGate();

    addToMessageQueue({ kind: "user", text: "planned queue item" });
    await gate.observed;
    addToMessageQueue({ kind: "user", text: "arrived after peek" });
    await sleep(100);
    expect(executor.inputs).toHaveLength(0);

    gate.release();
    await waitFor(() => executor.inputs.length === 2, "two exact queue turns");
    const sent = bodies(executor.inputs);
    expect(sent[0]).toContain("planned queue item");
    expect(sent[0]).not.toContain("arrived after peek");
    expect(sent[1]).toContain("arrived after peek");
    expect(countAcross(sent, "planned queue item")).toBe(1);
    expect(countAcross(sent, "arrived after peek")).toBe(1);
  }, 15_000);

  test("pre-admission preparation exception is visible, preserves the batch, and waits for explicit retry", async () => {
    const executor = new RecordingExecutor();
    const { stdin, output } = await renderTestApp(executor);
    let fail = true;
    setTuiAdmissionTestHook(() => {
      if (!fail) return;
      fail = false;
      throw new Error("injected reminder provider failure");
    });

    addToMessageQueue({ kind: "user", text: "preserved after failure" });
    await waitFor(
      () => output.text.includes("injected reminder provider failure"),
      "visible preparation error",
    );
    await sleep(250);
    expect(executor.inputs).toHaveLength(0);

    setTuiAdmissionTestHook(null);
    stdin.push("\r");
    await waitFor(() => executor.inputs.length === 1, "explicit queue retry");
    const sent = bodies(executor.inputs);
    expect(sent[0]).toContain("preserved after failure");
    expect(countAcross(sent, "preserved after failure")).toBe(1);
  }, 15_000);

  test("an old-conversation queue item never crosses into the active transcript", async () => {
    const executor = new RecordingExecutor();
    const { agentId, output } = await renderTestApp(executor);

    addToMessageQueue({
      kind: "user",
      text: "belongs to old transcript",
      agentId,
      conversationId: "conversation-old",
    });
    await sleep(400);

    expect(executor.inputs).toHaveLength(0);
    expect(output.text).toContain("belongs to old transcript");
  });

  test("turn_start hook cancellation is visible and does not commit the queued batch", async () => {
    const executor = new RecordingExecutor();
    const { stdin, output } = await renderTestApp(executor, {
      modSource: `export default function(letta) {
        letta.events.on("turn_start", () => ({
          cancel: { reason: "blocked by admission test hook" },
        }));
      }`,
    });

    addToMessageQueue({ kind: "user", text: "blocked queue item" });
    await waitFor(
      () => output.text.includes("blocked by admission test hook"),
      "turn_start cancellation",
    );
    expect(output.text).toContain("blocked queue item");
    expect(executor.inputs).toHaveLength(0);

    // A blocked attempt does not spin. An explicit Enter retries and is blocked
    // again, still without consuming or sending the item.
    await sleep(250);
    stdin.push("\r");
    await sleep(250);
    expect(executor.inputs).toHaveLength(0);
    expect(output.text).toContain("blocked queue item");
  }, 15_000);

  test("awaited turn_end continuation stays ahead of a third queued turn", async () => {
    const executor = new RecordingExecutor();
    const { stdin } = await renderTestApp(executor, {
      modSource: `export default function(letta) {
        let continued = false;
        letta.events.on("turn_end", async () => {
          if (continued) return;
          continued = true;
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { continue: "child continuation" };
        });
      }`,
    });

    await typePrompt(stdin, "parent turn");
    await waitFor(() => executor.inputs.length === 1, "the parent turn");
    addToMessageQueue({ kind: "user", text: "third queued turn" });

    await waitFor(() => executor.inputs.length === 3, "child then queued turn");
    const sent = bodies(executor.inputs);
    expect(sent[0]).toContain("parent turn");
    expect(sent[1]).toContain("child continuation");
    expect(sent[2]).toContain("third queued turn");
  }, 15_000);
});
