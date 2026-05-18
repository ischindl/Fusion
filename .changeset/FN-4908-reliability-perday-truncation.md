---
"@runfusion/fusion": patch
---

Fix `/api/health/reliability` per-day rows silently truncating older days on busy projects. Per-day in-review entered/bounced counts and duration samples are now aggregated at the SQL layer instead of pulling up to 50,000 activity-log rows in memory, so the Reliability view shows accurate data for every day in the rolling window.
