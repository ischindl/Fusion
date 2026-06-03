# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Merge lifecycle

### Task
The core board entity: a unit of work that moves through columns (triage, todo, in-progress, in-review, done, archived) and is executed by agents. A Task carries its own per-task settings that can override project-level defaults.

### Auto-merge
The named process that automatically lands a completed Task's branch onto its merge target once the Task reaches In-review and passes its merge blockers. Gated twice: a project-level setting enables it globally, and each Task may carry an explicit per-task override.

The per-task override takes precedence in both directions: an explicit per-task enable proceeds even when the global setting is off, and an explicit per-task disable routes the merge to Manual-required even when the global setting is on. Trigger-layer gates (enqueue, Self-healing sweeps) must evaluate additively — global on lets everything through for downstream routing; global off admits only explicit per-task enables — rather than collapsing the override to a single effective value, which would starve Manual-required routing.

### In-review
The Task status column between execution and completion: work is done and the branch awaits merging. An In-review Task either auto-merges, waits for a human merge (PR-based/manual flow), or surfaces a stall diagnostic when it sits unprocessed longer than expected. Tasks not eligible for Auto-merge processing intentionally remain In-review until a human acts — recovery sweeps must not move them.

### Merge queue
The ordered line of In-review Tasks awaiting Auto-merge, with a single merge active at a time. Tasks enter only through trigger gates (engine startup sweep, periodic retry, unpause, and the moved-to-review fast path); a Task filtered out at a gate is invisible to the merger regardless of its own settings.

### Manual-required
The merge-request state for a Task whose merge needs an explicit human go-ahead — typically a Task with auto-merge explicitly disabled under a globally-enabled project. Reaching this state requires the Task to flow through the Merge queue trigger gates; upstream filtering that excludes such Tasks strands them In-review instead of parking them here.

### Self-healing sweep
A recurring background scan that detects and repairs stuck Task states — stalled In-review Tasks, confirmed merges never finalized, ghost or limbo states, exhausted retries. Sweeps respect the same Auto-merge eligibility as the Merge queue: they may inspect any Task but mutate only those eligible for auto-merge processing.

### Shared branch group
A set of Tasks integrating into a common shared branch instead of each merging straight to the project's default branch. Member integration (task branch → shared branch) is a soft pre-integration step exempt from the global auto-merge gate; promotion (shared branch → default branch) is gated separately.

## Flagged ambiguities

- "Merging" a shared-branch-group Task had been used for both member integration and group promotion — these are distinct steps with independent gating and must not be conflated.
