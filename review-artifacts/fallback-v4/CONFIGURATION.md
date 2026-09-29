# Native local inference fallback V4 — review only

## Activation and ownership

Production call chain: `getBackend` / `getBackendForMode("local")` / `configureBackendMode` → `createExperimentalLocalBackend` (`backend.ts`) → `LocalBackend` → `createLocalExecutor` → `loadNativeFallbackConfig` → per-inference `createNativeFallbackPolicy` → `PiStreamAdapter`.

V3 packaged at `3262fbaba1d831a678ab225e03a3a009b664dd41` exposed only an injected policy. The same factory ignored the proposed config, sent two primary requests, then errored after the real Write. V4 reads `<local-backend-storage>/native-inference-fallback.json`. Missing file or `{"version":1,"enabled":false}` leaves the ordinary unbuffered path active. Invalid/unreadable ON configuration fails closed. No CLI/global settings, provider records, credentials or installed services were changed by this PR.

The old `autoSwapOnQuotaLimit` / `supportsHostedAutoQuotaFallback = !localModelCatalog` branch in `use-conversation-loop.ts` remains **hosted only**. Its flag does not opt local sessions in. Local fallback is deliberately inside backend dispatch, not a second UI retry. This avoids enabling all local agents or replaying user inputs. The configured target must be an exact local agent ID; unknown agents remain on baseline. Configuration is read at backend construction; changes during an active inference invalidate its policy instead of taking ownership mid-flight.

The single in-task owner is `native-inference`; the listener continues to own the task/lease and tools. Fallback does not update the persisted agent/conversation model, invoke `model set`, restart a listener, resubmit the user message, execute tools, or run a watchdog. The external vigia is **not** disabled by this code. Before enabling ON, an operator must quiesce its writes for the exact scopes, settle any old ownership/reversion record, and attest `externalController: "disabled-for-scopes"`. This is an explicit deployment gate, not an automatic or cryptographic handoff. No implementation can claim an unmodified external writer participates in this protocol.

## Configuration example (not installed)

`example-config.json` is OFF and contains placeholder scope, non-personal public model handles, and only credential/provider references. An operator may choose a different approved chain (2–4 unique handles) from the actual runtime catalog. Primary selection remains the saved model; its model and effective effort must match chain[0] before any swap is authorized. A different manual preset is refused rather than silently overwritten. Each reserve gets its configured effort, never an implicit cheaper preset. Set the agent/conversation context/output limits compatibly before enabling; this example does not overwrite them.

`credentialProvider` names the existing provider's runtime/auth-store lookup, not a secret or another account. It must equal the handle's provider. The normal catalog and credential resolver is the only dispatcher; no model/provider substitution occurs in the stream function. No credential values enter config, telemetry, patches or production examples. The scenario uses clearly fake keys in isolated provider registrations.

Checks before reserve dispatch: exact published model/provider, usable credential, catalog context/output capacity, enough headroom for the current input, image capability, declared tool capability, reasoning capability and exact effort mapping. Missing/incompatible reserves produce a `native_inference_fallback` rejection event and a terminal error. Tool support is an explicit operator-approved capability in config (pi-ai has no universal catalog boolean for tool use), not inferred from a model's name. The HTTP fixture demonstrates `reasoning_effort: high` on both drivers. It does not certify every provider's meaning of effort.

`lineage: "self"` admits only the configured agent's own input. Task correlation comes from the last durable user message OTID (or native message ID), plus actual agent/conversation scope. Caller body lineage fields do not grant eligibility. **Automatic child/delegation inheritance is intentionally unsupported**, not simulated as proven. Add a child as its own explicit owner/scope only after authorization; a durable delegated-lineage producer remains future work. No allowlist enumeration or broad wildcard scope exists.

## Safety and observability

Quota recognition is narrowly the typed pi-ai provider failure envelope with status 429 and code 1310. Generic 429, 401/403, timeouts and quoted transcript text do not authorize swapping. Additional provider quota codes need independently evidenced classifiers; they are not claimed supported here.

All model output is buffered for a scoped inference until provider success, bounded by V3's event/byte ceilings. Partial text/tool calls from a failed attempt cannot reach the tool manager. V3's before/after-yield invalidation guards are preserved. Scoped ON cancellation now propagates from the actual returned stream controller into the per-inference adapter. Unconfigured/OFF dispatch and existing compaction behavior remain on their baseline path. A configured deadline is also an abort signal, not just a check after an endless HTTP await. Effective selection is shared with normal dispatch, including outer conversation context limits, to detect manual changes consistently.

Attempt/rejection events contain model, provider, effort, outcome, native task identity and owner; no prompt or key. OFF produces no such events. A tool completed before quota is retained with its result; only the following inference is retried on reserve. The task may contain several normal tool-continuation runs; fallback itself creates no run or new user input.

## Evidence and limitations

- `before.json`: exact packaged V3 production sources + new test harness; factory never dispatched reserve.
- `after-bun.json`: same factory, actual registered Write tool, one effect, same approval input on primary/reserve.
- `after-listener-bun-final.json` / `after-listener-node-final.json`: **one** `handleIncomingMessage` call. Actual listener → factory backend → pi-ai HTTP drivers → real registry/tool manager Bash append → same lease completes on reserve. The non-idempotent append contains exactly one line; start/end events and tool results each occur once. No harness tool call or manually written effect in this variant. Earlier `after-listener-{bun,node}.json` used real Write and is retained as preliminary evidence, not the final byte identity.
- Partial-SSE listener test sends real text and a Write request followed by a provider-error envelope. Neither text nor that tool escapes; one prior effect remains. The SSE response itself is HTTP200, not an impossible mid-response HTTP429; the error envelope is labelled separately from the primary HTTP429 test.
- Allowlisted HOME/state/cache/TMPDIR and isolated worktree cwd. No real Slack/TUI/provider/secret. Warmup memory/secret hydration is stubbed off; transport is an in-memory sink; HTTP endpoints are loopback fixtures. The effect, tool manager, listener, factory, catalog/auth resolution and pi-ai drivers are real.
- Node proof is a separately built harness from the same production modules, not an installed CLI smoke test. The product bundle is built and hashed separately. No service was installed/restarted.
- Exactly-once across crashes, concurrent processes or uncertain external effects is **not** established. R-storage-2 is not merged here. The original V3 synthetic lineage test and manually appended effect test are historical unit evidence, not relabelled as live proof.

## Rollback and gates

No production rollback is necessary: nothing was applied. Future rollback: quiesce the owning task, switch the config OFF/remove it, recreate the backend with the approved prior artifact, then separately hand scopes back to the existing vigia after reconciling ownership. Do not run both writers or replay an uncertain tool effect. Required before rollout: independent Instinct PASS, explicit scope/reserve/credential approval, vigia handoff, operational artifact verification and a separately authorized real-service smoke test. No merge authorized by this PR.
