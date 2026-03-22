# vestige-bridge subagent brief

## Objective
Work on `vestige-bridge` as the **recent cognitive provider** in the current OpenClaw memory architecture.

## Locked decisions
- `lossless-claw` remains the session lane
- `memory-cognee-revised` remains the durable file-backed lane
- `vestige-bridge` owns the recent/cognitive lane
- `orchestrator` owns final prompt composition and final recall injection
- provider mode is the production default
- injector mode is compatibility/debug only
- `agent_end` ingests/reinforces only; it does not own durable snapshot truth
- explicit export is the durable materialization seam
- Cognee file-backed content remains the durable source of truth

## Expected capabilities
- provider-mode recent candidate generation for orchestrator
- best-effort `agent_end` ingest / promote / demote flows
- explicit export that renders markdown snapshots with atomic write behavior
- local ledger suppression for already-materialized recent items
- fail-soft behavior on sidecar/network failures

## Main active quality target
Fix semantic gating so recent memory stores only the intended user-semantic content rather than assistant explanatory chatter or runtime wrappers.

## Avoid
- treating bridge-owned `before_prompt_build` injection as the primary architecture
- direct Cognee graph writes
- reverse reconcile / reimport from Cognee into Vestige
- introducing noisy wrappers or placeholder content into recent memory nodes

## Reference docs
- `/home/dongkai-claw/workspace/vestige-bridge/IMPLEMENTATION_CHECKLIST.md`
- `/home/dongkai-claw/.openclaw/workspace/memory-structure.md`
- `/home/dongkai-claw/.openclaw/skills/memory-maintenance/SKILL.md`
- `/home/dongkai-claw/workspace/orchestrator/index.js`
- `/home/dongkai-claw/workspace/orchestrator/openclaw.plugin.json`
