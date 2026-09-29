import { expect, test } from "bun:test";
import { effectiveLocalAgent } from "./effective-local-agent";

test("dispatch and fallback fence use the same outer context and nested effort precedence", () => {
  const agent = {
    id: "agent-local-test",
    name: "test",
    system: "test",
    tags: [],
    model: "fixture/primary",
    model_settings: { reasoning_effort: "low", context_window_limit: 4000 },
  };
  const effective = effectiveLocalAgent(agent, {
    model: "fixture/reserve",
    model_settings: { reasoning_effort: "high", context_window_limit: 8000 },
    context_window_limit: 16000,
  } as never);
  expect(effective.model).toBe("fixture/reserve");
  expect(effective.model_settings).toEqual({
    reasoning_effort: "high",
    context_window_limit: 16000,
  });
  expect(agent.model).toBe("fixture/primary");
});
