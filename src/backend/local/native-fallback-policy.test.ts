import { expect, test } from "bun:test";
import { runFallbackV4Scenario } from "@/test-utils/fallback-v4-scenario";

test("production factory finishes one task on reserve after a real Write, without re-appending input", async () => {
  const report = await runFallbackV4Scenario();
  expect(report.requests.map((r) => r.model)).toEqual([
    "primary",
    "primary",
    "reserve",
  ]);
  expect(report.requests.at(-1)?.messages).toEqual(
    report.requests.at(-2)?.messages,
  );
  expect(report.requests.map((r) => r.effort)).toEqual([
    "high",
    "high",
    "high",
  ]);
  expect(report.effects).toBe(1);
  expect(report.effect).toBe("one real tool effect\n");
  expect(
    report.chunks.filter((c) => c.message_type === "assistant_message"),
  ).toHaveLength(1);
  expect(
    report.chunks.filter((c) => c.message_type === "approval_request_message"),
  ).toHaveLength(1);
  expect(
    report.history.filter((m) => m.message_type === "user_message"),
  ).toHaveLength(1);
  const events = report.chunks
    .filter((c) => c.event_type === "native_inference_fallback")
    .map((c) => c.event_data as Record<string, unknown>);
  expect(
    events.every(
      (e) =>
        e.taskId === "v4-task-input" &&
        e.agentId === report.agentId &&
        e.lineage === "self",
    ),
  ).toBe(true);
  expect(
    events
      .filter(
        (e) =>
          e.outcome === "quota" || (e.outcome === "success" && e.attempt === 2),
      )
      .map((e) => [e.model, e.provider, e.outcome]),
  ).toEqual([
    ["v4-primary/primary", "v4-primary", "quota"],
    ["v4-reserve/reserve", "v4-reserve", "success"],
  ]);
});

for (const options of [
  { enabled: false },
  { status: 401 },
  { status: 403 },
  { unlisted: true },
  { missingReserve: true },
  { toolsIncompatible: true },
  { incompatible: true },
  { lowPrimaryEffort: true },
  { manualChange: true },
  { cancel: true },
  { timeout: true },
]) {
  test(`factory fails closed without duplicate tool effects: ${JSON.stringify(options)}`, async () => {
    const report = await runFallbackV4Scenario(options);
    expect(report.requests.map((r) => r.model)).toEqual(["primary", "primary"]);
    expect(report.effects).toBe(1);
    expect(
      report.chunks.filter((c) => c.message_type === "assistant_message"),
    ).toHaveLength(0);
    expect(report.chunks.some((c) => c.message_type === "error_message")).toBe(
      true,
    );
    expect(
      report.history.filter((m) => m.message_type === "user_message"),
    ).toHaveLength(1);
    if ("enabled" in options)
      expect(
        report.chunks.some((c) => c.event_type === "native_inference_fallback"),
      ).toBe(false);
  });
}
