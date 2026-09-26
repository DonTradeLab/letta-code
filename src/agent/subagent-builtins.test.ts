import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSubagentConfigCache,
  getAllSubagentConfigs,
  resolveSubagentConfigForMemoryFormat,
} from "@/agent/subagents";
import { __testSetBackend, type Backend } from "@/backend";

let tempDir: string | null = null;
let tempHome: string | null = null;
const originalHome = process.env.HOME;

function createTempProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "letta-subagents-test-"));
}

function writeCustomSubagent(
  projectDir: string,
  fileName: string,
  content: string,
): string {
  const agentsDir = join(projectDir, ".letta", "agents");
  const filePath = join(agentsDir, fileName);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writeGlobalSubagent(fileName: string, content: string): string {
  if (!tempHome) throw new Error("Temporary HOME is not initialized");
  return writeCustomSubagent(tempHome, fileName, content);
}

function reflectionModelOverlay(model: string): string {
  return ["---", "name: reflection", `model: ${model}`, "---"].join("\n");
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "letta-subagents-home-"));
  process.env.HOME = tempHome;
  __testSetBackend(null);
  clearSubagentConfigCache();
});

afterEach(() => {
  __testSetBackend(null);
  clearSubagentConfigCache();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("built-in subagents", () => {
  test("includes reflection subagent in available configs", async () => {
    const configs = await getAllSubagentConfigs();
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.name).toBe("reflection");
    expect(configs.reflection?.recommendedModel).toBe("inherit");
  });

  test("general-purpose inherits the parent model by default", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs["general-purpose"]?.recommendedModel).toBe("inherit");
  });

  test("fork inherits the parent model and full toolset", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.fork?.recommendedModel).toBe("inherit");
    expect(configs.fork?.allowedTools).toBe("all");
  });

  test("memory-related built-ins use the memory-subagent launch profile", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.launchProfile).toBe("memory-subagent");
    expect(configs["history-analyzer"]?.launchProfile).toBe("memory-subagent");
    expect(configs.memory?.launchProfile).toBe("memory-subagent");
    expect(configs.init?.launchProfile).toBe("memory-subagent");
  });

  test("legacy background metadata does not affect subagent config", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "foreground-worker.md",
      `---
name: foreground-worker
description: Custom foreground worker
tools: Read
background: false
---
Custom prompt body`,
    );

    const configs = await getAllSubagentConfigs(tempDir);

    expect(configs["foreground-worker"]).not.toHaveProperty("background");
  });

  test("reflection exposes only Edit among first-class file tools", async () => {
    const configs = await getAllSubagentConfigs();
    const hiddenFileTools = ["Read", "Write", "Glob", "Grep"];

    expect(configs.reflection?.allowedTools).toContain("Edit");
    expect(configs.memory?.allowedTools).not.toContain("Edit");
    for (const tool of hiddenFileTools) {
      expect(configs.reflection?.allowedTools).not.toContain(tool);
      expect(configs.memory?.allowedTools).not.toContain(tool);
    }
  });

  test("reuses MemFS built-in prompts when local backend is active", async () => {
    __testSetBackend({
      capabilities: { localMemfs: true },
    } as unknown as Backend);
    clearSubagentConfigCache();

    const configs = await getAllSubagentConfigs();

    expect(configs.init?.systemPrompt).toContain("Commit (1 bash call)");
    expect(configs.init?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).toContain(
      'WORKTREE_DIR="$MEMORY_DIR-worktrees"',
    );
    expect(configs.memory?.systemPrompt).not.toContain("git push");
    expect(configs.reflection?.systemPrompt).not.toContain("git push");
  });

  test("selects v2 writer prompts only for unchanged API built-ins", async () => {
    const configs = await getAllSubagentConfigs();

    for (const name of ["reflection", "init", "memory", "history-analyzer"]) {
      const config = configs[name];
      expect(config).toBeDefined();
      if (!config) throw new Error(`Missing ${name} config`);
      const resolved = resolveSubagentConfigForMemoryFormat(
        config,
        "memfs-v2",
        false,
      );
      expect(resolved.systemPrompt).not.toContain("MemFS v2");
      expect(resolved.systemPrompt).not.toContain("$MEMORY_DIR/system/");
      // shared v2 layout markers
      expect(resolved.systemPrompt).toContain("MEMORY.md");
      expect(resolved.systemPrompt).toContain("no frontmatter");
      expect(resolved.systemPrompt).toContain("`name` and `description`");
    }

    // per-prompt operational phrases proving copied v1 guidance remains
    const opsPhrases: Record<string, string[]> = {
      reflection: ["Phase 1 — Investigate", "Phase 5 — Commit", "`create`"],
      init: [
        "### 5. Commit (1 bash call)",
        "feat(init): initialize memory for project",
      ],
      "history-analyzer": ["### 5. Commit", "Do NOT merge into main"],
      memory: [
        "### Phase 5: Merge and Clean Up (MANDATORY)",
        "## Error Handling",
      ],
    };
    for (const [name, phrases] of Object.entries(opsPhrases)) {
      const config = configs[name];
      if (!config) throw new Error(`Missing ${name} config`);
      const resolved = resolveSubagentConfigForMemoryFormat(
        config,
        "memfs-v2",
        false,
      );
      for (const phrase of phrases) {
        expect(resolved.systemPrompt).toContain(phrase);
      }
    }

    const reflection = configs.reflection;
    if (!reflection) throw new Error("Missing reflection config");
    const custom = { ...reflection, systemPrompt: "Custom prompt" };
    expect(
      resolveSubagentConfigForMemoryFormat(custom, "memfs-v2", false)
        .systemPrompt,
    ).toBe("Custom prompt");
  });

  test("keeps API-backed built-in prompts free of local backend wording", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.init?.systemPrompt).toContain("Commit (1 bash call)");
    expect(configs.init?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).not.toContain("git push");
    expect(configs.reflection?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).not.toContain(
      "local backend git-backed memory filesystem",
    );
    expect(configs.reflection?.systemPrompt).not.toContain(
      "local backend memory filesystem",
    );
  });

  test("custom CRLF reflection override replaces built-in reflection", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      [
        "---",
        "name: reflection",
        "description: Custom reflection override",
        "tools: Read",
        "model: zaisigno/glm-5",
        "---",
        "Custom prompt body",
      ].join("\r\n"),
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.description).toBe("Custom reflection override");
    expect(configs.reflection?.recommendedModel).toBe("zaisigno/glm-5");
  });

  test("reloads a Sonnet reflection override as Grok in the same process", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("anthropic/claude-sonnet-4-6"),
    );
    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("anthropic/claude-sonnet-4-6");

    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("xai/grok-4"),
    );

    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("xai/grok-4");
  });

  test("detects same-size config rewrites without an explicit cache clear", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("xai/grok-4"),
    );
    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("xai/grok-4");

    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("zai/glm-55"),
    );
    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("zai/glm-55");
  });

  test("detects additions and removals without an explicit cache clear", async () => {
    tempDir = createTempProjectDir();
    expect(
      (await getAllSubagentConfigs(tempDir))["quota-router"],
    ).toBeUndefined();

    const configPath = writeCustomSubagent(
      tempDir,
      "quota-router.md",
      [
        "---",
        "name: quota-router",
        "description: Routes around exhausted providers",
        "model: xai/grok-4",
        "---",
        "Route reflection work.",
      ].join("\n"),
    );
    expect(
      (await getAllSubagentConfigs(tempDir))["quota-router"]?.recommendedModel,
    ).toBe("xai/grok-4");

    rmSync(configPath);
    expect(
      (await getAllSubagentConfigs(tempDir))["quota-router"],
    ).toBeUndefined();
  });

  test("re-evaluates project-over-global precedence after removal", async () => {
    tempDir = createTempProjectDir();
    writeGlobalSubagent(
      "reflection.md",
      reflectionModelOverlay("anthropic/claude-sonnet-4-6"),
    );
    const projectConfig = writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("xai/grok-4"),
    );

    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("xai/grok-4");

    rmSync(projectConfig);
    expect(
      (await getAllSubagentConfigs(tempDir)).reflection?.recommendedModel,
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  test("shares a coherent refreshed config across concurrent callers", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("anthropic/claude-sonnet-4-6"),
    );
    await getAllSubagentConfigs(tempDir);
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      reflectionModelOverlay("xai/grok-4"),
    );

    const configs = await Promise.all(
      Array.from({ length: 12 }, () =>
        getAllSubagentConfigs(tempDir as string),
      ),
    );

    expect(
      configs.every(
        (entry) => entry.reflection?.recommendedModel === "xai/grok-4",
      ),
    ).toBe(true);
    expect(configs.every((entry) => entry === configs[0])).toBe(true);
  });

  test("bodyless reflection config overlays model without replacing the built-in", async () => {
    tempDir = createTempProjectDir();
    const builtIn = (await getAllSubagentConfigs(tempDir)).reflection;
    clearSubagentConfigCache();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      ["---", "name: reflection", "model: auto", "---"].join("\r\n"),
    );

    const config = (await getAllSubagentConfigs(tempDir)).reflection;
    expect(config?.systemPrompt).toBe(builtIn?.systemPrompt);
    expect(config?.description).toBe(builtIn?.description);
    expect(config?.allowedTools).toEqual(builtIn?.allowedTools);
    expect(config?.skills).toEqual(builtIn?.skills);
    expect(config?.fork).toBe(builtIn?.fork);
    expect(config?.launchProfile).toBe(builtIn?.launchProfile);
    expect(config?.recommendedModel).toBe("auto");
    expect(config?.recommendedModelSource).toBe("user");
  });

  test("bodyless config can override explicit metadata fields", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      `---
name: reflection
description: Focused reflection
tools: Read
model: auto
---`,
    );

    const config = (await getAllSubagentConfigs(tempDir)).reflection;
    expect(config?.description).toBe("Focused reflection");
    expect(config?.allowedTools).toEqual(["Read"]);
    expect(config?.launchProfile).toBe("memory-subagent");
  });

  test("ignores bodyless config without a lower-precedence definition", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "new-agent.md",
      `---
name: new-agent
model: auto
---`,
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs["new-agent"]).toBeUndefined();
  });

  test("blank model field falls back to inherit", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      `---
name: reflection
description: Custom reflection override
tools: Read
model:
---
Custom prompt body`,
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.recommendedModel).toBe("inherit");
  });

  test("frontmatter name remains override key (filename can differ)", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflector.md",
      `---
name: reflection
description: Custom reflection override from different filename
tools: Read
---
Custom prompt body`,
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.description).toBe(
      "Custom reflection override from different filename",
    );
  });
});
