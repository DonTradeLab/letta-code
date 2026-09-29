import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRecord } from "@/utils/type-guards";

function stripOpenAIResponsesReplayItemIds(
  payload: unknown,
): unknown | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

  let changed = false;
  const input = payload.input.map((item) => {
    if (!isRecord(item) || !("id" in item)) return item;
    const type = item.type;
    if (
      type !== "reasoning" &&
      type !== "message" &&
      type !== "function_call"
    ) {
      return item;
    }

    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });

  return changed ? { ...payload, input } : undefined;
}

export function withOpenAIResponsesReplayIdSanitizer(
  existing: SimpleStreamOptions["onPayload"] | undefined,
): SimpleStreamOptions["onPayload"] {
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }

    const sanitized = stripOpenAIResponsesReplayItemIds(next);
    if (sanitized !== undefined) return sanitized;
    return upstreamChanged ? next : undefined;
  };
}

export function withAnthropicOutputEffort(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  effort: string | undefined,
): SimpleStreamOptions["onPayload"] | undefined {
  if (!effort) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) return upstreamChanged ? next : undefined;
    const outputConfig = isRecord(next.output_config) ? next.output_config : {};
    return {
      ...next,
      output_config: {
        ...outputConfig,
        effort,
      },
    };
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function anthropicEffortForSettings(
  modelSettings: Record<string, unknown>,
): string | undefined {
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  return (
    stringValue(modelSettings.effort) ??
    stringValue(nestedReasoning?.reasoning_effort) ??
    stringValue(modelSettings.reasoning_effort)
  );
}

export function maxTokensForSettings(
  modelSettings: Record<string, unknown>,
): number | undefined {
  const maxTokens = modelSettings.max_tokens;
  return typeof maxTokens === "number" && Number.isFinite(maxTokens)
    ? maxTokens
    : undefined;
}

export async function sleepWithAbort(
  delayMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0) return;
  if (abortSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function serviceTierForSettings(
  model: Model<string>,
  modelSettings: Record<string, unknown>,
): "priority" | undefined {
  if (model.api !== "openai-codex-responses") return undefined;
  return modelSettings.service_tier === "priority" ? "priority" : undefined;
}
