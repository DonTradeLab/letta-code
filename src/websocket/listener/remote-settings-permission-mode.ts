/**
 * Permission-mode-specific persistence for remote-settings.json.
 *
 * Split out of remote-settings.ts (which owns the generic settings file,
 * locking, and cwd persistence) because permission-mode writes need
 * provenance-aware precedence that a plain key/value patch cannot express:
 * an explicit user/control choice must always win, while an end-of-turn
 * reconcile snapshot must defer to any newer explicit choice it doesn't know
 * about yet. See PermissionModeMutation below for the full contract, and
 * persistPermissionModeMapForRuntime in permission-mode.ts for the two real
 * callers (handleModeChange/runtime_start vs. turn-cleanup).
 */

import type { PermissionMode } from "@/permissions/mode";
import {
  applyPermissionModeMutation,
  type PermissionModeMutation,
  type PermissionModeTables,
  type PersistedPermissionModeState,
} from "./permission-mode-precedence";
import {
  type CurrentRemoteSettingsSync,
  getRemoteSettingsCache,
  loadRemoteSettings,
  peekPendingPermissionModeMutation,
  queueRemoteSettingsPatch,
  type RemoteSettings,
  readCurrentRemoteSettingsSyncForScope,
  scheduleRemoteSettingsWrite,
  setRemoteSettingsCache,
} from "./remote-settings";

export type { PersistedPermissionModeState };

/**
 * Read the current on-disk permission-mode state for a single scope,
 * bypassing this process's `_cache` entirely, and folding in any of this
 * process's own not-yet-applied pending writes for that key (so a read
 * immediately following one of this process's own writes reflects it, same
 * as the write-then-read consistency `_cache` already provides for other
 * paths).
 *
 * This exists to fix the retained-stale-RAM boundary on resume: a listener
 * process only loads permissionModeByConversation once at startup
 * (lifecycle.ts). If another process corrects remote-settings.json in the
 * meantime, this process's RAM has no way to notice on its own —
 * runtime_start without an explicit `mode` (an ordinary resume) must
 * reconcile its RAM against disk before trusting it, instead of silently
 * keeping whatever was loaded at boot. Reads real disk state each call
 * (no caching) since this is only invoked on the resume path, not per-turn.
 */
export function readCurrentPermissionModeFromDisk(
  scopeKey: string,
): { mode: PermissionMode; rev: number } | null {
  const current: CurrentRemoteSettingsSync =
    readCurrentRemoteSettingsSyncForScope();
  const tables: PermissionModeTables = {
    map: current.settings.permissionModeMap,
    revMap: current.settings.permissionModeRevMap,
  };
  const pending = peekPendingPermissionModeMutation(scopeKey);
  for (const mutation of pending) {
    applyPermissionModeMutation(tables, scopeKey, mutation);
  }
  const persisted = tables.map?.[scopeKey];
  if (!persisted) return null;
  return { mode: persisted.mode, rev: tables.revMap?.[scopeKey] ?? 0 };
}

/**
 * Returns the `rev` this process should remember after queuing a
 * permission-mode write for `scopeKey`, given the true winning `rev` is only
 * known at apply time (inside the lock, against disk — see
 * applyPermissionModeMutation). Callers use this to update their own RAM
 * (ConversationPermissionModeState.knownRev) so a *subsequent* reconcile in
 * the same process (e.g. a mid-turn explicit mode change followed by that
 * turn's own cleanup) has an accurate `knownRev` and is not spuriously
 * dropped as stale. This is optimistic bookkeeping only: if a concurrent
 * writer bumps disk's rev between this call and the actual write landing,
 * the next reconcile from this process will observe the mismatch through
 * its own subsequent load and simply not force anything — it can only ever
 * fail closed (skip a reconcile), never resurrect a stale value, because
 * reconcile writes are the only kind gated by `knownRev` in the first place.
 */
export function nextOptimisticPermissionModeRev(
  scopeKey: string,
  origin: "explicit" | "reconcile",
  knownRev: number,
): number {
  if (origin === "reconcile") return knownRev;
  if (getRemoteSettingsCache() === null) loadRemoteSettings();
  const cachedRev =
    getRemoteSettingsCache()?.permissionModeRevMap?.[scopeKey] ?? 0;
  return Math.max(cachedRev, knownRev) + 1;
}

/**
 * Queue a per-conversation permission mode write, scoped to a single key
 * (never the whole map — see PermissionModeMutation) and tagged with the
 * caller's real intent:
 *
 * - `origin: "explicit"` — a user/control choice (handleModeChange,
 *   runtime_start with an explicit `mode`). Always wins on disk: the actual
 *   winning revision is computed at apply time from disk's current revision
 *   for this key (see applyPermissionModeMutation), so this call never needs
 *   to know or guess the disk's current value in advance. This is what lets
 *   an explicit choice back to the default mode (a delete) win even when the
 *   caller's cache never observed what it's replacing (Blocker 2).
 * - `origin: "reconcile"` — an end-of-turn snapshot of in-memory state
 *   (turn-cleanup), which reflects what this process's RAM believes right
 *   now but is not itself a new choice. Only applies if `knownRev` (the
 *   revision this process last observed for this key, from its own
 *   RAM/loader) still matches disk's revision at apply time. If an explicit
 *   choice from another process landed after this RAM was populated, disk's
 *   revision will have moved and the reconcile is silently dropped instead
 *   of clobbering the newer choice (Blocker 1).
 *
 * `knownRev` must be the revision this process actually observed for the
 * scope (from the loaded map or the last write it made itself), not a guess.
 */
export function saveRemoteSettingsPermissionModeAssignment(
  scopeKey: string,
  state: PersistedPermissionModeState | null,
  options: { origin: "explicit" | "reconcile"; knownRev: number },
): void {
  if (getRemoteSettingsCache() === null) {
    loadRemoteSettings();
  }

  const previous: RemoteSettings = getRemoteSettingsCache() ?? {};
  const nextPermissionModeMap = { ...previous.permissionModeMap };
  if (state === null) {
    delete nextPermissionModeMap[scopeKey];
  } else {
    nextPermissionModeMap[scopeKey] = state;
  }
  // This process's own cache is updated optimistically for read-your-write
  // consistency within the process; the authoritative decision (whether this
  // mutation actually lands) happens later, at apply time, against disk.
  const optimisticRev = nextOptimisticPermissionModeRev(
    scopeKey,
    options.origin,
    options.knownRev,
  );
  setRemoteSettingsCache({
    ...previous,
    permissionModeMap: nextPermissionModeMap,
    permissionModeRevMap:
      options.origin === "explicit"
        ? { ...previous.permissionModeRevMap, [scopeKey]: optimisticRev }
        : previous.permissionModeRevMap,
  });

  const mutation: PermissionModeMutation =
    state === null
      ? options.origin === "explicit"
        ? { intent: "explicit-delete" }
        : { intent: "reconcile-delete", knownRev: options.knownRev }
      : options.origin === "explicit"
        ? { intent: "explicit-set", state }
        : { intent: "reconcile-set", knownRev: options.knownRev, state };

  queueRemoteSettingsPatch({ permissionModeMap: { [scopeKey]: mutation } });
  scheduleRemoteSettingsWrite();
}
