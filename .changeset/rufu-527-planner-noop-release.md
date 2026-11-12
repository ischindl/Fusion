---
"@runfusion/fusion": patch
---

summary: A planner that finds nothing to change in a complete spec now releases the card instead of failing it.
category: fix
dev: The unchanged-spec release predicate no longer requires a live Plan Review `REVISE` row; it requires the artifact itself to be non-empty, deterministically valid, and neither the engine seed prompt nor a `DUPLICATE:`-only redirect. The Plan Review session-failure budget stays `REVISE`-episode scoped, so a no-projection release consumes no replan turn and writes no `task:plan-replan-session-failure-budget` row. Exhausted planning-retry messages now name which budget was actually spent. See `docs/architecture.md` → Unchanged-spec release predicate and its budget scopes.
