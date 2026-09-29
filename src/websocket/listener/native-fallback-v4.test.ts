import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runFallbackV4Scenario } from "@/test-utils/fallback-v4-scenario";

test.each([false, true])(
  "one listener turn and real Bash append; partial SSE before quota=%s",
  async (partial) => {
    const report = await runFallbackV4Scenario({ listener: true, partial });
    expect(existsSync(join(report.root, "forbidden.txt"))).toBe(false);
    expect(JSON.stringify(report.listener?.payloads)).not.toContain(
      "must-not-escape-primary",
    );
    expect(
      report.requests.every((request) => request.credentialMatchedReference),
    ).toBe(true);
    expect(report.requests.map((request) => request.model)).toEqual([
      "primary",
      "primary",
      "reserve",
    ]);
    expect(report.requests[1]?.messages).toEqual(report.requests[2]?.messages);
    expect(report.requests.map((request) => request.effort)).toEqual([
      "high",
      "high",
      "high",
    ]);
    expect(report.listener?.lifecycle).toBe("idle");
    const deltas =
      report.listener?.payloads.map(
        (payload) => payload.delta as Record<string, unknown> | undefined,
      ) ?? [];
    expect(
      deltas.filter((delta) => delta?.message_type === "client_tool_start"),
    ).toHaveLength(1);
    expect(
      deltas.filter((delta) => delta?.message_type === "client_tool_end"),
    ).toHaveLength(1);
    expect(report.effect).toBe("one real tool effect\n");
    expect(report.effects).toBe(1);
    for (const type of [
      "user_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]) {
      expect(
        report.history.filter((message) => message.message_type === type),
      ).toHaveLength(1);
    }
    expect(JSON.stringify(report.listener?.payloads)).toContain(
      "task-completed-on-reserve",
    );
  },
);
