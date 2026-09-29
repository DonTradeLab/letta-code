import type { NativeInferenceFallbackPolicy } from "@/backend/dev/native-inference-fallback";
import {
  reasoningForSettings,
  resolvePiModelForAgent,
} from "@/backend/dev/pi-model-factory";
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  estimateProviderContextTokens,
  type ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import type { LocalAgentRecord } from "./local-types";
import type {
  LoadedNativeFallbackConfig,
  NativeFallbackTarget,
} from "./native-fallback-config";

export type ReadFallbackSelection = (
  input: ProviderTurnInput,
) => LocalAgentRecord | undefined;
export interface NativeFallbackAudit {
  event: "attempt" | "rejected";
  agentId: string;
  conversationId: string;
  taskId: string;
  lineage: "self";
  owner: "native-inference";
  [key: string]: unknown;
}

function selection(agent: LocalAgentRecord): string {
  return JSON.stringify([agent.model, agent.model_settings]);
}

/** One policy per inference. The original stored selection, not an override, fences every attempt. */
export function createNativeFallbackPolicy(
  loaded: LoadedNativeFallbackConfig | undefined,
  input: ProviderTurnInput,
  storageDir: string,
  runtime: LocalPiModelsRuntime,
  readSelection: ReadFallbackSelection | undefined,
  observe: (event: NativeFallbackAudit) => void,
): NativeInferenceFallbackPolicy | undefined {
  const scope = loaded?.config.scopes.find(
    (entry) => entry.agentId === input.agentId,
  );
  if (!loaded || !scope) return undefined;
  const original = selection(input.agent);
  const verifiedCatalog = new Map<string, string>();
  const catalogSnapshot = (handle: string) => {
    const slash = handle.indexOf("/");
    return JSON.stringify(
      runtime.getModel(handle.slice(0, slash), handle.slice(slash + 1)),
    );
  };
  const started = Date.now();
  const lastUser = input.uiMessages.findLast(
    (message) => message.role === "user",
  );
  const taskId =
    lastUser?.role === "user" ? (lastUser.otid ?? lastUser.id) : "unknown";
  const identity = {
    agentId: input.agentId,
    conversationId: input.conversationId,
    taskId,
    lineage: "self" as const,
    owner: "native-inference" as const,
  };
  const reject = (reason: string): never => {
    observe({ ...identity, event: "rejected", reason });
    throw new Error(`Native inference fallback refused: ${reason}`);
  };
  const checkTarget = async (destination: NativeFallbackTarget) => {
    const resolved = await resolvePiModelForAgent(
      destination.model,
      {},
      {
        modelsRuntime: runtime,
        localProviderAuthStorageDir: storageDir,
        abortSignal: input.abortSignal,
      },
    );
    if (resolved.model.provider !== destination.provider || !resolved.apiKey)
      reject("provider/credential reference unavailable");
    const requiredContext = Number(
      input.agent.model_settings.context_window_limit ?? 0,
    );
    if (
      destination.contextWindow > resolved.model.contextWindow ||
      destination.contextWindow < requiredContext ||
      destination.maxOutputTokens > resolved.model.maxTokens ||
      destination.contextWindow <
        (estimateProviderContextTokens(input) ?? Infinity) +
          destination.maxOutputTokens
    )
      reject("context capacity incompatible");
    const images = input.uiMessages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((part) => part.type === "image"),
    );
    if (
      images &&
      (!destination.input.includes("image") ||
        !resolved.model.input.includes("image"))
    )
      reject("image capacity incompatible");
    if (input.clientTools.length > 0 && !destination.tools)
      reject("tool capacity incompatible");
    if (
      !resolved.model.reasoning ||
      reasoningForSettings(
        { reasoning_effort: destination.effort },
        destination.model,
        resolved.model,
      ) !== destination.effort
    )
      reject("effort incompatible (no silent downgrade)");
    const mapping = resolved.model.thinkingLevelMap?.[destination.effort];
    if (mapping !== undefined && mapping !== destination.effort)
      reject("provider effort mapping incompatible");
    const snapshot = catalogSnapshot(destination.model);
    if (!snapshot) return reject("catalog entry unavailable at validation");
    verifiedCatalog.set(destination.model, snapshot);
    return {
      model: destination.model,
      modelSettings: {
        context_window_limit: destination.contextWindow,
        max_tokens: destination.maxOutputTokens,
        reasoning_effort: destination.effort,
      },
    };
  };
  return {
    async isAttemptCurrent(context) {
      const current = readSelection?.(input);
      const verified = verifiedCatalog.get(context.model);
      return (
        (!verified || catalogSnapshot(context.model) === verified) &&
        !input.abortSignal?.aborted &&
        Date.now() - started < loaded.config.timeoutMs &&
        loaded.isCurrent() &&
        !!current &&
        selection(current) === original
      );
    },
    async resolveDestination(_context, failure, attemptedModels) {
      if (failure.category !== "quota_exhausted") return null;
      const primary = scope.chain[0];
      if (!primary || input.agent.model !== primary.model)
        return reject("primary selection is outside configured chain");
      if (
        reasoningForSettings(input.agent.model_settings, input.agent.model) !==
        primary.effort
      )
        return reject("primary effort is outside configured chain");
      const next = scope.chain[attemptedModels.length];
      if (!next) return reject("approved chain exhausted");
      try {
        return await checkTarget(next);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Native inference fallback refused:")
        )
          throw error;
        return reject("destination could not be resolved");
      }
    },
    onModelAttempt(attempt) {
      observe({ ...identity, event: "attempt", ...attempt });
    },
  };
}
