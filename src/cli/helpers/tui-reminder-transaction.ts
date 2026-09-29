import type { SharedReminderState } from "@/reminders/state";

type ScalarReminderKey =
  | "hasSentAgentInfo"
  | "hasSentSessionContext"
  | "hasSentConversationBootstrap"
  | "pendingConversationBootstrap"
  | "hasSentSecretsInfo"
  | "pendingSecretsInfoRefresh"
  | "lastSentSecretNamesKey"
  | "hasSentMcpServersInfo"
  | "lastSentMcpServerNamesKey"
  | "lastNotifiedPermissionMode"
  | "turnCount"
  | "pendingReflectionTrigger"
  | "pendingSessionContextReason";

const SCALAR_KEYS: readonly ScalarReminderKey[] = [
  "hasSentAgentInfo",
  "hasSentSessionContext",
  "hasSentConversationBootstrap",
  "pendingConversationBootstrap",
  "hasSentSecretsInfo",
  "pendingSecretsInfoRefresh",
  "lastSentSecretNamesKey",
  "hasSentMcpServersInfo",
  "lastSentMcpServerNamesKey",
  "lastNotifiedPermissionMode",
  "turnCount",
  "pendingReflectionTrigger",
  "pendingSessionContextReason",
];

function cloneState(state: SharedReminderState): SharedReminderState {
  return {
    ...state,
    mcpToolCounts: new Map(
      Array.from(state.mcpToolCounts, ([key, value]) => [key, { ...value }]),
    ),
    pendingMemoryGitSyncReminders: [...state.pendingMemoryGitSyncReminders],
    pendingCommandIoReminders: [...state.pendingCommandIoReminders],
    pendingToolsetChangeReminders: [...state.pendingToolsetChangeReminders],
  };
}

function commitConsumedEntries<T>(
  live: T[],
  before: readonly T[],
  prepared: readonly T[],
): void {
  const remaining = [...prepared];
  for (const entry of before) {
    const preparedIndex = remaining.indexOf(entry);
    if (preparedIndex !== -1) {
      remaining.splice(preparedIndex, 1);
      continue;
    }
    const liveIndex = live.indexOf(entry);
    if (liveIndex !== -1) {
      live.splice(liveIndex, 1);
    }
  }

  // Providers currently only consume, but retain transactional correctness if
  // a provider later appends a prepared entry: add it without touching events
  // that arrived in the live state during the await.
  for (const entry of remaining) {
    if (!before.includes(entry)) {
      live.push(entry);
    }
  }
}

function sameToolCount(
  a: { toolCount: number | null; fetchedAtMs: number } | undefined,
  b: { toolCount: number | null; fetchedAtMs: number } | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.toolCount === b.toolCount &&
      a.fetchedAtMs === b.fetchedAtMs)
  );
}

/**
 * Prepare reminder providers against an isolated clone. `commit()` applies
 * only the prepared delta and uses compare-and-swap semantics for scalar/map
 * state, so reminders/events that arrive while providers await are preserved.
 */
export function createTuiReminderTransaction(live: SharedReminderState): {
  state: SharedReminderState;
  commit: () => void;
} {
  const before = cloneState(live);
  const prepared = cloneState(live);

  return {
    state: prepared,
    commit: () => {
      const liveRecord = live as unknown as Record<string, unknown>;
      const beforeRecord = before as unknown as Record<string, unknown>;
      const preparedRecord = prepared as unknown as Record<string, unknown>;
      for (const key of SCALAR_KEYS) {
        if (Object.is(liveRecord[key], beforeRecord[key])) {
          liveRecord[key] = preparedRecord[key];
        }
      }

      commitConsumedEntries(
        live.pendingMemoryGitSyncReminders,
        before.pendingMemoryGitSyncReminders,
        prepared.pendingMemoryGitSyncReminders,
      );
      commitConsumedEntries(
        live.pendingCommandIoReminders,
        before.pendingCommandIoReminders,
        prepared.pendingCommandIoReminders,
      );
      commitConsumedEntries(
        live.pendingToolsetChangeReminders,
        before.pendingToolsetChangeReminders,
        prepared.pendingToolsetChangeReminders,
      );

      const mapKeys = new Set([
        ...before.mcpToolCounts.keys(),
        ...prepared.mcpToolCounts.keys(),
      ]);
      for (const key of mapKeys) {
        const beforeValue = before.mcpToolCounts.get(key);
        const preparedValue = prepared.mcpToolCounts.get(key);
        if (sameToolCount(beforeValue, preparedValue)) continue;
        const liveValue = live.mcpToolCounts.get(key);
        if (!sameToolCount(liveValue, beforeValue)) continue;
        if (preparedValue === undefined) {
          live.mcpToolCounts.delete(key);
        } else {
          live.mcpToolCounts.set(key, { ...preparedValue });
        }
      }
    },
  };
}
