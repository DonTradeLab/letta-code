#!/usr/bin/env python3
"""Generate source-only canonical patches and review identities, without staging."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
BASE = "1ff4d95eff41633e4fcf37a29a0587216666fe88"
V3 = "3262fbaba1d831a678ab225e03a3a009b664dd41"


def git(*args, allowed=(0,)):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if result.returncode not in allowed:
        raise RuntimeError(result.stderr.decode())
    return result.stdout


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


untracked = git("ls-files", "--others", "--exclude-standard", "--", "src").decode().splitlines()
checks = {}
for base, name in [(BASE, "native-inference-fallback-v4.patch"), (V3, "v3-to-v4.patch")]:
    patch = b""
    changed = sorted(set(git("diff", "--name-only", base, "--", "src").decode().splitlines() + untracked))
    for path in changed:
        if path in untracked:
            patch += git("diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", path, allowed=(0, 1))
        else:
            patch += git("diff", "--binary", "--full-index", base, "--", path)
    (OUT / name).write_bytes(patch)
    git("apply", "--reverse", "--check", str(OUT / name))
    with tempfile.TemporaryDirectory(prefix="fallback-v4-index-") as index_dir:
        env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": index_dir, "GIT_INDEX_FILE": str(Path(index_dir) / "index")}
        subprocess.run(["git", "read-tree", base], cwd=ROOT, env=env, check=True, capture_output=True)
        subprocess.run(["git", "apply", "--cached", "--check", str(OUT / name)], cwd=ROOT, env=env, check=True, capture_output=True)
    checks[name] = {"base": base, "scope": "all changed source/tests under src; review artifacts excluded to avoid self-reference", "reverse_apply_check_exit": 0, "forward_apply_check_isolated_index_exit": 0, "sha256": digest(OUT / name)}
paths = sorted(set(git("diff", "--name-only", BASE, "--", "src").decode().splitlines() + untracked))
source_hashes = {path: digest(ROOT / path) for path in paths}
counts = {}
for name in ["focused", "suite-final"]:
    text = (OUT / f"{name}.log").read_text()
    counts[name] = {"passed": sum(map(int, re.findall(r"^\s*(\d+) pass$", text, re.M))), "failed": sum(map(int, re.findall(r"^\s*(\d+) fail$", text, re.M))), "assertions": sum(map(int, re.findall(r"^\s*(\d+) expect\(\) calls$", text, re.M)))}
patterns = {"github-token": r"gh[pousr]_[A-Za-z0-9]{30,}", "github-pat": r"github_pat_[A-Za-z0-9_]{40,}", "slack-token": r"xox[baprs]-[0-9A-Za-z-]{24,}", "private-key": r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----", "provider-key": r"sk-(?:proj-)?[A-Za-z0-9]{32,}"}
scan_paths = [ROOT / path for path in paths] + [p for p in OUT.iterdir() if p.is_file() and p.suffix != ".mjs" and p.name not in ("MANIFEST.json", "SHA256SUMS", "secret-scan.json")]
findings = []
for path in scan_paths:
    text = path.read_text(errors="replace")
    for label, pattern in patterns.items():
        if re.search(pattern, text):
            findings.append({"path": str(path.relative_to(ROOT)), "pattern": label})
scan = {"method": "known credential/private-key prefix scan + manual diff review; not a proof of absence of all secrets", "files_scanned": len(scan_paths), "findings": findings, "fixture_keys": "fake-* only; no real credential source read"}
(OUT / "secret-scan.json").write_text(json.dumps(scan, indent=2) + "\n")
if findings:
    raise RuntimeError("Secret scan requires review (values not printed)")
manifest = {"candidate": "V4 review-only, not installed", "packaged_v3": V3, "base": BASE,
            "branch": git("branch", "--show-current").decode().strip(), "version": json.loads((ROOT / "package.json").read_text())["version"],
            "sources": source_hashes, "source_identity_sha256": hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest(),
            "package_sha256": digest(ROOT / "package.json"), "lock_sha256": digest(ROOT / "bun.lock"),
            "bundle_sha256": digest(ROOT / "letta.js"), "proof_bundle_sha256": digest(OUT / "run-proof.mjs"),
            "patches": checks, "tests": counts, "full_suite_files_passed": 177,
            "check": "12/12 exit 0 (check-release.log)", "typecheck_exit": 0, "build_exit": 0,
            "model": {"handle": "openai-codex/gpt-6-astra", "effort": "max", "context": 272000},
            "limits": ["self lineage only; no implicit child inheritance", "operator-gated vigia handoff; no automatic external writer coordination", "no crash/external-effect exactly-once guarantee", "loopback synthetic providers; no real Slack/TUI/services", "Node harness from production modules, not installed CLI smoke test"],
            "preliminary_failures": "suite.log forced local mode broke memory-path expectation; parallel suite-default.log had reconnect timing failure; baseline and candidate isolated reconnect checks and final serial suite all pass. Earlier check/type errors preserved."}
(OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
# Match the repository commit hook before sealing receipt hashes.
bunx = shutil.which("bunx") or str(Path.home() / ".bun/bin/bunx")
with tempfile.TemporaryDirectory(prefix="fallback-v4-format-") as home:
    env = {"PATH": str(Path(bunx).parent) + ":/opt/homebrew/bin:/usr/bin:/bin", "HOME": home}
    subprocess.run([bunx, "--bun", "@biomejs/biome@2.2.5", "check", "--write", *[str(p) for p in sorted(OUT.glob("*.json"))], str(OUT / "run-proof.ts")], cwd=ROOT, env=env, check=True)
artifacts = sorted(p for p in OUT.iterdir() if p.is_file() and p.name not in ("SHA256SUMS", "run-proof.mjs", "run-proof.mjs.map"))
(OUT / "SHA256SUMS").write_text("".join(f"{digest(p)}  {p.name}\n" for p in artifacts))
print(json.dumps({"source_identity": manifest["source_identity_sha256"], "bundle": manifest["bundle_sha256"], "tests": counts, "patch_checks": checks, "secret_scan_findings": len(findings)}, indent=2))
