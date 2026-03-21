# vestige-bridge

`vestige-bridge` is an **OpenClaw plugin** that connects runtime hooks to a Vestige sidecar while keeping Cognee as the durable file-backed source of truth.

## Role boundaries

- **lossless-claw**: live session/context lane
- **vestige-bridge**: recent/cognitive lane
- **memory-cognee-revised**: durable file-backed lane
- **markdown shard snapshots**: the only formal Vestige -> Cognee transfer boundary

## v1 behavior

- **default mode: provider** — emit structured recent recall candidates for orchestrator
- **compatibility mode: injector** — direct every-turn recent recall in `before_prompt_build`
- injector mode renders compact `<vestige_recent>...</vestige_recent>` into `prependContext`
- fail-soft sidecar calls
- best-effort `agent_end` smart-ingest
- explicit export uses **`export` MCP tool + local adapter** (no Vestige code changes)
- shard validation + markdown rendering + atomic writes
- **local materialization ledger** to suppress already-exported Vestige ids

## Explicit export flow (current)

1. Call Vestige MCP **`export`** tool to write a JSON/JSONL export file.
2. Parse `KnowledgeNode` records and **classify** into stable items.
3. Render shard snapshots under `memory/vestige/*` (overwrite semantics).
4. Update local ledger to remember which Vestige ids were materialized.

By default the ledger lives in a **user-private state directory**, not in the repo and not under the agent workspace:

- `~/.local/state/openclaw/vestige-bridge/ledgers/<hash-of-rootDir>.json`
- honors `XDG_STATE_HOME` when set
- directory/file permissions are tightened to `0700` / `0600`

### Why the ledger?

We do not modify the Vestige repo or write back `mark_materialized`, so the bridge keeps a local ledger to avoid re-injecting already-materialized nodes into recent recall packets.

The ledger is intentionally minimal and stores only:

- `vestige_id` (as the map key)
- `shard_key`
- `generation_id`
- `generated_at`
- `materialized_at`

## Configuration

`recallMode` supports:

- `provider` (**default**): register a structured recent-memory provider for orchestrator; do not inject prompt text directly
- `injector`: keep standalone/debug behavior by registering `before_prompt_build` and returning `prependContext`

The `export` config supports:

- `rootDir`: output directory for shard snapshots
- `ledgerPath`: optional override for the local materialization ledger file (default: hashed file under the user state dir)
- `tmpSuffix`: temp suffix for atomic writes
- `enableExplicit`: enable explicit export helper
- `keepSourceExports`: keep raw Vestige export files when bridge generated the path
