---
"@runfusion/fusion": patch
---

summary: A blocked card is card-sized and names its task; the notice no longer covers a tall hidden body.
category: fix
dev: `.external-block-notice--card` moved from `position: absolute; inset: 0` to normal flow and the card's hidden siblings are `display: none`, so a blocked card is as tall as its notice (was 432 px on a card whose steps list was expanded). The header and title stay visible (hiding them made the card unidentifiable) and the notice title carries the task id. The reason clamps to 3 lines with the full sentence kept in the DOM and in `title`.
