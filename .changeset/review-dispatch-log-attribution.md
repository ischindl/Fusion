---
"@runfusion/fusion": patch
---

summary: Review-lane log lines now name their project, and repeat less.
category: internal
dev: "`ReviewDispatchSweep` runs per project runtime but logged with no project id, so 68 identical `E4: no enabled reviewer agent exists` lines could not be read as either a dead review lane or 12 of 24 projects having no reviewer (measured on this host: 12 of 24). The ambiguity was filed as a host-wide outage. Every sweep line now carries the project, and the steady-state configuration gap repeats at most every 5 minutes with a folded repeat count."
