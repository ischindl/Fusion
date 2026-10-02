---
"@runfusion/fusion": patch
---

summary: A blocked card now shows a card-sized block notice instead of a tall red film over hidden content.
category: fix
dev: `.external-block-notice--card` moved from `position: absolute; inset: 0` to normal flow and the card's hidden siblings are `display: none`, so a blocked card is as tall as its notice (was 432 px on a card whose steps list was expanded). The reason clamps to 3 lines with the full sentence kept in the DOM and in `title`.
