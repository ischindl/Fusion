---
"@runfusion/fusion": patch
---

summary: Merge autostashes no longer pile up in `git stash list`, and untracked work in them is never dropped.
category: fix
dev: `merger-ai`'s local-checkout sync labelled stashes `fusion-ai-merge-sync-<taskId>`, which no reclamation path in `merger.ts` matched (all key off `fusion-merger-autostash:`) — they were never classified, subsumed-dropped, age-swept, or surfaced as orphans. It now labels via the new exported `buildAutostashLabel(taskId, "ai-local-sync", ts)`; the legacy prefix stays recognized so already-leaked entries are reclaimed rather than stranded. Separately, `--include-untracked` stashes keep untracked files in a third parent (`<sha>^3`) that `git stash show` omits, so an untracked-only stash read as empty and empty meant "subsumed → drop". Liveness now resolves through one authority, `classifyStashContent`, which enumerates both sides, diffs untracked paths against `<sha>^3`, and treats unreadable state as `unknown` (never dropped); it replaces three divergent copies of the check. Age-based sweeping is unchanged deliberate bounded retention.
