---
"@runfusion/fusion": patch
---

summary: A card whose own delivery invalidated its plan facts is no longer re-planned for work it already shipped.
category: fix
dev: Plan-premise attribution now proves which commit turned a premise false (`git log -S<literal>` / `--diff-filter=AD` plus the parent tree) instead of asking which commit last touched the file, and attributes the violated premise by its own path. Measured on RUFU-698: the delivery deleted the literals its plan assumed and added the marker its own absence premise forbade, while a later unrelated commit edited the same files, so every violation was blamed on that commit and the card walked the stale-plan ladder toward a terminal park.
