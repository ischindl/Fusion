---
"@runfusion/fusion": minor
---

summary: Reviewing scales with the number of enabled reviewers you configure, up to four cards per tick.
category: feature
dev: The review dispatch sweep now treats every enabled reviewer as one slot (previously two or more enabled reviewers disabled the lane outright, and dispatch was hard-capped at one card per tick). One session per reviewer is unchanged; `maxDispatchesPerTick` is now only a ceiling above the pool size.
