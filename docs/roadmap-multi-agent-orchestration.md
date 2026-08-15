# Roadmap: Multi-Agent Orchestration / Fleet observation

> **M2 / S1 roadmap definition item** for the **Core Product Vision & Roadmap** mission.
> **Lineage:** `M2 / S1 / F-MSL65UCH-000G-YDNI → M-MSL4E01A-0001-Y9QC` (Mission **M-MSL4E01A-0001-Y9QC** → Milestone **M2 — Roadmap Definition** `MS-MSL655GU-000A-GHJG` → Slice **S1 — Multi-Agent Orchestration roadmap** `SL-MSL65CV6-000C-HAI3` → Feature **F-MSL65UCH-000G-YDNI**).

<!--
FNXC:MultiAgentOrchestration 2026-08-15-01:38:
This doc is the M2/S1 roadmap-definition deliverable that converts the M1 vision's "Multi-Agent Orchestration" strategic theme (docs/vision.md, theme 2) and the S1 section of the M2 roadmap (docs/roadmap.md, section 1 — Fleet Observation) into a durable, implementation-ready definition for feature F-MSL65UCH-000G-YDNI. The S1 slice was the only M2 slice never defined: its siblings (S2 model-agnostic, S3 human approval gates, S4 reliability, S5 scaling) all produced standalone roadmap-definition docs, and S1's fleet-observation feature sat stranded in-progress with no owning document task. It states the operator-facing "single pane of glass" scope, the already-landed near-term surface, and the convention for filing future implementation work against the feature lineage. Modeled on the landed S3 roadmap-definition doc (docs/roadmap-human-approval-gates.md) and the S5 doc (docs/roadmap-shared-multi-node-scaling.md), with the Near-term → Mid-term → Later sequencing seeded from docs/roadmap.md section 1.
-->

## Grounding

This item advances strategic theme 2, **Multi-Agent Orchestration**, from the M1 north-star vision (`docs/vision.md`):

> "**Multi-Agent Orchestration** — Coordinate many durable, specialized agents (triage, executor, reviewer, merger, scheduler) across many tasks and projects, with clear ownership, state, and activity surfaced to operators. Autonomous throughput at volume comes from many agents working in parallel under a single orchestrated board."

And the vision's **Durability & trust** value-proposition pillar ("Primary Outcomes") — fleet visibility is the trust prerequisite for autonomous throughput at volume:

> "work survives restarts and failures; every step and outcome is observable and auditable, so operators can trust what the AI did and why."

Seeded from the S1 near-term item of the M2 roadmap (`docs/roadmap.md`):

> "Feature 1 — Fleet Observation — Multi-agent orchestration": "Fusion is a fleet of durable agents coordinating across tasks, agents, missions, git, files, and worktrees — not a single prompt loop. The operator's job is to plan and review while the fleet executes the routine steps in between. That only works if the operator can see and trust what the fleet is doing as a unit, not read logs task-by-task."

Grounded in the accepted feature scope (feature `F-MSL65UCH-000G-YDNI` acceptance criterion):

> "A dashboard surface renders the durable-agent roster with role, state (active/paused/error), current task assignment, and last-heartbeat per agent. It reflects live agent state, supports drill-down to an agent's detail (per `AgentDetailView`), and inspection of the reports-to/direct-reports hierarchy."

## Scope

The **fleet observation roster & activity dashboard** is the operator's "single pane of glass" over the durable-agent fleet, grounded in the Multi-Agent Orchestration theme's requirement that ownership, state, and activity be surfaced to operators. Concretely:

- **Durable-agent roster** — a dashboard surface renders each durable agent with **role, state (active/paused/error), current task assignment, and last-heartbeat per agent**, so the fleet's composition and individual agent health are legible at a glance.
- **Live agent state** — the roster reflects live agent state rather than a static snapshot, so an operator sees the fleet as it is right now (who is active, paused, or in error) and can trust it as the basis for steering.
- **Drill-down to agent detail** — selecting an agent opens its detail per `AgentDetailView`, exposing logs, runs, heartbeats, mail, and configuration for that agent without leaving the fleet surface.
- **Reports-to / direct-reports hierarchy** — the roster supports inspection of the **agents' reports-to / direct-reports org chart**, so operator oversight reflects the management hierarchy, not flattened per-agent rows.

The near-term roster & activity surface **has already been implemented on `main`** (via RUFU-090/RUFU-096): the `FleetView` roster renders role, state, current-task assignment, last heartbeat, and a live activity/liveness signal per agent; `AgentActivityPanel` surfaces the retained agent-activity stream; and `AgentDetailView` provides the row→detail drill-down. These are landed components to be maintained and extended, not aspirational — this roadmap item's near-term scope is delivered.

## Target users

Grounded in the vision's Target Users (`docs/vision.md`):

- **Technical leads / engineering managers** running autonomous delivery who need visibility into what the AI is doing — current work, state, activity, and quality — and a "single pane of glass" into the fleet rather than per-task log reading.
- **Operators running Fusion as a shared service** who need observability comparable to a production system: a roster and live activity signal they can trust to confirm the fleet is executing as a coordinated whole, not a set of opaque agents.

## Key outcomes

- **The operator sees and trusts the fleet as a unit** — coordinated orchestration becomes visible and auditable, replacing per-task log reading with a single fleet surface.
- **Fleet state is observable and drivable** — live roster state (active/paused/error), assignment, and heartbeat let operators spot stalled or errored agents and act, not discover them after the fact.
- **Coordinated orchestration is auditable** — every agent's role, state, activity, and assignment is inspectable, so autonomous throughput at volume stays accountable to the human operator.

## Prioritized implementation sketch

Seeded from the S1 roadmap near/mid/later items (`docs/roadmap.md` section 1 — Fleet Observation) and the landed near-term implementation, sequenced **Near-term → Mid-term → Later**:

- **Near-term — Fleet observation roster & activity dashboard** (already landed on `main` via RUFU-090/RUFU-096): roster table with role, state, current-task assignment, and last-heartbeat per agent; live agent state; drill-down to an agent's detail per `AgentDetailView`; and an agent-activity signal (`FleetView` + `AgentActivityPanel`). Present as delivered and maintained.
- **Mid-term — Cross-task and mission-level fleet coherence:** roster views that group agents by assignment and mission so operator oversight reflects the Mission → Milestone → Slice → Feature hierarchy, not just individual tasks.
- **Later — Fleet-level policy and orchestration tooling:** surfaces for reasoning about the coordinated fleet as a whole (resource use, assignment balance, orchestration heuristics) beyond per-agent monitoring.

## Filing implementation work

Future implementation work for this roadmap item should be filed against the **approved feature lineage** so tasks land against already-approved roadmap items rather than being re-derived (per `docs/missions.md`):

- Feature **F-MSL65UCH-000G-YDNI** under Slice **SL-MSL65CV6-000C-HAI3** (S1 — Multi-Agent Orchestration roadmap), Milestone **M2 — Roadmap Definition**, Mission **M-MSL4E01A-0001-Y9QC**.

Each new task should carry this lineage and reference **this document** as the roadmap definition it advances.

## Related Documents

- [Repository README](../README.md) — product positioning ("a software factory, run by a multi-agent orchestrator")
- [Product Vision](./vision.md) — the M1 north-star this roadmap item is grounded in (Mission M-MSL4E01A-0001-Y9QC, Milestone M1)
- [Core Product Roadmap](./roadmap.md) — the M2 roadmap section 1 (Fleet Observation) that this item expands
- [Human approval gates & operator oversight](./roadmap-human-approval-gates.md) — the landed S3 roadmap-definition doc whose structure this item models
- [Shared multi-node deployment & scaling](./roadmap-shared-multi-node-scaling.md) — the landed S5 roadmap-definition doc whose grounding + contiguous-lineage + Filing-work pattern this item mirrors
- [Missions](./missions.md) — the Mission → Milestone → Slice → Feature hierarchy this document sits within
- [Documentation Index](./README.md)