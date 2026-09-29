#!/usr/bin/env python3
"""Allowlisted, per-process test isolation; no inherited credentials or dotenv."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
PATH = "/Users/diegoveras/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def run(label, args, timeout=120):
    sandbox = Path(tempfile.mkdtemp(prefix="fallback-v4-validation-"))
    for name in ["home", "letta", "backend", "config", "cache", "tmp"]:
        (sandbox / name).mkdir()
    env = {"PATH": PATH, "HOME": str(sandbox / "home"), "LETTA_HOME": str(sandbox / "letta"),
           "LETTA_LOCAL_BACKEND_DIR": str(sandbox / "backend"), "XDG_CONFIG_HOME": str(sandbox / "config"),
           "XDG_CACHE_HOME": str(sandbox / "cache"), "TMPDIR": str(sandbox / "tmp"),
           "LETTA_LOCAL_BACKEND_EXPERIMENTAL": "0", "LETTA_CODE_TELEM": "0", "DISABLE_AUTOUPDATER": "1"}
    before = time.monotonic()
    try:
        result = subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, text=True)
        code, output = result.returncode, result.stdout
    except subprocess.TimeoutExpired as error:
        code, output = 124, str(error.stdout)
    summary = {"label": label, "command": args, "cwd": str(ROOT), "sandbox": str(sandbox), "exit_code": code,
               "duration_s": round(time.monotonic() - before, 2), "summary": output[-1800:]}
    print(f"{label}: exit={code}", flush=True)
    return summary, output


mode = sys.argv[1] if len(sys.argv) > 1 else "focused"
if mode == "proof":
    entry = "review-artifacts/fallback-v4/run-proof"
    commands = [("bundle-proof", ["bun", "--no-env-file", "build", entry + ".ts", "--target=node", "--format=esm", "--external=ws", "--external=node-pty", "--external=@vscode/ripgrep", "--external=grammy", "--external=@pierre/diffs", "--external=@pierre/diffs/*", "--external=@shikijs/langs", "--external=@shikijs/langs/*", "--outfile=" + entry + ".mjs"], 120),
        ("bun-listener", ["bun", "--no-env-file", "--no-install", "run", entry + ".ts", "review-artifacts/fallback-v4/after-listener-bun-final.json", "--listener", "--verify"], 120),
        ("node-listener", ["node", entry + ".mjs", "review-artifacts/fallback-v4/after-listener-node-final.json", "--listener", "--verify"], 120),
        ("node-partial", ["node", entry + ".mjs", "review-artifacts/fallback-v4/after-listener-node-partial.json", "--listener", "--partial", "--verify"], 120)]
elif mode in ("baseline-reconnect", "candidate-reconnect"):
    if mode == "baseline-reconnect":
        ROOT = ROOT.parent / "fallback-v4-baseline-check"
    commands = [(mode, ["bun", "--no-env-file", "--no-install", "test", "src/websocket/listener/auth-lifecycle-approval-reconnect.test.ts"], 120)]
elif mode.startswith("suite"):
    files = sorted(str(p.relative_to(ROOT)) for folder in ["src/backend", "src/websocket/listener", "src/permissions"] for p in (ROOT / folder).rglob("*.test.ts"))
    files += ["src/tools/write.test.ts", "src/tools/manager.test.ts", "src/tools/tool-execution-context.test.ts"]
    commands = [(f, ["bun", "--no-env-file", "--no-install", "test", f, "--timeout", "30000"], 120) for f in files]
elif mode == "focused":
    files = ["src/backend/local/native-fallback-config.test.ts", "src/backend/local/native-fallback-policy.test.ts", "src/backend/local/effective-local-agent.test.ts", "src/backend/native-inference-fallback.test.ts", "src/backend/native-inference-fallback-integration.test.ts", "src/websocket/listener/native-fallback-v4.test.ts", "src/websocket/listener/native-inference-fallback-integration.test.ts", "src/backend/pi-stream-adapter-retry.test.ts", "src/backend/provider-turn-executor.test.ts", "src/backend/local-provider-errors.test.ts"]
    commands = [("focused", ["bun", "--no-env-file", "--no-install", "test", *files], 120)]
else:
    commands = [(mode, ["bun", "--no-env-file", "run", mode.split("-")[0]], 600)]
with concurrent.futures.ThreadPoolExecutor(max_workers=3 if mode in ("suite", "suite-default") else 1) as executor:
    results = list(executor.map(lambda command: run(*command), commands))
summary = {"mode": mode, "commands": [r[0] for r in results], "passed_files": sum(r[0]["exit_code"] == 0 for r in results), "failed_files": sum(r[0]["exit_code"] != 0 for r in results)}
(OUT / f"{mode}.json").write_text(json.dumps(summary, indent=2) + "\n")
(OUT / f"{mode}.log").write_text("\n".join(f"COMMAND {r[0]['command']}\nEXIT {r[0]['exit_code']}\n{r[1]}" for r in results))
print(json.dumps({k: v for k, v in summary.items() if k != "commands"}))
sys.exit(1 if summary["failed_files"] else 0)
