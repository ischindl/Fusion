---
"@runfusion/fusion": minor
---

summary: Add `fn task lock-census`, which names why each card's spec can never be plan-approved.
category: feature
dev: The store's plan-lock funnel now carries a classified verdict (missing section, expected heading, spec path, recovery owner) that triage history and the Plan Review step result inherit; `fn task lock-census --json` exits 1 when a card needs a re-spec, and intentional `DUPLICATE:` redirects exit 0.
