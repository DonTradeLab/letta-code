import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "@/websocket/listener/mod-adapter";
import { getOrCreateConversationPermissionModeStateRef } from "@/websocket/listener/permission-mode";
import { setActiveRuntime } from "@/websocket/listener/runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { handleIncomingMessage } from "@/websocket/listener/turn";
import { __listenerWarmupTestUtils } from "@/websocket/listener/warmup";

/** One real listener submission; no direct tool execution or result injection. */
export async function runFallbackV4Listener(
  backend: Backend,
  agentId: string,
  conversationId: string,
  root: string,
) {
  __testSetBackend(backend);
  await settingsManager.reset();
  await settingsManager.initialize();
  const modDir = join(root, "mods");
  const cacheDir = join(root, "cache");
  await mkdir(modDir);
  await mkdir(cacheDir);
  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  const listener = createRuntime();
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: modDir,
    cacheDirectory: cacheDir,
  });
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  const mode = getOrCreateConversationPermissionModeStateRef(
    listener,
    agentId,
    conversationId,
  );
  mode.mode = "unrestricted";
  const payloads: Record<string, unknown>[] = [];
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => {
      payloads.push(JSON.parse(payload));
    },
  };
  try {
    await handleIncomingMessage(
      {
        type: "message",
        agentId,
        conversationId,
        processOwnedTurn: true,
        excludeInteractiveTools: true,
        messages: [
          {
            role: "user",
            content: "write once then answer",
            client_message_id: "v4-task-input",
          },
        ],
      },
      transport,
      runtime,
      undefined,
      undefined,
      "v4-native-task",
    );
    return { payloads, lifecycle: runtime.turnLifecycle.snapshot().kind };
  } finally {
    disposeListenerModAdapter(listener);
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
    await settingsManager.reset();
  }
}
