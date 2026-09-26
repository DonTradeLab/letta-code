import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCrossAgentGuard } from "@/permissions/cross-agent-guard";

const SELF = "agent-self";
const OTHER = "agent-other";
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "xa-global-subagent-"));
  tempHomes.push(home);
  return home;
}

function agentsDir(home: string): string {
  return join(home, ".letta", "agents");
}

function globalConfig(home: string, name = "reflection.md"): string {
  return join(agentsDir(home), name);
}

function otherMemory(home: string, name: string): string {
  return join(agentsDir(home), OTHER, "memory", name);
}

function evaluate(
  home: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
) {
  return evaluateCrossAgentGuard(toolName, toolArgs, home, {
    env: { HOME: home } as NodeJS.ProcessEnv,
    currentAgentId: SELF,
    disableMemoryGuard: false,
  });
}

afterEach(() => {
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop() as string, { recursive: true, force: true });
  }
});

describe("global subagent config guard classification", () => {
  test("allows ApplyPatch to a documented global reflection config", () => {
    const home = makeTempHome();
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${globalConfig(home)}`,
      "*** End Patch",
    ].join("\n");

    expect(evaluate(home, "ApplyPatch", { input: patch })).toBeNull();
  });

  test("still denies a patch mixing global config with foreign memory", () => {
    const home = makeTempHome();
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${globalConfig(home)}`,
      `*** Update File: ${otherMemory(home, "persona.md")}`,
      "*** End Patch",
    ].join("\n");

    expect(
      evaluate(home, "ApplyPatch", { input: patch })?.offendingAgentIds,
    ).toContain(OTHER);
  });

  test("does not exempt non-Markdown direct children", () => {
    const home = makeTempHome();

    expect(
      evaluate(home, "Write", {
        file_path: globalConfig(home, "reflection.json"),
      }),
    ).not.toBeNull();
  });

  test("denies a global config symlink into foreign memory", () => {
    const home = makeTempHome();
    const foreign = otherMemory(home, "secret.md");
    mkdirSync(join(agentsDir(home), OTHER, "memory"), { recursive: true });
    writeFileSync(foreign, "TOPSECRET");
    symlinkSync(foreign, globalConfig(home));

    expect(
      evaluate(home, "Read", { file_path: globalConfig(home) })
        ?.offendingAgentIds,
    ).toContain(OTHER);
  });

  test("denies a dangling global config symlink into foreign memory", () => {
    const home = makeTempHome();
    const foreign = otherMemory(home, "future.md");
    mkdirSync(join(agentsDir(home), OTHER, "memory"), { recursive: true });
    symlinkSync(foreign, globalConfig(home));

    expect(
      evaluate(home, "Write", { file_path: globalConfig(home) })
        ?.offendingAgentIds,
    ).toContain(OTHER);
  });

  test("allows a global config symlink to ordinary configuration", () => {
    const home = makeTempHome();
    const configStore = join(home, "config-store");
    const target = join(configStore, "reflection.md");
    mkdirSync(agentsDir(home), { recursive: true });
    mkdirSync(configStore, { recursive: true });
    writeFileSync(target, "model: xai/grok-4");
    symlinkSync(target, globalConfig(home));

    expect(
      evaluate(home, "Edit", { file_path: globalConfig(home) }),
    ).toBeNull();
  });
});
