import { isRecord } from "@/utils/type-guards";
import type {
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./provider-turn-executor";

export type NativeInferenceFailureCategory =
  | "quota_exhausted"
  | "transient_provider"
  | "authentication"
  | "permission"
  | "other";

export interface NativeInferenceFailure {
  category: NativeInferenceFailureCategory;
  provider?: string;
  status?: number;
  code?: string;
}

export interface NativeInferenceProviderErrorEnvelope {
  source: "pi_provider_error";
  provider?: string;
  status: number;
  code?: string;
}

export interface NativeInferenceFallbackDestination {
  model: string;
  modelSettings: Record<string, unknown>;
}

export interface NativeInferenceAttemptContext {
  input: ProviderTurnInput;
  attempt: number;
  model: string;
}

export interface NativeInferenceModelAttempt {
  attempt: number;
  model: string;
  provider?: string;
  effort?: string;
  outcome: "started" | "quota" | "success" | "error" | "invalidated";
  status?: number;
  code?: string;
}

/**
 * Policy seam. Local production startup derives a scoped policy from the
 * validated native-inference-fallback.json configuration (OFF by default).
 * The caller owns identity/lineage eligibility, approved finite destinations,
 * credential/capability checks, and the live owner/manual-selection revision.
 * Returning null fails closed. The adapter never mutates the stored model.
 */
export interface NativeInferenceFallbackPolicy {
  resolveDestination(
    context: NativeInferenceAttemptContext,
    failure: NativeInferenceFailure,
    attemptedModels: readonly string[],
  ):
    | NativeInferenceFallbackDestination
    | null
    | Promise<NativeInferenceFallbackDestination | null>;
  isAttemptCurrent?(
    context: NativeInferenceAttemptContext,
  ): boolean | Promise<boolean>;
  onModelAttempt?(attempt: NativeInferenceModelAttempt): void | Promise<void>;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
}

export const DEFAULT_NATIVE_INFERENCE_BUFFER_EVENTS = 2_048;
export const DEFAULT_NATIVE_INFERENCE_BUFFER_BYTES = 8 * 1024 * 1024;

export class NativeInferenceAttemptInvalidatedError extends Error {
  constructor() {
    super(
      "Native inference attempt was invalidated by cancellation, ownership loss, or a manual model change",
    );
    this.name = "NativeInferenceAttemptInvalidatedError";
  }
}

export class NativeInferenceBufferLimitError extends Error {
  constructor(readonly limit: "events" | "bytes") {
    super(
      `Native inference fallback ${limit} buffer limit exceeded before provider completion`,
    );
    this.name = "NativeInferenceBufferLimitError";
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Recovers fields only from the complete HTTP envelope emitted by pi-ai at its
 * typed provider-error boundary. Callers must not pass transcript or tool text.
 */
export function parseNativeInferenceProviderErrorEnvelope(
  provider: string | undefined,
  errorMessage: string | undefined,
): NativeInferenceProviderErrorEnvelope | undefined {
  if (!errorMessage) return undefined;
  const match = /^([45]\d{2}): (\{.*\})$/s.exec(errorMessage);
  if (!match) return undefined;
  const status = Number(match[1]);
  let body: unknown;
  try {
    body = JSON.parse(match[2] ?? "");
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  const code = stringValue(body.code);
  return {
    source: "pi_provider_error",
    provider,
    status,
    ...(code ? { code } : {}),
  };
}

function structuredRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (
      !item ||
      item.depth > 4 ||
      !isRecord(item.value) ||
      seen.has(item.value)
    ) {
      continue;
    }
    seen.add(item.value);
    records.push(item.value);
    for (const key of [
      "providerFailure",
      "assistant",
      "diagnostics",
      "details",
      "data",
      "body",
      "error",
      "cause",
    ]) {
      const child = item.value[key];
      if (Array.isArray(child)) {
        for (const entry of child)
          queue.push({ value: entry, depth: item.depth + 1 });
      } else {
        queue.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return records;
}

/** Classifies only structured data attached to the actual provider failure. */
export function classifyNativeInferenceFailure(
  error: unknown,
): NativeInferenceFailure {
  const records = structuredRecords(error);
  const status = records
    .flatMap((record) => [record.statusCode, record.status, record.httpStatus])
    .map(numberValue)
    .find((value): value is number => value !== undefined);
  const code = records
    .flatMap((record) => [record.code, record.errorCode])
    .map(stringValue)
    .find((value): value is string => value !== undefined);
  const provider = records
    .flatMap((record) => [record.provider, record.providerId])
    .map(stringValue)
    .find((value): value is string => value !== undefined);

  if (status === 429 && code === "1310") {
    return { category: "quota_exhausted", provider, status, code };
  }
  if (status === 401)
    return { category: "authentication", provider, status, code };
  if (status === 403) return { category: "permission", provider, status, code };
  if (code === "tool_failure" || code === "tool_error") {
    return { category: "other", provider, status, code };
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { category: "transient_provider", provider, status, code };
  }
  return { category: "other", provider, status, code };
}

function serializedEventBytes(event: ProviderStreamEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function appendNativeInferenceBufferedEvent(
  events: ProviderStreamEvent[],
  event: ProviderStreamEvent,
  currentBytes: number,
  policy: NativeInferenceFallbackPolicy,
): number {
  const maxEvents =
    policy.maxBufferedEvents ?? DEFAULT_NATIVE_INFERENCE_BUFFER_EVENTS;
  const maxBytes =
    policy.maxBufferedBytes ?? DEFAULT_NATIVE_INFERENCE_BUFFER_BYTES;
  if (events.length + 1 > maxEvents) {
    throw new NativeInferenceBufferLimitError("events");
  }
  const nextBytes = currentBytes + serializedEventBytes(event);
  if (nextBytes > maxBytes) {
    throw new NativeInferenceBufferLimitError("bytes");
  }
  events.push(event);
  return nextBytes;
}

export function fallbackInputForDestination(
  input: ProviderTurnInput,
  destination: NativeInferenceFallbackDestination,
): ProviderTurnInput {
  return {
    ...input,
    agent: {
      ...input.agent,
      model: destination.model,
      model_settings: { ...destination.modelSettings },
    },
  };
}
