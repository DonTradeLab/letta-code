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
import { loadRemoteSettings } from "./remote-settings";
import {
  nextOptimisticPermissionModeRev,
  readCurrentPermissionModeFromDisk,
  saveRemoteSettingsPermissionModeAssignment,
} from "./remote-settings-permission-mode";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export type ConversationPermissionModeState = {
  mode: PermissionMode;
  /**
   * The persisted `rev` this process last observed for this scope (from the
   * on-disk loader, or from a write this process itself made). Used only to
   * decide whether an end-of-turn reconcile write is still safe to apply —
   * see persistPermissionModeMapForRuntime and PermissionModeMutation in
   * remote-settings.ts. Not present on states created purely from the
   * process-local default (never persisted, so there is nothing to reconcile
   * against).
   */
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
  if (!isPrunableDefaultState(state)) {
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
  try {
    const settings = loadRemoteSettings();
    const map = new Map<string, ConversationPermissionModeState>();
    if (!settings.permissionModeMap) {
      return map;
    }
    for (const [key, persisted] of Object.entries(settings.permissionModeMap)) {
      // Migrate legacy mode values ("default" → "standard", "bypassPermissions" → "unrestricted").
      const rawMode =
        migratePermissionMode(persisted.mode) ?? DEFAULT_PERMISSION_MODE;
      map.set(key, {
        mode: rawMode,
        // Revision lives in the separate permissionModeRevMap table (see
        // RemoteSettings), not on the entry itself — a key absent here (the
        // default mode) still needs a revision to compare against. Legacy /
        // never-written entries are revision 0.
        knownRev: settings.permissionModeRevMap?.[key] ?? 0,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Reconcile this process's in-memory permission mode for a scope against
 * what is actually on disk right now, adopting disk's value when it is
 * strictly newer than what this process's RAM has observed.
 *
 * Fixes the retained-stale-RAM boundary on resume (Blocker 3): a listener
 * process only loads permissionModeByConversation once at startup
 * (lifecycle.ts). runtime_start without an explicit `mode` — an ordinary
 * resume/attach — must not just trust that boot-time snapshot forever: if
 * another process corrected remote-settings.json for this scope in the
 * meantime (a newer explicit choice), this process's RAM would otherwise
 * keep serving the superseded mode indefinitely, even though the file is
 * already correct. This is a pure adoption of disk's value into RAM; it
 * never writes back (no new revision is created), so it cannot itself race
 * against or clobber a concurrent explicit choice — it can only catch this
 * process up to one that already landed.
 *
 * Should be called on every runtime_start/attach for the target scope,
 * BEFORE any explicit `mode` from the same command is applied (an explicit
 * mode always overrides regardless of what reconciliation finds).
 */
export function reconcilePermissionModeFromDisk(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): void {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const onDisk = readCurrentPermissionModeFromDisk(scopeKey);
  const ramState = runtime.permissionModeByConversation.get(scopeKey);
  const ramRev = ramState?.knownRev ?? 0;

  if (onDisk === null) {
    // Disk has no override for this scope (default mode, or an explicit
    // delete already landed). Only adopt this if RAM actually knows about a
    // revision at or below what we'd otherwise assume absent — a RAM entry
    // with a higher knownRev than disk's absence would mean this process's
    // own not-yet-flushed write is still pending; leave it alone.
    if (ramState && ramRev <= 0) {
      runtime.permissionModeByConversation.delete(scopeKey);
    }
    return;
  }

  if (onDisk.rev <= ramRev) {
    return; // RAM is at least as fresh as disk; nothing to adopt.
  }

  const migratedMode = migratePermissionMode(onDisk.mode) ?? onDisk.mode;
  runtime.permissionModeByConversation.set(scopeKey, {
    mode: migratedMode,
    knownRev: onDisk.rev,
  });
}

/**
 * Persist the permission mode for a single conversation scope to
 * remote-settings.json. Skips (and prunes) entries that match the current
 * global default mode (lean map).
 *
 * Deliberately scoped to one key, not the whole in-memory map: this process's
 * permissionModeByConversation Map is populated once at listener startup
 * (see lifecycle.ts) and never reloaded from disk afterward. Persisting the
 * entire RAM snapshot on every call — including conversations untouched by
 * the current turn/command — would let this process's stale view of
 * unrelated conversations overwrite corrections made on disk by another
 * writer (a recovery tool, another process) in the meantime. Writing only
 * the scope that actually changed keeps that concurrent state safe.
 *
 * `origin` distinguishes two semantically different callers:
 * - "explicit" (default): a user/control choice — handleModeChange
 *   (change_device_state) and applyRuntimeStartState (runtime_start with an
 *   explicit `mode`). Always wins on disk, even against a value this
 *   process's cache never observed (see saveRemoteSettingsPermissionModeAssignment).
 * - "reconcile": turn-cleanup's unconditional end-of-turn persistence, which
 *   is NOT a new choice — it merely re-publishes whatever this process's RAM
 *   currently believes for that scope. Only applies if nothing newer landed
 *   on disk since this process last observed this scope's revision; a
 *   delayed reconcile can no longer resurrect a mode that was superseded by
 *   an explicit choice made elsewhere in the meantime.
 */
export function persistPermissionModeMapForRuntime(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
  origin: "explicit" | "reconcile" = "explicit",
): void {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const state = runtime.permissionModeByConversation.get(scopeKey);
  const knownRev = state?.knownRev ?? 0;

  const isDefault = !state || state.mode === DEFAULT_PERMISSION_MODE;
  saveRemoteSettingsPermissionModeAssignment(
    scopeKey,
    isDefault ? null : { mode: state.mode },
    { origin, knownRev },
  );

  // Keep this process's own RAM view of the revision current so a later
  // reconcile in the same process (e.g. this same turn's cleanup, right
  // after an explicit mid-turn mode change) has an accurate knownRev instead
  // of being dropped as stale against its own prior write.
  if (state) {
    state.knownRev = nextOptimisticPermissionModeRev(
      scopeKey,
      origin,
      knownRev,
    );
  }
}
