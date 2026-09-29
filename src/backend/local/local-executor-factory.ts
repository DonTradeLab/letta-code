import {
  DeterministicPongExecutor,
  DeterministicReflectionExecutor,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import type { NativeInferenceFallbackPolicy } from "@/backend/dev/native-inference-fallback";
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  type LocalContextPressure,
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import {
  ProviderTurnExecutor,
  providerLettaChunk,
} from "@/backend/dev/provider-turn-executor";
import type { LocalCompactionStats } from "./compaction";
import type { LocalMessage } from "./local-message";
import { loadNativeFallbackConfig } from "./native-fallback-config";
import {
  createNativeFallbackPolicy,
  type NativeFallbackAudit,
  type ReadFallbackSelection,
} from "./native-fallback-policy";

export type LocalBackendExecutionMode =
  | "pi"
  | "deterministic"
  | "deterministic-reflection";

export interface CreateLocalExecutorOptions {
  storageDir: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  stream?: PiStreamFunction;
  /** Test seam. Production derives the policy from validated local configuration. */
  nativeInferenceFallback?: NativeInferenceFallbackPolicy;
}

type LocalCompactionCallback = (
  input: ProviderTurnInput,
  trigger: unknown,
) => Promise<{
  uiMessages: LocalMessage[];
  summary: string;
  stats?: LocalCompactionStats;
} | null>;

export function createLocalExecutor(
  options: CreateLocalExecutorOptions,
  modelsRuntime: LocalPiModelsRuntime,
  onContextWindowOverflow?: (
    input: ProviderTurnInput,
    error: unknown,
  ) => ReturnType<LocalCompactionCallback>,
  onContextPressure?: (
    input: ProviderTurnInput,
    pressure: LocalContextPressure,
  ) => ReturnType<LocalCompactionCallback>,
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>,
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>,
  readFallbackSelection?: ReadFallbackSelection,
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  if (options.executionMode === "deterministic-reflection") {
    return new DeterministicReflectionExecutor();
  }
  const loaded = loadNativeFallbackConfig(options.storageDir);
  if (loaded && options.nativeInferenceFallback) {
    throw new Error("Cannot install two native inference fallback policies");
  }
  return new ProviderTurnExecutor({
    async *stream(originalInput) {
      const scoped = loaded?.config.scopes.some(
        (scope) => scope.agentId === originalInput.agentId,
      );
      const signal =
        scoped && loaded
          ? AbortSignal.any([
              ...(originalInput.abortSignal ? [originalInput.abortSignal] : []),
              AbortSignal.timeout(loaded.config.timeoutMs),
            ])
          : options.nativeInferenceFallback
            ? originalInput.abortSignal
            : undefined;
      const input = { ...originalInput, abortSignal: signal };
      const observations: NativeFallbackAudit[] = [];
      const policy =
        options.nativeInferenceFallback ??
        createNativeFallbackPolicy(
          loaded,
          input,
          options.storageDir,
          modelsRuntime,
          readFallbackSelection,
          (event) => observations.push(event),
        );
      const adapter = new PiStreamAdapter({
        stream: options.stream,
        localProviderAuthStorageDir: options.storageDir,
        modelsRuntime,
        onContextWindowOverflow,
        onContextPressure,
        onLlmStart,
        onLlmEnd,
        nativeInferenceFallback: policy,
        abortSignal: signal,
      });
      function* drain() {
        for (const event of observations.splice(0)) {
          yield providerLettaChunk({
            message_type: "event_message",
            event_type: "native_inference_fallback",
            event_data: event,
          } as never);
        }
      }
      try {
        for await (const event of adapter.stream(input)) {
          yield* drain();
          // Diagnostic delivery is also an await boundary. Never deliver stale model output.
          if (
            signal?.aborted ||
            (policy?.isAttemptCurrent &&
              !(await policy.isAttemptCurrent({
                input,
                model: input.agent.model,
                attempt: 0,
              })))
          ) {
            throw new Error(
              "Native inference attempt invalidated before delivery",
            );
          }
          yield event;
        }
      } finally {
        yield* drain();
      }
    },
  });
}
