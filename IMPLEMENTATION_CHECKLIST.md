# vestige-bridge implementation checklist

Status sync: 2026-03-20

Legend:
- [x] done / verified enough for v1
- [-] superseded by current design or intentionally not required in v1
- [ ] still open / optional follow-up

## 0. Scope lock
- [x] `vestige-bridge` replaces the runtime role of the `vestige` skill.
- [x] `vestige-bridge` does **not** replace Cognee durable truth.
- [x] `lossless-claw` remains the session context layer.
- [x] `memory-cognee-revised` remains the durable file-backed memory layer.
- [x] `vestige-bridge` owns the cognitive/recent-memory lane.
- [x] Markdown shard snapshots remain the only formal Vestige -> Cognee transfer boundary.
- [x] v1 uses plugin runtime hooks only; no HOOK.md automation-event semantics.

## 1. v1 contracts frozen in the current implementation
- [x] Export path is **explicit export** first; v1 is not blocked on unresolved session-end export hooks.
- [x] `agent_end` only ingests/reinforces/best-effort memory operations; it does not rewrite snapshots.
- [x] v1 capture boundary is Vestige export -> shard snapshots only.
- [x] v1 does **not** do reverse reconcile/reimport from Cognee files back into Vestige.
- [x] Durable source of truth remains Cognee file-backed content.
- [x] Conflict rule: recent explicit user correction/preference can override older inference.
- [x] Conflict rule: source-backed/project durable truth stays Cognee-first.
- [x] Conflict rule: duplicate overlap keeps Cognee materialized item and drops Vestige recent item.

## 2. Repository bootstrap
- [x] Create package skeleton for OpenClaw plugin.
- [x] Add `package.json` with ESM, local plugin metadata, and scripts.
- [x] Add `openclaw.plugin.json` manifest.
- [x] Add `README.md` describing role boundaries and v1 scope.
- [x] Add `.gitignore`.
- [x] Add `src/` tree.
- [-] Add `docs/` or `notes/` only if implementation-relevant. Current repo does not need extra docs beyond README/checklist.

## 3. Core architecture modules
- [x] `src/index.*` plugin entry.
- [x] `src/config.*` config parsing + defaults.
- [x] `src/logger.*` structured logging helpers.
- [x] `src/sidecar-client.*` MCP-over-HTTP client for the Vestige sidecar.
- [x] `src/query-builder.*` build recall query from latest user turn + recent tail + optional hints.
- [x] `src/normalize.*` normalization helpers.
- [x] `src/dedupe.*` canonical key + overlap removal.
- [x] `src/packing.*` bucket priority + token/char budget packing.
- [x] `src/render.*` render `<vestige_recent>` packet + shard markdown snapshots.
- [x] `src/shards.*` shard grouping + validation.
- [x] `src/materialization.*` explicit export + atomic write flow.
- [x] `src/export-adapter.*` adapt Vestige export files into stable export envelopes.
- [x] `src/ledger.*` local materialization ledger for suppression/dedupe.
- [-] `src/correction-policy.*` as a standalone module is not necessary for v1 if current behavior remains correct.
- [-] `src/types.*` not required in the current JavaScript implementation.

## 4. Sidecar API surface (v1)
### Implemented client support
- [x] `search`
- [x] `smart-ingest`
- [x] `promote-memory`
- [x] `demote-memory`
- [x] `consolidate`
- [x] `health`
- [x] `intention`
- [x] `export` (used by the current explicit-export pipeline)

### Superseded / intentionally not used
- [-] `export-stable` — superseded by MCP `export` + local adapter.
- [-] `mark_materialized` — superseded by the local materialization ledger.

### Still open / optional wrappers
- [x] `stats`
- [ ] `session-context`
- [x] `memory`
- [ ] `codebase`

### API contract details
- [x] Define base URL config.
- [x] Define auth token path config.
- [x] Define timeout defaults.
- [x] Define fail-soft response handling.
- [x] Define retriable vs non-retriable errors.
- [x] Define request/response normalization.
- [x] Define debug logging for raw sidecar failures without leaking sensitive content.

## 5. Plugin config surface
- [x] `enabled`
- [x] `enabledAgents`
- [x] `baseUrl`
- [x] `authTokenPath`
- [x] `timeoutMs`
- [x] `debug`
- [x] `recall.maxResults`
- [x] `recall.maxTokens`
- [x] `recall.softTarget`
- [x] `recall.hardCap`
- [x] `recall.skipMaterialized`
- [x] `recall.maxTailMessages`
- [x] `export.rootDir`
- [x] `export.ledgerPath`
- [x] `export.tmpSuffix`
- [x] `export.enableExplicit`
- [x] `export.keepSourceExports`
- [x] `packing.bucketPriority`
- [x] `behavior.failSoft`
- [x] `behavior.enableAgentEndIngest`

## 6. Hook implementation plan
### `before_prompt_build`
- [x] Extract latest user text.
- [x] Extract recent conversation tail slice.
- [x] Optionally accept route/project hint when provided.
- [x] Build Vestige recent recall query.
- [x] Call sidecar `search`.
- [x] Filter to recent/alive/not-yet-materialized items only.
- [x] Normalize results.
- [-] Prepare data for cross-source dedupe with Cognee stable recall **inside the bridge**. This is not a bridge-internal responsibility; OpenClaw multi-plugin composition provides parallel recall at the system level.
- [x] Render `<vestige_recent>` block.
- [x] Return `prependContext` contribution.
- [x] Fail soft on sidecar errors/timeouts.

### `agent_end`
- [x] Build ingest payload from latest interaction.
- [x] Call `smart-ingest`.
- [x] Call promote/demote/consolidate best-effort paths when policy/events indicate.
- [-] Mark stable candidates via server callback. Superseded by explicit export + local ledger.
- [x] Log but do not throw on failure.
- [x] Do not write snapshots here.

### explicit export path
- [x] Implement a callable export entrypoint/function for manual or later scheduled use.
- [x] Call `consolidate` if required by export flow.
- [-] Call `export-stable`. Superseded by MCP `export` + local adapter.
- [x] Validate generation envelope.
- [x] Group items by `shard_key`.
- [x] Render shard markdown snapshots.
- [x] Write temp files.
- [x] Atomic rename into final files.
- [-] Call `mark_materialized` only for successfully written items. Superseded by local ledger update after successful materialization.
- [x] Surface export summary/logging.

## 7. Recall semantics
- [x] Recall is every-turn always-on.
- [-] Vestige recent recall and Cognee stable recall are parallel **inside the bridge**. This is an OpenClaw multi-plugin/system-composition concern, not a bridge-internal feature.
- [x] Vestige packet only contains recent/alive/not-yet-materialized memory.
- [x] Materialized items are skipped by default.
- [x] If sidecar recall fails, answer path continues with no injected recall packet.
- [x] Packet goes to `prependContext`, not `prependSystemContext`.
- [x] Packet format is compact and readable, not a JSON dump.

## 8. Query construction
- [x] Latest user turn is always included.
- [x] Recent tail summary/window is included.
- [x] Optional project/route hint is appended when available.
- [x] Query length is bounded.
- [x] Query builder avoids noisy boilerplate.
- [x] Query builder is deterministic enough for tests.

## 9. Dedupe + priority
- [x] Implement canonical proposition key.
- [x] Implement normalization before dedupe.
- [x] Implement exact duplicate collapse.
- [x] Implement near-duplicate conservative handling.
- [x] Prefer Cognee materialized stable over Vestige recent on overlap.
- [x] Prefer recent explicit user correction over older inference.
- [x] Prefer Cognee on auditable stable knowledge.
- [x] Preserve debug metadata explaining why items were dropped.

## 10. Packet rendering
- [x] Render `<vestige_recent>...</vestige_recent>` block.
- [x] One bullet = one proposition.
- [x] Keep packet compact.
- [x] Keep stable ordering.
- [x] Include lightweight metadata only if it helps packing/debugging.
- [x] Do not leak raw internal IDs unless needed.

## 11. Export envelope handling
- [x] Validate required envelope fields: `generation_id`, `generated_at`, `items`.
- [x] Validate item required fields: `vestige_id`, `shard_key`, `category`, `statement`, `transfer_reason`, `confidence`.
- [x] Reject invalid/empty statements.
- [x] Reject invalid shard keys.
- [x] Preserve optional metadata fields where present.
- [x] Keep generation_id for export correlation.

## 12. Shard layout + rendering
- [x] Support `global/` lane.
- [x] Support `personal/` lane.
- [x] Support `projects/` lane.
- [x] Enforce project slug validation.
- [x] Block reserved slugs.
- [x] No `misc` / `other` garbage bucket.
- [x] YAML frontmatter follows the locked spec.
- [x] Stable sort entries to minimize churn.
- [x] Overwrite per shard; do not append.

## 13. Atomic file lifecycle
- [x] Write to temp path first.
- [x] Flush complete content before rename.
- [x] Atomic rename to final shard path.
- [x] Never update durable suppression state before successful write completion.
- [x] If partial shard writes fail, only successful items affect suppression state.
- [x] Leave system recoverable on interruption.

## 14. Materialization callback / suppression state
- [-] Define `mark_materialized` callback endpoint. Superseded by local ledger.
- [-] Pass callback payload to server. Superseded by local ledger.
- [x] Record only successfully written items in the local ledger.
- [x] Keep local suppression updates idempotent enough for repeated exports.
- [x] Keep suppression-state failure separate from file-write success.

## 15. Failure handling
- [x] Sidecar timeout does not block user reply.
- [x] Export failure does not corrupt existing shards.
- [x] Partial write failure leaves clear logs/results.
- [x] Suppression-state failure does not roll back successful snapshot writes.
- [x] Next export can compensate.
- [x] Failures are observable without flooding logs.

## 16. Integration with `memory-cognee-revised`
- [x] Assume Cognee handles file-backed durable sync.
- [x] Do not write Cognee graph nodes directly.
- [x] Design for sync timing mismatch: export may happen after `agent_end` sync.
- [x] Accept that a later sync/next turn may pick up fresh shards.
- [ ] Verify overwrite/deletion propagation against real Cognee sync behavior in a durable end-to-end test.
- [x] Keep durable truth policy Cognee-first.

## 17. Testing and validation
### Unit / integration coverage already present
- [x] query builder
- [x] normalization
- [x] dedupe keys
- [x] packet rendering
- [x] shard key validation
- [x] project slug validation
- [x] export envelope validation
- [x] sidecar health + search smoke test
- [x] `before_prompt_build` with successful recall
- [x] `agent_end` ingest path
- [x] explicit export end-to-end with temp + rename
- [x] materialized items skipped on subsequent recall
- [x] partial write behavior around materialization flow

### Manual verification
- [x] plugin loads in OpenClaw.
- [x] packet appears in `prependContext`.
- [ ] no collision with orchestrator `appendSystemContext` under broader real-world usage (low-risk manual confidence check only).
- [x] fresh shard files are readable markdown.
- [ ] Cognee later sees/uses written shards in a real durable end-to-end verification.

### Still optional to add as dedicated tests
- [ ] `before_prompt_build` timeout/fail-soft path as an explicit targeted test.

## 18. Observability
- [x] optional debug mode for raw recall decisions.
- [ ] sidecar request latency metrics.
- [ ] recall hit count metrics.
- [ ] dropped-by-dedupe counters.
- [ ] packet size/tokens/char metrics.
- [ ] export shard count metrics surfaced in a more structured way.
- [ ] timeout/error counters.

## 19. Documentation migration from old skill
- [x] Preserve semantic role description from the `vestige` skill.
- [x] Preserve correction/promote/demote semantics that matter to runtime behavior.
- [x] Remove CLI-first usage as the primary runtime model.
- [x] Document that runtime is now plugin/sidecar based.
- [ ] Preserve trigger-intent mapping in dedicated documentation if that still matters operationally.
- [ ] Mark old skill as deprecated/compatibility-only once migration policy is finalized.

## 20. Explicitly out of scope for v1
- [x] reverse reconcile/reimport from Cognee files back into Vestige
- [x] advanced dream pipeline beyond basic consolidate/export integration
- [x] automatic project shard renaming/migration
- [x] embedding-heavy fuzzy clustering dedupe
- [x] broad startup `session-context` bundle as the primary path
- [x] direct writes from Vestige to Cognee graph nodes

## 21. Suggested implementation order (historical, now complete enough for v1)
- [x] bootstrap repo + plugin skeleton
- [x] sidecar client + config + health/search smoke test
- [x] `before_prompt_build` recall path
- [x] dedupe/packing/render pipeline
- [x] `agent_end` ingest path
- [x] explicit export + shard writer
- [-] `mark_materialized` callback — superseded by local ledger
- [x] tests + docs + manual validation

## 22. Remaining follow-up summary
These are the only meaningful non-blocking follow-ups left right now:
- [ ] Decide whether remaining optional wrappers (`session-context`, `codebase`) are worth adding.
- [ ] Run one real durable end-to-end verification that Cognee consumes updated shard snapshots as expected.
- [ ] Optionally add explicit timeout/fail-soft and orchestrator coexistence regression checks.
- [ ] Optionally add lightweight observability counters if ongoing tuning/debugging becomes necessary.
