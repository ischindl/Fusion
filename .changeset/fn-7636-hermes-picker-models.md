---
"@runfusion/fusion": minor
---

summary: Hermes-configured models now appear in Fusion's model picker when the Hermes runtime is available.
category: feature
dev: /api/models additively merges `hermes profile list` results under the `hermes` provider via a short-TTL, single-flight cache (no per-request CLI spawn); rows are deduped by provider/id and never displace existing entries. Deferred item 1 of FN-7630.
