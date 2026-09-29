import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { runFallbackV4Scenario } from "@/test-utils/fallback-v4-scenario";

const report = await runFallbackV4Scenario({
  listener: process.argv.includes("--listener"),
  partial: process.argv.includes("--partial"),
});
if (process.argv[2])
  await writeFile(process.argv[2], JSON.stringify(report, null, 2));
if (process.argv.includes("--verify")) {
  assert.deepEqual(
    report.requests.map((r) => r.model),
    ["primary", "primary", "reserve"],
  );
  assert.deepEqual(report.requests[1]?.messages, report.requests[2]?.messages);
  assert(
    report.requests.every(
      (r) => r.effort === "high" && r.credentialMatchedReference,
    ),
  );
  assert.equal(report.effects, 1);
  assert.equal(report.effect, "one real tool effect\n");
  assert.equal(
    report.history.filter((m) => m.message_type === "user_message").length,
    1,
  );
  assert.equal(
    report.history.filter((m) => m.message_type === "assistant_message").length,
    1,
  );
  if (report.listener) assert.equal(report.listener.lifecycle, "idle");
}
console.log(
  JSON.stringify(
    {
      runtime: report.runtime,
      requests: report.requests.map((r) => r.model),
      effects: report.effects,
      effect: report.effect,
      chunks: report.chunks.map((c) => c.message_type),
      taskId: report.taskId,
      verified: process.argv.includes("--verify"),
    },
    null,
    2,
  ),
);
