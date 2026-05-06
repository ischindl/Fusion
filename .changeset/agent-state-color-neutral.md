---
"@runfusion/fusion": patch
---

Agent list color now signals run status only: `running` is green, `error` is red, and `idle` / `active` / `paused` all use the neutral gray. Previously `active` shared green with `running` and `paused` was yellow, which made the list visually busy and obscured which agents were actually executing. Applies to the badge, list card border, board card border, and org-chart node card across all agent views.
