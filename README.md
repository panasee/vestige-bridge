# vestige-bridge

`vestige-bridge` is an OpenClaw plugin that keeps Vestige in the cognitive/recent-memory lane while leaving Cognee as the durable file-backed source of truth.

## Role boundaries

- `lossless-claw`: session context lane
- `vestige-bridge`: recent/cognitive recall lane
- `memory-cognee-revised`: durable file-backed lane
- markdown shard snapshots: the only formal Vestige -> Cognee transfer boundary

## v1 behavior

- every-turn recent recall in `before_prompt_build`
- compact `<vestige_recent>...</vestige_recent>` injection via `prependContext`
- fail-soft sidecar calls
- `agent_end` smart-ingest / reinforce path
- explicit stable export path
- per-shard overwrite snapshots with temp + atomic rename
- `mark_materialized` callback after successful writes only

## Out of scope for v1

- reverse reconcile/reimport from Cognee files back into Vestige
- direct graph writes into Cognee
- append-only snapshot dumps
- broad session-start bundle recall as the main path

## Notes

This repository is intentionally standard-library only for the first implementation.
