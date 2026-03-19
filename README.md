# vestige-bridge

`vestige-bridge` is an **OpenClaw plugin** that connects runtime hooks to a Vestige sidecar while keeping Cognee as the durable file-backed source of truth.

## Role boundaries

- **lossless-claw**: live session/context lane
- **vestige-bridge**: recent/cognitive lane
- **memory-cognee-revised**: durable file-backed lane
- **markdown shard snapshots**: the only formal Vestige -> Cognee transfer boundary

## v1 behavior

- every-turn recent recall in `before_prompt_build`
- compact `<vestige_recent>...</vestige_recent>` injection via `prependContext`
- fail-soft sidecar calls
- best-effort `agent_end` smart-ingest
- explicit stable export path
- shard validation + markdown rendering + atomic writes
- `mark_materialized` callback only for successfully written items

## Out of scope for v1

- reverse reconcile/reimport from Cognee files back into Vestige
- direct graph writes into Cognee
- append-only shard dumps
- automatic session-end export hook dependency

## Sidecar operations

The runtime client exposes these methods:

- `health()`
- `search(payload)`
- `smartIngest(payload)`
- `promoteMemory(payload)`
- `demoteMemory(payload)`
- `exportStable(payload)`
- `consolidate(payload)`
- `markMaterialized(payload)`

The client accepts both `/vestige/...` and plain endpoint variants when available, and returns normalized envelopes instead of throwing by default.

## Runtime helper

`src/index.js` exports both the default plugin object and `createVestigeBridgeRuntime()` so the same config/logger/client plumbing can be reused from scripts or explicit export flows.
