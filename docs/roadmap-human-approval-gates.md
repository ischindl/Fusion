# Roadmap: Human approval gates & operator oversight

> **M2 / S3 roadmap definition item** for the **Core Product Vision & Roadmap** mission.
> **Lineage:** `M2 / S3 / F-MSL72J08-000L-ZGFL → M-MSL4E01A-0001-Y9QC` (Mission **M-MSL4E01A-0001-Y9QC** → Milestone **M2 — Roadmap Definition** → Slice **S3 — Human-in-the-Loop Control roadmap** → Feature **F-MSL72J08-000L-ZGFL**).

<!--
FNXC:HumanInTheLoopControl 2026-08-17-05:35:
This doc is the M2/S3 roadmap-definition deliverable that converts the M1 vision's "Human-in-the-Loop Control" strategic theme (docs/vision.md, theme 3) and the short S3 section of the M2 roadmap (docs/roadmap.md, section 3 — Human-in-the-Loop Control) into a durable, implementation-ready definition for feature F-MSL72J08-000L-ZGFL. It enumerates the concrete operator-approval surfaces (merge/land-to-main, release/publish, destructive mutations, plan approval, review gates, bump/promote override, agent pause/override controls, operator dashboards), describes how the engine surfaces pending approvals and holds/pauses work for a human, and defines graded approval levels from warn-only through require-approval/soft-gate to hard-block — all grounded in the real engine dispositions (allow / require-approval / block in agent-action-gate.ts and agent-permission-policy.ts, the warn-only merge-overlap behavior in merge-policy.ts, and the require-approval pause-for-approval mechanic in agent-prompts.ts FN-7608). Per the vision's "No fabrication" rule these are presented as roadmap direction the platform systematizes on top of mechanisms the engine already exposes, not as shipped approval-gate product features. Modeled on the landed S1 and S5 roadmap-definition docs (docs/roadmap-multi-agent-orchestration.md, docs/roadmap-shared-multi-node-scaling.md), with the Near-term → Mid-term → Later sequencing seeded from docs/roadmap.md section 3.
-->

## Grounding

This item advances strategic theme 3, **Human-in-the-Loop Control**, from the M1 north-star vision (`docs/vision.md`):

> "Keep humans accountable and in-control at the decision boundaries that matter: approval gates, pauses, promotions, and operator oversight. AI should autonomously drive the mechanical middle of the pipeline but never make consequential commitments without a human sign-off."

And the vision's **Control** value-proposition pillar ("Primary Outcomes"):

> "operators approve the human-in-the-loop decision points and can pause, steer, or override AI work at any time — no irreversible automation."

## Scope

Human approval gates and operator oversight touchpoints should exist at the decision boundaries of the **plan → triage → execute → review → merge** pipeline — everywhere an AI commitment becomes consequential and hard to reverse. Concretely:

- **Merge / land to main** — landing completed work onto the shared `main` ref is irreversible and affects everyone; a human approval gate (or a recorded operator override) sits at the merge junction so autonomous work does not silently land on the authoritative branch without sign-off.
- **Release / publish** — publishing a package, version, or artifact is consequential and hard to retract; an operator approval gate stands before any release/publish action so no autonomous lane can cut a release or push an artifact without a human verdict.
- **Destructive mutations** — delete, archive, force-state/in-place rewrite, and irreversible config or store mutations are high-risk; these require explicit operator approval (or a recorded override) rather than autonomous execution.
- **Plan approval** — before planned work is dispatched for execution, the operator approves the task's plan/spec, so AI commits to an approach under human sign-off rather than executing unplanned scope.
- **Review gates** — human confirmation at the review/merge junction: a reviewer verdict (approve/revise/rethink) is surfaced to the operator before work merges, so quality decisions stay accountable.
- **Bump/promote override** — when the operator advances ("bumps"/promotes) a held or gate-parked card, the action is explicit and recorded, never silently auto-released by the system on the operator's behalf.
- **Agent pause/override controls** — the operator can pause, steer, or halt an autonomous agent's work mid-flight (assignments, heartbeats, error-state retries), not merely inspect it after the fact.
- **Operator dashboards** — an operator-facing surface that makes current state, activity, gate status, and intervention affordances legible at a glance, so oversight is a daily tool rather than an after-the-fact audit.

### How the engine surfaces pending approvals and holds work for a human

The platform already exposes a graded action-gate scale that this roadmap systematizes into product-level approval gates: the engine evaluates an agent action against a permission policy and resolves it to a **`allow | require-approval | block`** disposition (`packages/engine/src/agents/agent-action-gate.ts`; `VALID_DISPOSITIONS` in `packages/core/src/agents/agent-permission-policy.ts`, with presets `unrestricted` / `approval-required` / `locked-down`). Where a `require-approval` gate fires, the engine **suspends the in-flight session and parks the task pending approval** rather than letting work continue around the gate (see the FN-7608 note in `packages/core/src/agents/agent-prompts.ts`). Separately, the merge/move subsystem already hard-blocks non-recovery transitions through a "hard-blocker gate" (`packages/core/src/task-store/moves.ts`), and merge overlap resolves to a **`warn-only`** tier that notifies without stopping the merge (`MERGE_STRATEGY_OVERLAP_BEHAVIORS` in `packages/core/src/types/merge/merge-policy.ts`). This roadmap item makes those dispositions and hold mechanics first-class and operator-legible:

- **A legible pending-approval surface** — an operator dashboard / approval queue that shows what is waiting on a human (which gate, which task/agent, which action, and why) rather than work silently pausing in an unobservable corner of the pipeline.
- **A hold/park mechanic** — work does not progress past a gate until a human verdict. An action held at a `require-approval` gate stays paused; a hard-blocked transition stays denied until an explicit, recorded operator override.
- **The "never silently auto-release on the operator's behalf" invariant** — a held/blocked action only advances on an explicit, audit-visible operator action (approve, override, bump/promote, or a config change that re-gates the rule). The system never silently clears a pending approval or waives a block on its own.

### Graded approval levels — warn-only → require-approval → hard-block

As roadmap direction, this item systematizes the platform's existing graded dispositions into a single operator-facing approval scale (presented as direction the roadmap systematizes on top of the real engine mechanisms, not as an already-shipped product-level approval-gate feature):

- **warn-only** — informational tier: the operator is notified that a consequential (or unusual) action is taking place, but the action auto-proceeds without blocking (mirrors the engine's existing `warn-only` merge-overlap behavior — the roadmap generalizes the pattern beyond overlap detection).
- **require-approval / soft-gate** — the action is **suspended and held** until a human approves it or explicitly overrides it; the in-flight session is paused and the work parked pending approval (mirrors the engine's existing `require-approval` disposition and its pause-for-approval mechanic). This is the default for merge/land and release/publish.
- **hard-block** — the action is **denied outright** unless an explicit, recorded operator override or a deliberate config change re-gates the rule; no autonomous path can take it (mirrors the engine's `block` disposition and the merge/move hard-blocker gates). This is the default for destructive mutations.

## Target users

Grounded in the vision's Target Users (`docs/vision.md`):

- **Solo operators and small teams** who want AI to do the blocking-and-tackling without giving up final control of the outcome — they need lightweight, trustworthy approval/pause affordances.
- **Technical leads / engineering managers** who need visibility into what the AI is doing and want to assert human approval at the decision boundaries that matter.
- **Operators running Fusion as a shared service** who need reliability, durability, and observability comparable to a production system, with oversight that does not become a bottleneck.

## Key outcomes

- The **human stays accountable and in-control** at every consequential decision boundary — autonomy without abandoning accountability.
- **No irreversible automation:** every consequential commitment (plan dispatch, merge, release/publish, destructive action) requires a human sign-off or an explicit recorded override.
- **Operators trust and steer** the pipeline: pause, steer, or override AI work at any time rather than only inspecting outcomes after the fact.
- **Hold mechanics are legible and accountable:** pending approvals are surfaced to a human on a queue/dashboard, held work never silently auto-releases, and every approve/override/bump is an explicit, recorded operator action.

## Prioritized implementation sketch

Seeded from the S3 roadmap near-term item — *"Explicit approval gates at pipeline boundaries (merge, PR, destructive actions) with planner/operator oversight that can observe, steer, or halt autonomous work rather than only inspecting after the fact."*

- **Near-term** — Explicit approval gates at pipeline boundaries: human approval on merge/land-to-main, release/publish, and destructive mutations, plus an operator dashboard/approval queue that surfaces current work, gate status, pending approvals, and intervention affordances so oversight is legible at a glance. Graded onto the existing `warn-only` / `require-approval` / `block` dispositions.
- **Mid-term** — Planner/operator oversight controls: observe/steer/halt on autonomous work, plan-approval before execution dispatch, and bump/promote override recorded as an explicit operator action rather than silent auto-release.
- **Later** — Granular oversight policies and per-workflow, per-role approval/oversight levels that scale human control cleanly as the fleet and board grow — agent pause/override controls and review gates made configurable per workflow, with each approval level (warn-only / require-approval / hard-block) assignable per gate.

## Filing implementation work

Future implementation work for this roadmap item should be filed against the **approved feature lineage** so tasks land against already-approved roadmap items rather than being re-derived (per `docs/missions.md`):

- Feature **F-MSL72J08-000L-ZGFL** under Slice **SL-MSL65MWM-000F-759C** (S3 — Human-in-the-Loop Control roadmap), Milestone **M2 — Roadmap Definition**, Mission **M-MSL4E01A-0001-Y9QC**.

Each new task should carry this lineage and reference **this document** as the roadmap definition it advances.

## Implementation Status (RUFU-108)

<!--
FNXC:HumanInTheLoopControl 2026-08-17-08:11:
Task RUFU-108 is the dedicated implementation owner of feature F-MSL72J08-000L-ZGFL (Roadmap: Human approval gates & operator oversight, M2/S3). It exists because the vision-and-roadmap mission reconcile kept re-deriving this feature back to `in-progress`: the roadmap content lives on main (authored under the shared RUFU-101/RUFU-107 reconcile/authoring work), but no single board task deterministically carried this feature's specific lineage, so the slice-milestone could not close. This section records that deterministic ownership, maps both of the feature's acceptance criteria to the doc sections that satisfy them, and closes the feature to `done` so slice S3 and milestone M2 can complete. The deliverable stays grounded in the M1 north-star (docs/vision.md, theme 3 "Human-in-the-Loop Control") and never moves the primary checkout off `main` or pushes to any remote.
-->

**Task:** RUFU-108 is the **dedicated implementation-owner task** for this roadmap item. It deterministically carries the feature's **`M2 / S3 / F-MSL72J08-000L-ZGFL → RUFU-108`** lineage, resolving the earlier strand where the roadmap content existed on `main` (under the shared RUFU-101 reconcile / RUFU-107 authoring work that does not carry this feature's specific lineage) but no single board task owned the feature — which is why the mission reconcile kept re-deriving F-MSL72J08-000L-ZGFL back to `in-progress` and slice **S3 — Human-in-the-Loop Control roadmap** / milestone **M2 — Roadmap Definition** could not close.

This roadmap-definition deliverable is grounded in the M1 north-star vision ([`docs/vision.md`](./vision.md)), specifically **strategic theme 3 — Human-in-the-Loop Control** ("Keep humans accountable and in-control at the decision boundaries that matter: approval gates, pauses, promotions, and operator oversight…"), which this document expands into a durable, implementation-ready definition for the feature.

**Acceptance criteria traceability:**

- **AC 1 — "Roadmap item is defined and grounded in the M1 vision's human-in-the-loop control strategic theme."** Satisfied by the [Grounding](#grounding) section above (quotes theme 3 of `docs/vision.md` and advances it across the Scope, Targeted "Target users", "Key outcomes", and "Prioritized implementation sketch" sections).
- **AC 2 — "Roadmap feature carries the approved M2/S3 lineage."** Satisfied by this document's lineage header (`M2 / S3 / F-MSL72J08-000L-ZGFL → M-MSL4E01A-0001-Y9QC`) together with this **Implementation Status** section, which records RUFU-108's `M2 / S3 / F-MSL72J08-000L-ZGFL → RUFU-108` ownership.

**Acceptance closure:** Both of F-MSL72J08-000L-ZGFL's acceptance-criteria bullets are met by the committed artifact on the `fusion/rufu-108` main-based branch. With RUFU-108 deterministically owning the feature's lineage, the feature is closed to `done` (via `fn_feature_set_status`) and the mission reconcile closes slice **SL-MSL65MWM-000F-759C** (S3) and milestone **MS-MSL655GU-000A-GHJG** (M2).

## Related Documents

- [Repository README](../README.md) — product positioning ("a software factory, run by a multi-agent orchestrator")
- [Product Vision](./vision.md) — the M1 north-star this roadmap item is grounded in (Mission M-MSL4E01A-0001-Y9QC, Milestone M1), theme 3 "Human-in-the-Loop Control"
- [Core Product Roadmap](./roadmap.md) — the M2 roadmap section 3 (Human-in-the-Loop Control) that this item expands
- [Multi-Agent Orchestration / Fleet observation](./roadmap-multi-agent-orchestration.md) — the landed S1 roadmap-definition doc
- [Shared multi-node deployment & scaling](./roadmap-shared-multi-node-scaling.md) — the landed S5 roadmap-definition doc whose grounding + contiguous-lineage + Filing-work pattern this item mirrors
- [Missions](./missions.md) — the Mission → Milestone → Slice → Feature hierarchy this document sits within
- [Documentation Index](./README.md)