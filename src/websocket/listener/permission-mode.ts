/**
 * Per-conversation permission mode storage.
 *
 * Mirrors the CWD isolation pattern in cwd.ts:
 * - State is stored in a Map on the long-lived ListenerRuntime (not on the
 *   ephemeral ConversationRuntime, which gets evicted between turns).
 * - A scope key derived from agentId + conversationId is used as the map key.
 */

import {
  DEFAULT_PERMISSION_MODE,
  permissionMode as globalPermissionMode,
  migratePermissionMode,
  type PermissionMode,
} from "@/permissions/mode";
import {
  type RemoteSettings,
  readPermissionModeSettingsSnapshot,
  transactRemoteSettings,
} from "./remote-settings";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export type ConversationPermissionModeState = {
  mode: PermissionMode;
  /** Last confirmed revision, never a prediction of an in-flight write. */
  knownRev?: number;
};

export function getPermissionModeScopeKey(
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  if (normalizedConversationId === "default") {
    return `agent:${normalizedAgentId ?? "__unknown__"}::conversation:default`;
  }
  return `conversation:${normalizedConversationId}`;
}

function createDefaultPermissionModeState(): ConversationPermissionModeState {
  return {
    mode: globalPermissionMode.getMode(),
  };
}

function isPrunableDefaultState(
  state: ConversationPermissionModeState,
): boolean {
  return state.mode === globalPermissionMode.getMode();
}

/**
 * Read-only state lookup for a conversation scope.
 *
 * This helper is intended for read paths (status rendering, serialization).
 * It does not materialize new map entries for missing scopes.
 */
export function getConversationPermissionModeState(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): Readonly<ConversationPermissionModeState> {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const normalizedConversationId = normalizeConversationId(conversationId);

  const direct = runtime.permissionModeByConversation.get(scopeKey);
  if (direct) {
    return direct;
  }

  // Backward/interop fallback for default-conversation entries that were
  // keyed without an agent id (agent:__unknown__). If we find one while a
  // concrete agent id is available, migrate it to the canonical key.
  if (normalizedConversationId === "default") {
    const legacyDefaultKey = getPermissionModeScopeKey(null, "default");
    const legacyDefault =
      runtime.permissionModeByConversation.get(legacyDefaultKey);
    if (legacyDefault) {
      const normalizedAgentId = normalizeCwdAgentId(agentId);
      if (normalizedAgentId) {
        runtime.permissionModeByConversation.set(scopeKey, legacyDefault);
        runtime.permissionModeByConversation.delete(legacyDefaultKey);
      }
      return legacyDefault;
    }
  }

  return createDefaultPermissionModeState();
}

/**
 * Returns the canonical mutable state object for a conversation scope.
 *
 * This helper materializes missing entries and guarantees stable identity
 * during a turn so concurrent mode updates (websocket + tool mutations)
 * apply to the same object reference.
 */
export function getOrCreateConversationPermissionModeStateRef(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationPermissionModeState {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const normalizedConversationId = normalizeConversationId(conversationId);

  const direct = runtime.permissionModeByConversation.get(scopeKey);
  if (direct) {
    return direct;
  }

  if (normalizedConversationId === "default") {
    const legacyDefaultKey = getPermissionModeScopeKey(null, "default");
    const legacyDefault =
      runtime.permissionModeByConversation.get(legacyDefaultKey);
    if (legacyDefault) {
      const normalizedAgentId = normalizeCwdAgentId(agentId);
      if (normalizedAgentId) {
        runtime.permissionModeByConversation.set(scopeKey, legacyDefault);
        runtime.permissionModeByConversation.delete(legacyDefaultKey);
      }
      return legacyDefault;
    }
  }

  const created = createDefaultPermissionModeState();
  runtime.permissionModeByConversation.set(scopeKey, created);
  return created;
}

/**
 * Remove a canonical state entry when it is equivalent to the default state.
 *
 * This should be called at turn finalization boundaries, not on each mode
 * update, to avoid breaking object identity for in-flight turns.
 */
export function pruneConversationPermissionModeStateIfDefault(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): boolean {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const state = runtime.permissionModeByConversation.get(scopeKey);
  if (!state) {
    return false;
  }
  // Keep confirmed tombstones and their live references. Only virgin defaults
  // may be removed; deleting a confirmed revision would turn stale RAM into rev0.
  if (state.knownRev !== undefined || !isPrunableDefaultState(state)) {
    return false;
  }
  runtime.permissionModeByConversation.delete(scopeKey);
  return true;
}

/**
 * Load the persisted permission mode map from remote-settings.json.
 * Converts PersistedPermissionModeState → ConversationPermissionModeState.
 */
export function loadPersistedPermissionModeMap(): Map<
  string,
  ConversationPermissionModeState
> {
  const settings = readPermissionModeSettingsSnapshot();
  validatePermissionTables(settings);
  const map = new Map<string, ConversationPermissionModeState>();
  for (const key of new Set([
    ...Object.keys(settings.permissionModeMap ?? {}),
    ...Object.keys(settings.permissionModeRevMap ?? {}),
  ])) {
    map.set(key, readPermissionSnapshot(settings, key));
  }
  return map;
}

function validatePermissionTables(settings: RemoteSettings): void {
  for (const table of [
    settings.permissionModeMap,
    settings.permissionModeRevMap,
  ]) {
    if (
      table !== undefined &&
      (!table || typeof table !== "object" || Array.isArray(table))
    ) {
      throw new Error("Invalid persisted permission table");
    }
  }
}

function readPermissionSnapshot(
  settings: RemoteSettings,
  key: string,
): ConversationPermissionModeState & { knownRev: number } {
  validatePermissionTables(settings);
  const persistedRev = settings.permissionModeRevMap?.[key];
  const knownRev = persistedRev === undefined ? 0 : persistedRev;
  if (!Number.isSafeInteger(knownRev) || knownRev < 0) {
    throw new Error("Invalid persisted permission revision");
  }
  const persisted = settings.permissionModeMap?.[key];
  const mode =
    persisted === undefined
      ? knownRev > 0
        ? DEFAULT_PERMISSION_MODE
        : globalPermissionMode.getMode()
      : migratePermissionMode(persisted?.mode);
  if (!mode) throw new Error("Invalid persisted permission mode");
  return { mode, knownRev };
}

/**
 * Confirm one scoped choice using the native settings transaction. Explicit
 * choices change RAM only after rename; cleanup is CAS against its captured
 * revision. All accepted changes (including legitimate turn mutations) advance
 * the revision. Reads retain tombstones and update the canonical object in place.
 * No pending permission intent survives a rejected transaction.
 */
async function transactPermissionMode(
  runtime: ListenerRuntime,
  agentId: string | null | undefined,
  conversationId: string | null | undefined,
  intent: "explicit" | "reconcile" | "read",
  mode?: PermissionMode,
): Promise<void> {
  const key = getPermissionModeScopeKey(agentId, conversationId);
  const state = getOrCreateConversationPermissionModeStateRef(
    runtime,
    agentId,
    conversationId,
  );
  const capturedMode = state.mode;
  const capturedRev = state.knownRev;
  await transactRemoteSettings((settings) => {
    // Preserve the existing one-time agent:__unknown__ default migration, but
    // consume it atomically so another listener cannot resurrect the old key.
    const legacyKey = getPermissionModeScopeKey(null, "default");
    if (
      normalizeConversationId(conversationId) === "default" &&
      key !== legacyKey &&
      settings.permissionModeMap?.[key] === undefined &&
      settings.permissionModeRevMap?.[key] === undefined &&
      settings.permissionModeMap?.[legacyKey] !== undefined
    ) {
      const legacy = readPermissionSnapshot(settings, legacyKey);
      if (legacy.knownRev === Number.MAX_SAFE_INTEGER)
        throw new Error("Permission revision exhausted");
      const permissionModeMap = {
        ...settings.permissionModeMap,
        [key]: { mode: legacy.mode },
      };
      delete permissionModeMap[legacyKey];
      settings = {
        ...settings,
        permissionModeMap,
        permissionModeRevMap: {
          ...settings.permissionModeRevMap,
          [key]: legacy.knownRev,
          [legacyKey]: legacy.knownRev + 1,
        },
      };
    }
    const current = readPermissionSnapshot(settings, key);
    // A control or another turn already changed this live object while we
    // waited for the lock. An old cleanup/read must not overwrite that update.
    if (
      intent !== "explicit" &&
      (state.mode !== capturedMode || state.knownRev !== capturedRev)
    ) {
      return { settings, confirm: () => {} };
    }
    // An omitted mode is not permission to discard a legitimate local turn
    // mutation when the confirmed disk revision has not changed.
    if (
      intent === "read" &&
      capturedRev !== undefined &&
      capturedRev === current.knownRev
    ) {
      return { settings, confirm: () => {} };
    }
    const shouldWrite =
      intent === "explicit" ||
      (intent === "reconcile" &&
        (capturedRev ?? 0) === current.knownRev &&
        capturedMode !== current.mode);
    let confirmed = current;
    let next = settings;
    if (shouldWrite) {
      if (current.knownRev === Number.MAX_SAFE_INTEGER)
        throw new Error("Permission revision exhausted");
      confirmed = {
        mode: intent === "explicit" ? (mode as PermissionMode) : capturedMode,
        knownRev: current.knownRev + 1,
      };
      const permissionModeMap = { ...settings.permissionModeMap };
      if (confirmed.mode === DEFAULT_PERMISSION_MODE)
        delete permissionModeMap[key];
      else permissionModeMap[key] = { mode: confirmed.mode };
      next = {
        ...settings,
        permissionModeMap,
        permissionModeRevMap: {
          ...settings.permissionModeRevMap,
          [key]: confirmed.knownRev,
        },
      };
    }
    return {
      settings: next,
      confirm: () => {
        state.mode = confirmed.mode;
        state.knownRev = confirmed.knownRev;
      },
    };
  });
}

/** A user/control choice; completion means publication succeeded. */
export async function setConversationPermissionMode(
  runtime: ListenerRuntime,
  agentId: string | null | undefined,
  conversationId: string | null | undefined,
  mode: PermissionMode,
): Promise<void> {
  await transactPermissionMode(
    runtime,
    agentId,
    conversationId,
    "explicit",
    mode,
  );
}

/** Finalization of a turn is not a new explicit choice. */
export async function persistPermissionModeMapForRuntime(
  runtime: ListenerRuntime,
  agentId: string | null | undefined,
  conversationId: string | null | undefined,
): Promise<void> {
  await transactPermissionMode(runtime, agentId, conversationId, "reconcile");
}

/** Resume must observe absence + revision as well as non-default choices. */
export async function reconcilePermissionModeFromDisk(
  runtime: ListenerRuntime,
  agentId: string | null | undefined,
  conversationId: string | null | undefined,
): Promise<void> {
  await transactPermissionMode(runtime, agentId, conversationId, "read");
}
