---
"@runfusion/fusion": patch
---

summary: Workspace cards no longer pass verification or free a checkout when a repository leg was never materialised.
category: fix
dev: New read-only classifier `assessLaneLegs` (packages/engine/src/worktree/lane-legs.ts) probes each `task.workspaceWorktrees` leg (entries, `rev-parse --show-toplevel` ownership, HEAD, local trunk lag) before any measurement at its path is trusted. A refusing leg now yields `verification-infrastructure-failure` with reason `lane-legs-not-materialized` instead of a pass, parks the executor with `LANE_LEGS_NOT_MATERIALIZED: <code> (<repo>)` before the fix-agent loop — cancelling the completed-task watchdog and recording the class token in the card's History, so neither the watchdog nor a stranded-completed promoter can walk the refused card into review — and makes the checkout-emptiness prover answer `unknown` rather than `empty`, so no file-scope lease is released on a borrowed cleanliness proof. Each refusal writes one History line plus one `worktree:lane-leg-refusal` audit row (ids/enums/counts only); the event is deliberately outside the curated delivery-pipeline catalogue. See AGENTS.md and docs/architecture.md -> Lane-leg measurement invariant.
