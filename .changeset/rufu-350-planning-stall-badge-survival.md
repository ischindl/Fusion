---
"@runfusion/fusion": patch
---

summary: A planning-lane "why is this not being planned" badge now stays visible while it is true.
category: fix
dev: Age is measured from the stall episode's own reconstructed base instead of `updatedAt`, so the sweep's naming write no longer retracts its own badge. A triage-written episode is now left alone until its 60-minute ownership floor elapses, so the two writers stop deleting and re-stamping the same key; episode survival is the guarantee there, not a rendered badge, because a throttled card carries a non-empty status and the read side deliberately renders no planning badge for one.
