# vestige-bridge implementation checklist

## 0. Scope lock
- [ ] `vestige-bridge` replaces the runtime role of the `vestige` skill.
- [ ] `vestige-bridge` does **not** replace Cognee durable truth.
- [ ] `lossless-claw` remains the session context layer.
- [ ] `memory-cognee-revised` remains the durable file-backed memory layer.
- [ ] `vestige-bridge` owns the cognitive/recent-memory lane.
- [ ] Markdown shard snapshots remain the only formal Vestige -> Cognee transfer boundary.
- [ ] v1 uses plugin runtime hooks only; no HOOK.md automation-event semantics.

## 1. v1 contracts to freeze before/while coding
- [ ] Export path is **explicit export** first; do not block v1 on unresolved session-end hook selection.
- [ ] `agent_end` only ingests/reinforces/marks candidates; it does not rewrite snapshots.
- [ ] v1 capture boundary is Vestige stable export -> shard snapshots only.
- [ ] v1 does **not** do reverse reconcile/reimport from Cognee files back into Vestige.
- [ ] Durable source of truth is always Cognee file-backed content.
- [ ] Conflict rule is frozen:
  - [ ] recent explicit user correction/preference can override older inference
  - [ ] source-backed/project durable truth stays Cognee-first
  - [ ] duplicate overlap keeps Cognee materialized item, drops Vestige recent item

## 2. Repository bootstrap
- [ ] Create package skeleton for OpenClaw plugin.
- [ ] Add `package.json` with ESM, local plugin metadata, and scripts.
- [ ] Add `openclaw.plugin.json` (or equivalent plugin manifest expected by OpenClaw).
- [ ] Add `README.md` describing role boundaries and v1 scope.
- [ ] Add `.gitignore`.
- [ ] Add `src/` tree.
- [ ] Add `docs/` or `notes/` only if they are implementation-relevant.

## 3. Core architecture modules
- [ ] `src/index.*` plugin entry.
- [ ] `src/config.*` config parsing + defaults.
- [ ] `src/logger.*` structured logging helpers.
- [ ] `src/sidecar-client.*` HTTP client for Vestige sidecar.
- [ ] `src/query-builder.*` build recall query from latest user turn + recent tail + optional hints.
- [ ] `src/normalize.*` normalization helpers.
- [ ] `src/dedupe.*` canonical key + overlap removal.
- [ ] `src/packing.*` bucket priority + token/char budget packing.
- [ ] `src/render.*` render `<vestige_recent>` packet + shard markdown snapshots.
- [ ] `src/shards.*` shard grouping + validation.
- [ ] `src/materialization.*` explicit export + atomic write + callback flow.
- [ ] `src/correction-policy.*` exported constants/helpers for conflict policy.
- [ ] `src/types.*` shared types/interfaces if using TypeScript.

## 4. Sidecar API surface (v1)
### Must implement client support
- [ ] `search`
- [ ] `smart-ingest`
- [ ] `promote-memory`
- [ ] `demote-memory`
- [ ] `export-stable`
- [ ] `consolidate`
- [ ] `health`

### Should implement client support
- [ ] `intention`
- [ ] `stats`

### Later / optional
- [ ] `session-context`
- [ ] `ingest`
- [ ] `memory`
- [ ] `codebase`

### API contract details
- [ ] Define base URL config.
- [ ] Define timeout defaults.
- [ ] Define fail-soft response handling.
- [ ] Define retriable vs non-retriable errors.
- [ ] Define request/response schema normalization.
- [ ] Define debug logging for raw sidecar failures without leaking sensitive content.

## 5. Plugin config surface
- [ ] `enabled`
- [ ] `baseUrl`
- [ ] `timeoutMs`
- [ ] `debug`
- [ ] `recall.maxResults`
- [ ] `recall.maxTokens`
- [ ] `recall.softTarget`
- [ ] `recall.hardCap`
- [ ] `recall.skipMaterialized`
- [ ] `export.rootDir`
- [ ] `export.tmpSuffix`
- [ ] `export.enableExplicit`
- [ ] `packing.bucketPriority`
- [ ] `behavior.failSoft`
- [ ] `behavior.enableAgentEndIngest`

## 6. Hook implementation plan
### `before_prompt_build`
- [ ] Extract latest user text.
- [ ] Extract recent conversation tail summary/input slice.
- [ ] Optionally accept route/project hint from surrounding runtime if available.
- [ ] Build Vestige recent recall query.
- [ ] Call sidecar `search`.
- [ ] Filter to recent/alive/not-yet-materialized items only.
- [ ] Normalize results.
- [ ] Prepare data for cross-source dedupe with Cognee stable recall.
- [ ] Render `<vestige_recent>` block.
- [ ] Return `prependContext` contribution.
- [ ] Fail soft on sidecar errors/timeouts.

### `agent_end`
- [ ] Build ingest payload from latest interaction.
- [ ] Call `smart-ingest`.
- [ ] Call promote/reinforce path when policy indicates.
- [ ] Mark stable candidates when policy indicates.
- [ ] Log but do not throw on failure.
- [ ] Do not write snapshots here.

### explicit export path
- [ ] Implement a callable export entrypoint/function for manual or later scheduled use.
- [ ] Call `consolidate` if required by export flow.
- [ ] Call `export-stable`.
- [ ] Validate generation envelope.
- [ ] Group items by `shard_key`.
- [ ] Render shard markdown snapshots.
- [ ] Write temp files.
- [ ] Atomic rename into final files.
- [ ] Call `mark_materialized` only for successfully written items.
- [ ] Surface export summary/logging.

## 7. Recall semantics
- [ ] Recall is every-turn always-on.
- [ ] Vestige recent recall and Cognee stable recall are parallel, not fallback.
- [ ] Vestige packet only contains recent/alive/not-yet-materialized memory.
- [ ] Materialized items are skipped by default.
- [ ] If both recall paths fail, answer path continues with no injected recall packet.
- [ ] Packet goes to `prependContext`, not `prependSystemContext`.
- [ ] Packet format is compact and readable, not JSON dump.

## 8. Query construction
- [ ] Latest user turn is always included.
- [ ] Recent tail summary/window is included.
- [ ] Optional project/route hint is appended when available.
- [ ] Query length is bounded.
- [ ] Query builder avoids noisy boilerplate.
- [ ] Query builder is deterministic enough for tests.

## 9. Dedupe + priority
- [ ] Implement canonical proposition key.
- [ ] Implement normalization before dedupe.
- [ ] Implement exact duplicate collapse.
- [ ] Implement near-duplicate conservative handling.
- [ ] Prefer Cognee materialized stable over Vestige recent on overlap.
- [ ] Prefer recent explicit user correction over older inference.
- [ ] Prefer Cognee on auditable stable knowledge.
- [ ] Preserve debug metadata explaining why items were dropped.

## 10. Packet rendering
- [ ] Render `<vestige_recent>...</vestige_recent>` block.
- [ ] One bullet = one proposition.
- [ ] Keep packet compact.
- [ ] Keep stable ordering.
- [ ] Include lightweight metadata only if it helps packing/debugging.
- [ ] Do not leak raw internal IDs unless needed.

## 11. Export-stable envelope handling
- [ ] Validate required envelope fields: `generation_id`, `generated_at`, `items`.
- [ ] Validate item required fields: `vestige_id`, `shard_key`, `category`, `statement`, `transfer_reason`, `confidence`.
- [ ] Reject invalid/empty statements.
- [ ] Reject invalid shard keys.
- [ ] Preserve optional metadata fields where present.
- [ ] Keep generation_id for callback correlation.

## 12. Shard layout + rendering
- [ ] Support `global/` lane.
- [ ] Support `personal/` lane.
- [ ] Support `projects/` lane.
- [ ] Enforce project slug validation.
- [ ] Block reserved slugs.
- [ ] No `misc` / `other` garbage bucket.
- [ ] YAML frontmatter follows the locked spec.
- [ ] Stable sort entries to minimize churn.
- [ ] Overwrite per shard; do not append.

## 13. Atomic file lifecycle
- [ ] Write to temp path first.
- [ ] Flush complete content before rename.
- [ ] Atomic rename to final shard path.
- [ ] Never call materialization callback before successful rename.
- [ ] If partial shard writes fail, only callback successful items.
- [ ] Leave system recoverable on interruption.

## 14. Materialization callback
- [ ] Define callback method/endpoint for `mark_materialized`.
- [ ] Pass `generation_id`, `generated_at`, `written_shards`, and successful item references.
- [ ] Mark only successfully written items.
- [ ] Keep callback idempotent where possible.
- [ ] Log callback failure separately from file-write success.

## 15. Failure handling
- [ ] Sidecar timeout does not block user reply.
- [ ] Export failure does not corrupt existing shards.
- [ ] Partial write failure leaves clear logs.
- [ ] Callback failure does not roll back successful snapshot writes.
- [ ] Next export/sync/cron can compensate.
- [ ] Failures are observable without flooding logs.

## 16. Integration with `memory-cognee-revised`
- [ ] Assume Cognee handles file-backed durable sync.
- [ ] Do not write Cognee graph nodes directly.
- [ ] Design for sync timing mismatch: export may happen after `agent_end` sync.
- [ ] Accept that a later sync/next turn may pick up fresh shards.
- [ ] Verify overwrite/deletion propagation is compatible with Cognee sync behavior.
- [ ] Keep durable truth policy Cognee-first.

## 17. Testing
### Unit tests
- [ ] query builder
- [ ] normalization
- [ ] dedupe keys
- [ ] packet rendering
- [ ] shard key validation
- [ ] project slug validation
- [ ] export envelope validation

### Integration tests
- [ ] sidecar health + search smoke test
- [ ] `before_prompt_build` with successful recall
- [ ] `before_prompt_build` timeout/fail-soft path
- [ ] `agent_end` ingest path
- [ ] explicit export end-to-end with temp + rename
- [ ] partial write + callback subset behavior
- [ ] materialized items skipped on subsequent recall

### Manual verification
- [ ] plugin loads in OpenClaw
- [ ] packet actually appears in `prependContext`
- [ ] no collision with orchestrator `appendSystemContext`
- [ ] fresh shard files are readable markdown
- [ ] Cognee later sees/uses written shards

## 18. Observability
- [ ] sidecar request latency
- [ ] recall hit count
- [ ] dropped-by-dedupe count
- [ ] packet size/tokens/char estimate
- [ ] export shard count
- [ ] successful callback item count
- [ ] timeout/error counts
- [ ] optional debug mode for raw recall decisions

## 19. Documentation migration from old skill
- [ ] Preserve semantic role description from `vestige` skill.
- [ ] Preserve trigger-intent mapping.
- [ ] Preserve correction/promote/demote semantics.
- [ ] Remove CLI-first usage as the primary runtime model.
- [ ] Document that runtime is now plugin/sidecar based.
- [ ] Mark old skill as deprecated/compatibility-only once bridge is ready.

## 20. Explicitly out of scope for v1
- [ ] reverse reconcile/reimport from Cognee files back into Vestige
- [ ] advanced dream pipeline beyond basic consolidate/export integration
- [ ] automatic project shard renaming/migration
- [ ] embedding-heavy fuzzy clustering dedupe
- [ ] broad startup `session-context` bundle as the primary path
- [ ] direct writes from Vestige to Cognee graph nodes

## 21. Suggested implementation order
- [ ] bootstrap repo + plugin skeleton
- [ ] sidecar client + config + health/search smoke test
- [ ] `before_prompt_build` recall path
- [ ] dedupe/packing/render pipeline
- [ ] `agent_end` ingest path
- [ ] explicit export + shard writer
- [ ] `mark_materialized` callback
- [ ] tests + docs + manual validation
