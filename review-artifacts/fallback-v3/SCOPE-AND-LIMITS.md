# Native inference fallback V3 — review scope and limits

## Purpose

This bundle reproduces the authorized V3 candidate from base commit `1ff4d95eff41633e4fcf37a29a0587216666fe88` for independent review only. The eight source/test files match the supplied V3 patch byte-for-byte and their SHA-256 values match `IDENTIDADE-E-HASHES-V3.txt`.

## Review claims

- A quota-classified primary inference attempt may fall back to a compatible secondary model.
- Buffered delivery is guarded before and after every yielded event.
- Abort, ownership loss, or a manual model change prevents later stale tool/local-message/done events from escaping.
- Compaction and retry events use the same guarded delivery boundary.
- Included compact receipts record the focused test matrix, the loopback two-driver proof, and the independent flush counterproof.

## Limits and gates

- **Review only:** do not install, apply, merge, deploy, or restart from this branch yet.
- No production provider, credential, service, gateway, engine, Slack/TUI integration, or runtime configuration was used or changed while packaging this PR.
- No rollout or installed-process behavior is certified by these receipts.
- Arbitrary external effects after a process crash still require checkpoint/reconciliation design.
- The original source worktree and its index were treated as read-only during packaging.
- The bundled JSON receipts contain fake fixture authorization values only; no real secrets are included.

## Provenance

- Candidate patch SHA-256: `ffccf4c03c17a7c6c25df87d9763dad1a98aa2f510cb249a0b9cc6d5ed028c37`
- Supplied focused suite result: 52 passed, 0 failed, 159 assertions.
- Supplied checks: `bun run check` 12/12 PASS; `bun run build` PASS.
- Packaging agent configuration was verified before work: `openai-codex/gpt-5.6-sol`, reasoning effort `medium`.
