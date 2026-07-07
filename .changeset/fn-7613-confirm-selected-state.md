---
"@runfusion/fusion": patch
---

summary: Yes/No chat question buttons now show a clear selected state after clicking.
category: fix
dev: Strengthened `.chat-question-response__confirm--selected` CSS specificity (compound selector + dedicated hover/focus-visible rules) so the CTA-token selected fill/border beats the global `.btn`/`.btn:hover` rules; added `aria-pressed` and a regression test asserting the selected class toggles correctly between Yes/No.
