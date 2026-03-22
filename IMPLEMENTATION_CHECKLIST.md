# vestige-bridge implementation checklist

Status: current reference

This checklist reflects the **current provider-first architecture** for `vestige-bridge`.
Older checklist items that treated bridge-owned production prompt injection as the reference path were removed to avoid future drift.

## Architecture role
`vestige-bridge` is the **recent cognitive lane**.

It owns:
- recent cognitive recall candidate generation
- `agent_end` ingest / reinforce / demote best-effort actions
- explicit export / materialization into markdown snapshots
- local materialization-ledger suppression for already-exported items

It does **not** own:
- final prompt composition
- durable file-backed source of truth
- current-session continuity
- direct Vestige -> Cognee graph writes

## Production rule
- `orchestrator` is the sole final prompt composer / injector
- `vestige-bridge` defaults to **provider mode**
- `injector` mode is compatibility/debug only
- repo docs and future work notes must treat provider mode as the default production behavior

## Current implementation priorities
- [x] Recent recall candidates exist for orchestrator composition
- [x] `agent_end` handles best-effort ingest / promote / demote flows
- [x] Explicit export path materializes stable markdown snapshots
- [x] Local ledger suppresses already-materialized recent items
- [ ] Keep docs/tests/examples aligned so they do not imply bridge-owned production `before_prompt_build` injection
- [ ] Keep recent ingest semantic-only
- [ ] Eliminate assistant explanatory chatter from recent memory payloads
- [ ] Preserve clear lane separation between recent cognitive memory and durable Cognee memory

## Guardrails
- Do not reintroduce this repo as the primary production owner of prompt injection
- Do not document injector mode as the normal runtime path
- Do not mix runtime wrappers/debug/provenance/checkpoint noise into recent memory payloads
- Do not bypass the markdown materialization boundary for durable storage

## Current known issue
The main unresolved live issue is semantic gating of recent ingest:
- lane identity is correct
- payload purity is not yet fully correct
- assistant explanatory text still needs to be excluded from recent memory in live runtime
