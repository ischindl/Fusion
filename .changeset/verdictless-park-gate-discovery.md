---
"@runfusion/fusion": patch
---

summary: Cards parked as "stall deadlock" with no reviewer verdict can now recover automatically.
category: fix
dev: The in-review stall classifier discovers the blocked gate when the park sentence does not name one (unambiguous single verdict-less failed gate only), and an evidence-free `failed` code-review row no longer counts as a recorded verdict in the review dispatch sweep. Parks that are ambiguous, authored (verdict or bypass present), operator-held, or produced by the retry-rejected lane stay operator-owned.
