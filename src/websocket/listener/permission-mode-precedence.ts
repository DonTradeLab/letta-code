/**
 * Pure precedence rules for reconciling permission-mode writes against a
 * per-scope revision counter. No I/O, no module-level state — deliberately
 * dependency-free (besides the shared PermissionMode type) so both
 * remote-settings.ts (generic settings file/lock plumbing) and
 * remote-settings-permission-mode.ts (permission-mode-specific writers) can
 * share this logic without a circular import between them.
 *
 * Background: permission-mode writes need provenance-aware precedence that a
 * plain key/value set/delete patch cannot express:
 * - An explicit user/control choice (handleModeChange, runtime_start with an
 *   explicit `mode`) must always win, even against a value the writer's own
 *   cache never observed.
 * - An end-of-turn reconcile snapshot (turn-cleanup) is NOT a new choice —
 *   it must defer to any newer explicit choice it doesn't know about yet,
 *   instead of overwriting it with stale in-memory state.
 */

import type { PermissionMode } from "@/permissions/mode";

/** Persisted permission mode state for a single conversation. */
export interface PersistedPermissionModeState {
  mode: PermissionMode;
}

/**
 * Permission-mode mutations carry explicit provenance instead of a plain
 * set/delete, because the two real callers mean different things:
 *
 * - "explicit": a user/control choice. Always wins: bumps the per-scope
 *   revision to one past whatever is on disk *at apply time* (not at
 *   enqueue time), so it cannot be starved by a stale local cache and always
 *   outranks any writer that only has an older view of this scope.
 * - "reconcile": an end-of-turn snapshot of in-memory state that was not
 *   necessarily just chosen. Only applies if `knownRev` still matches the
 *   revision on disk — i.e. nothing newer landed between this process
 *   loading that scope and this write reaching the lock. If disk has moved
 *   on, the reconcile is dropped; the writer's RAM is stale and must not
 *   overwrite a newer explicit choice made by another process.
 */
export type PermissionModeMutation =
  | { intent: "explicit-delete" }
  | { intent: "explicit-set"; state: PersistedPermissionModeState }
  | { intent: "reconcile-delete"; knownRev: number }
  | {
      intent: "reconcile-set";
      knownRev: number;
      state: PersistedPermissionModeState;
    };

export type PermissionModeMapPatch = Record<string, PermissionModeMutation>;

export interface PermissionModeTables {
  map: Record<string, PersistedPermissionModeState> | undefined;
  revMap: Record<string, number> | undefined;
}

/**
 * Apply a single permission-mode mutation against the tables as they stand
 * *at apply time* (i.e. against the real current disk state read under the
 * settings lock, not against any writer's local cache). This is the only
 * place that resolves precedence between an explicit choice and a delayed
 * end-of-turn reconcile for the same scope key.
 *
 * The revision lives in `revMap`, separately from `map`, specifically so a
 * key that is *absent* from `map` (the default mode — see the lean-map
 * comment in permission-mode.ts) still has a real revision to compare
 * against. Without that, deleting a key back to default would forget its
 * revision, and a stale reconcile with `knownRev: 0` could not be
 * distinguished from "this scope was never written."
 *
 * - explicit-set / explicit-delete always win: they stamp revMap[key] to one
 *   past whatever is on disk right now, so no writer needs to know the
 *   winning rev in advance and no explicit choice can ever be rejected by a
 *   stale cache (fixes: an explicit delete back to default no longer needs
 *   to guess the disk's current mode).
 * - reconcile-set / reconcile-delete only apply if the writer's remembered
 *   `knownRev` for this key still equals revMap[key] on disk. If another
 *   writer already bumped it (an explicit choice landed after this writer's
 *   RAM was populated), the reconcile is silently dropped and disk keeps the
 *   newer value (fixes: a delayed turn-cleanup can no longer clobber a newer
 *   explicit choice for the same key).
 */
export function applyPermissionModeMutation(
  tables: PermissionModeTables,
  key: string,
  mutation: PermissionModeMutation,
): void {
  const diskRev = tables.revMap?.[key] ?? 0;

  switch (mutation.intent) {
    case "explicit-set": {
      tables.map = { ...tables.map, [key]: mutation.state };
      tables.revMap = { ...tables.revMap, [key]: diskRev + 1 };
      return;
    }
    case "explicit-delete": {
      if (tables.map && key in tables.map) {
        const nextMap = { ...tables.map };
        delete nextMap[key];
        tables.map = nextMap;
      }
      tables.revMap = { ...tables.revMap, [key]: diskRev + 1 };
      return;
    }
    case "reconcile-set": {
      if (mutation.knownRev !== diskRev) return; // stale; disk moved on
      tables.map = { ...tables.map, [key]: mutation.state };
      return;
    }
    case "reconcile-delete": {
      if (mutation.knownRev !== diskRev) return; // stale; disk moved on
      if (tables.map && key in tables.map) {
        const nextMap = { ...tables.map };
        delete nextMap[key];
        tables.map = nextMap;
      }
      return;
    }
  }
}

export function applyPermissionModeMapPatch(
  current: PermissionModeTables,
  patch: PermissionModeMapPatch,
): PermissionModeTables {
  const tables: PermissionModeTables = { ...current };
  for (const [key, mutation] of Object.entries(patch)) {
    applyPermissionModeMutation(tables, key, mutation);
  }
  return tables;
}
