# vestige-bridge subagent brief

## Objective
Implement a first working version of the `vestige-bridge` OpenClaw plugin in this repository.

## Locked decisions
- Use this repo: `/home/dongkai-claw/workspace/vestige-bridge`
- Model target for all subagents: `openai-codex/gpt-5.4`
- Thinking target for all subagents: `high`
- `lossless-claw` remains session lane
- `memory-cognee-revised` remains durable file-backed lane
- `vestige-bridge` owns recent/cognitive lane
- v1 recall is every-turn always-on in `before_prompt_build`
- v1 export path is explicit export first
- `agent_end` ingests/reinforces only; no snapshot rewrite there
- v1 capture boundary is Vestige stable export -> markdown shard snapshots only
- Cognee file-backed content is durable source of truth
- No reverse reconcile/reimport from Cognee files back into Vestige in v1
- Use plugin runtime hooks only

## Expected v1 capabilities
- Plugin skeleton loads in OpenClaw
- Sidecar client supports health/search/smart-ingest/promote-memory/demote-memory/export-stable/consolidate
- `before_prompt_build` can inject a compact `<vestige_recent>` packet via `prependContext`
- explicit export can render shard markdown snapshots with temp + atomic rename
- successful export can call `mark_materialized`
- fail-soft behavior on sidecar/network failures

## File ownership split
### Agent A
Owns:
- package/manifest/bootstrap
- config/logger/sidecar client
- plugin entry wiring if needed

### Agent B
Owns:
- query builder
- normalize/dedupe/packing/render for recent recall packet
- before_prompt_build-specific logic helpers

### Agent C
Owns:
- export/materialization path
- shard validation/rendering
- atomic write path
- callback payload + docs/tests for export flow

## Avoid
- Editing the checklist except when necessary to reflect completed implementation
- Adding unnecessary dependencies
- Touching repos outside this repo
- Implementing reverse sync/reimport
- Direct Cognee graph writes

## Reference docs
- `/home/dongkai-claw/workspace/vestige-bridge/IMPLEMENTATION_CHECKLIST.md`
- `/home/dongkai-claw/.openclaw/workspace/memory-structure.md`
- `/home/dongkai-claw/.openclaw/skills/vestige/SKILL.md`
- `/home/dongkai-claw/workspace/orchestrator/index.js`
- `/home/dongkai-claw/workspace/orchestrator/openclaw.plugin.json`

## Working style
- Keep code clean and minimal
- Prefer standard library only unless clearly necessary
- Leave TODOs only when truly blocked by unverified OpenClaw hook surfaces
- Add lightweight docs/comments where it helps maintainability
