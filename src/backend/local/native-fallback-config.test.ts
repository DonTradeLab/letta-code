import { expect, test } from "bun:test";
import { parseNativeFallbackConfig } from "./native-fallback-config";

function valid() {
  const target = {
    model: "fixture/primary",
    provider: "fixture",
    credentialProvider: "fixture",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    effort: "high",
    tools: true,
    input: ["text"],
  };
  return {
    version: 1,
    enabled: true,
    owner: "native-inference",
    externalController: "disabled-for-scopes",
    timeoutMs: 60000,
    scopes: [
      {
        agentId: "agent-local-fixture",
        lineage: "self",
        chain: [target, { ...target, model: "fixture/reserve" }],
      },
    ],
  };
}
test("OFF is explicit and validated; ON requires exact scope and single-owner attestation", () => {
  expect(
    parseNativeFallbackConfig({ version: 1, enabled: false }),
  ).toBeUndefined();
  expect(parseNativeFallbackConfig(valid())?.scopes).toHaveLength(1);
  for (const patch of [
    { enabled: "true" },
    { version: 2 },
    { scopes: [] },
    { owner: "watchdog" },
    { externalController: "active" },
    { timeoutMs: Infinity },
    { apiKey: "not-allowed" },
  ]) {
    expect(() => parseNativeFallbackConfig({ ...valid(), ...patch })).toThrow();
  }
});
test("no wildcard lineage, cycles, arbitrary credentials or effort downgrade", () => {
  const value = valid();
  for (const scope of value.scopes) scope.lineage = "descendants";
  expect(() => parseNativeFallbackConfig(value)).toThrow();
  const cyclic = valid();
  for (const scope of cyclic.scopes)
    for (const entry of scope.chain) entry.model = "fixture/primary";
  expect(() => parseNativeFallbackConfig(cyclic)).toThrow();
  const credential = valid();
  for (const scope of credential.scopes)
    for (const entry of scope.chain)
      entry.credentialProvider = "another-account";
  expect(() => parseNativeFallbackConfig(credential)).toThrow();
});
