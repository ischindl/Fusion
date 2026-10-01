---
"@runfusion/fusion": patch
---

summary: Board no longer stalls while a card verifies: verification runs are capped to ~half the machine CPU by default.
category: performance
dev: New dual-scope keys `verificationCpuQuotaPercent`, `verificationCpuIoWeight`, `verificationMemoryMaxMb` (project → global → built-in default computed at spawn from host core count ≈half the machine, floor 100%; `0` disables a dimension). Hosts missing systemd-run/nice/ionice primitives degrade to today's bare spawn with one warning — a bound never fails a verification. New run-audit events `verification:resource-bound-engaged` and `verification:resource-bound-sustained` (bounded emitter; ids/buckets only).
