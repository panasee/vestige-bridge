# Implementation checklist

Current focus:
- recent recall pipeline
- recent ingest flow
- LCM trigger and schema validation
- crystallizer-ledger-based suppress

Guardrails:
- suppress follows crystallizer durable success only
- vestige-bridge is not a durable writer
- avoid reintroducing export/materialization paths into this plugin
