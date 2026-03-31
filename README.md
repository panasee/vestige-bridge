# vestige-bridge

Vestige bridge focused on **recent recall**, **recent ingest**, and **LCM-triggered maintenance**.

## Scope
- provider/injector recent recall from Vestige
- suppress recent items using crystallizer success state from `materialized-sources.json`
- ingest recent memories into Vestige
- validate and inspect LCM state for maintenance triggers

## Current invariants
- suppress truth source is crystallizer durable success state only
- this plugin is not a durable writer
- durable materialization belongs to memory-crystallizer, not vestige-bridge
