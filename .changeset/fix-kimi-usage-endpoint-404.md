---
"@gsxdsm/fusion": patch
---

Fix Kimi usage endpoint returning 404 when Moonshot API endpoint path format changed. Add fallback from `/v1/coding-plan/usage` (hyphen) to `/v1/coding_plan/usage` (underscore) when the first endpoint returns `404 url.not_found`. Auth errors (401/403) still short-circuit immediately without fallback.
