---
"@runfusion/fusion": minor
---

Ingest external signals (Sentry / Datadog / PagerDuty / generic webhook) into triage tasks via a common `SignalSource` adapter seam (U11, KTD8).

- New `POST /api/signals/:provider` endpoints, mirroring the GitHub ingestion path. Verified, normalized signals create a task in the `triage` column via the existing task store.
- Generic webhook is the must-work path; Sentry/Datadog/PagerDuty are thin adapters with provider-specific HMAC verification + payload normalization. Each normalized `Signal` carries a `groupingKey` (Sentry `issue.id`, PagerDuty `incident.id`, Datadog monitor key; the generic webhook requires a caller-supplied key or falls back to `source + normalized-title`) for the downstream storm guard.
- Security (mandatory): per-provider HMAC against an env-sourced secret (never source-controlled) with 401 on missing/invalid secret or signature — the generic webhook is never an unauthenticated task-creation endpoint; ±5 min replay window + delivery-id nonce dedup; persistent external-id dedup; ~1 MB body cap; per-source rate limit; field-length + meta-byte caps; SSRF-untrusted handling of payload URLs; `meta` stored as data, never rendered as raw HTML.
