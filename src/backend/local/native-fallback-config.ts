import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";

export interface NativeFallbackTarget {
  model: string;
  provider: string;
  /** Provider registry/auth-store reference, never a credential value. */
  credentialProvider: string;
  contextWindow: number;
  maxOutputTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  tools: boolean;
  input: Array<"text" | "image">;
}
export interface NativeFallbackConfig {
  version: 1;
  enabled: true;
  owner: "native-inference";
  /** Operator attestation: the external writer is disabled for exactly these scopes. */
  externalController: "disabled-for-scopes";
  timeoutMs: number;
  scopes: Array<{
    agentId: string;
    /** No implicit child/peer inheritance; no forged parent metadata admission. */
    lineage: "self";
    chain: NativeFallbackTarget[];
  }>;
}
export interface LoadedNativeFallbackConfig {
  config: NativeFallbackConfig;
  isCurrent(): boolean;
}

function invalid(field: string): never {
  throw new Error(`Invalid native inference fallback configuration: ${field}`);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("unknown field");
}
function positiveInteger(value: unknown, limit: number): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= limit
  );
}
function target(value: unknown): NativeFallbackTarget {
  if (!isRecord(value)) invalid("target");
  keys(value, [
    "model",
    "provider",
    "credentialProvider",
    "contextWindow",
    "maxOutputTokens",
    "effort",
    "tools",
    "input",
  ]);
  if (
    typeof value.model !== "string" ||
    !/^[a-z0-9-]+\/[^\s]+$/.test(value.model)
  )
    invalid("model handle");
  if (
    value.provider !== value.model.split("/")[0] ||
    value.credentialProvider !== value.provider
  )
    invalid("provider reference");
  if (
    !positiveInteger(value.contextWindow, 10_000_000) ||
    !positiveInteger(value.maxOutputTokens, 1_000_000) ||
    value.maxOutputTokens >= value.contextWindow
  )
    invalid("context/output limits");
  if (!["low", "medium", "high", "xhigh", "max"].includes(String(value.effort)))
    invalid("effort");
  if (
    typeof value.tools !== "boolean" ||
    !Array.isArray(value.input) ||
    !value.input.includes("text") ||
    value.input.some((v) => v !== "text" && v !== "image")
  )
    invalid("capabilities");
  return value as unknown as NativeFallbackTarget;
}

export function parseNativeFallbackConfig(
  value: unknown,
): NativeFallbackConfig | undefined {
  if (!isRecord(value)) invalid("object required");
  if (value.enabled === false) {
    keys(value, [
      "version",
      "enabled",
      "owner",
      "externalController",
      "timeoutMs",
      "scopes",
    ]);
    if (value.version !== 1) invalid("version");
    return undefined;
  }
  keys(value, [
    "version",
    "enabled",
    "owner",
    "externalController",
    "timeoutMs",
    "scopes",
  ]);
  if (
    value.version !== 1 ||
    value.enabled !== true ||
    value.owner !== "native-inference" ||
    value.externalController !== "disabled-for-scopes"
  )
    invalid("activation/ownership");
  if (!positiveInteger(value.timeoutMs, 3_600_000)) invalid("timeoutMs");
  if (!Array.isArray(value.scopes) || value.scopes.length === 0)
    invalid("explicit scopes required");
  const seen = new Set<string>();
  for (const scope of value.scopes) {
    if (!isRecord(scope)) invalid("scope");
    keys(scope, ["agentId", "lineage", "chain"]);
    if (
      typeof scope.agentId !== "string" ||
      !/^agent-local-[a-zA-Z0-9-]+$/.test(scope.agentId) ||
      seen.has(scope.agentId)
    )
      invalid("agentId");
    seen.add(scope.agentId);
    if (scope.lineage !== "self") invalid("lineage (only self is supported)");
    if (
      !Array.isArray(scope.chain) ||
      scope.chain.length < 2 ||
      scope.chain.length > 4
    )
      invalid("finite chain (2..4)");
    const handles = scope.chain.map((entry) => target(entry).model);
    if (new Set(handles).size !== handles.length)
      invalid("duplicate destination");
  }
  return value as unknown as NativeFallbackConfig;
}

/** Missing/OFF preserves baseline. Malformed, unreadable, or unsupported ON fails closed. */
export function loadNativeFallbackConfig(
  storageDir: string,
): LoadedNativeFallbackConfig | undefined {
  const path = join(storageDir, "native-inference-fallback.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read native inference fallback configuration");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("JSON");
  }
  const config = parseNativeFallbackConfig(value);
  if (!config) return undefined;
  return {
    config,
    isCurrent() {
      try {
        return readFileSync(path, "utf8") === raw;
      } catch {
        return false;
      }
    },
  };
}
