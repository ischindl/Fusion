---
"@runfusion/fusion": patch
---

summary: Stop cards in review from rebuilding forever when the integration branch keeps moving.
category: fix
dev: |
  Splits the AI-merge identity predicate into its two real causes. A changed source head, a dismissed
  finding, or an orphan writer still wipes the reconciliation episode and the merge retry race together,
  exactly as before. A bare advance of the integration tip now carries the episode instead: findings, the
  spent corrective budget, and earned approval credit survive, and the retry race is left untouched.
  Carried approval credit is decided by `git patch-id --stable` over `tip..candidate`, so a rebuilt
  candidate only inherits an approval when it replays the content the reviewer actually saw — tree
  equality is unusable here because a whole-repo tree never matches across a base move. Consecutive
  tip-driven rebuilds are bounded by a code-owned ceiling (5 inside a rolling 6 h window) that is
  separate from the concurrent-landing bound; at the ceiling the card parks `failed` with the remedy in
  its History line rather than rebuilding again. Each accepted rebuild writes one
  `merge:ai-tip-advance-rebuild` audit row and one History line.
