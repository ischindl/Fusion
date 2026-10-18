---
"@runfusion/fusion": patch
---

summary: Cards stuck in To do after a finished task released its overlap wait now clear and resume on their own.
category: fix
dev: The overlap reconciler decided "predecessor finished" from `resolveTaskLifecycleColumns(...)?.complete`, so a board whose lifecycle vocabulary could not be read (v1 graph, trait-less synthesized columns, unreadable workflow selection) answered "no complete lane" and never released the wait. `reconcileTaskOverlapWaits` now reads the complete lanes through the new `resolveTaskCompleteColumns`, which answers **every** lane a board marks complete (membership, via `columnsWithFlag`) and keeps the legacy `done` floor for exactly that degraded state — the same floor `isCompleteColumnRole` uses — so the release decision and the scheduler's file-scope lease classification can no longer disagree. First-match-per-role was not enough either: on a board declaring two complete lanes, a predecessor resting in the second one was still never released. Boards that deliberately declare lifecycle traits and name no complete lane still hold the wait.
