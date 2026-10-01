# Fusion Core Product Roadmap

**From rough idea to production code — automatically. A software factory, run by a multi-agent orchestrator.**

> **Status / purpose.** This document is the **Core Product Roadmap** for Fusion's Core Product Vision & Roadmap mission (Mission **M-MSL4E01A-0001-Y9QC**, Milestone **M2 — Roadmap Definition**). It is grounded in the M1 north-star vision document ([`vision.md`](./vision.md)) and translates its strategic themes into prioritized, sequenced investment. It is intentionally concise and durable: it states *where Fusion is investing and in what priority*, not the implementation detail of any single feature. Future implementation work is filed against the roadmap features and feature lineage named below.

## How to read this roadmap

- Each section below is **grounded in one of the five strategic themes** from `vision.md` ("Strategic Themes"), quoted at the top of the section.
- Investment within each theme is sequenced **Near-term → Mid-term → Later**, ordered by dependency and expected impact.
- The **[Cross-theme priority summary](#cross-theme-priority-summary)** at the end ranks the five themes (and their flagship roadmap items) so the overall investment priority is legible at a glance.
- Roadmap items carry the **Mission → Milestone → Slice → Feature** lineage (per `missions.md`), so ongoing implementation can be filed against approved roadmap items rather than re-derived.

---

## 1. Fleet Observation — Multi-agent orchestration

> Strategic theme: "**Multi-agent orchestration** across tasks, agents, missions, git, files, and worktrees — a coordinated fleet, not a single prompt loop."

Fusion is a fleet of durable agents coordinating across tasks, agents, missions, git, files, and worktrees — not a single prompt loop. The operator's job is to plan and review while the fleet executes the routine steps in between. That only works if the operator can see and trust what the fleet is doing as a unit, not read logs task-by-task.

- **Near-term — Fleet observation roster & activity dashboard.** A dashboard surface rendering the durable-agent roster with role, state (active/paused/error), current task assignment, last-heartbeat per agent, live state, drill-down to agent detail, and activity signal. This is the operator's "single pane of glass" for the fleet and the driving feature that makes coordinated orchestration visible. **Lineage:** Slice **S1**, feature **F-MSL65UCH-000G-YDNI**.
- **Mid-term — Cross-task and mission-level fleet coherence.** Roster views that group agents by assignment and mission so operator oversight reflects the Mission → Milestone → Slice → Feature hierarchy, not just individual tasks.
- **Later — Fleet-level policy and orchestration tooling.** Surfaces for reasoning about the coordinated fleet as a whole (resource use, assignment balance, orchestration heuristics) beyond per-agent monitoring.

## 2. Model-Agnostic Execution

> Strategic theme: "**Model-agnostic execution** — any model, local or cloud, with configurable workflow model/fallback lanes."

Fusion must run on whatever model the operator chooses — local or cloud — without being tied to any single provider. Model choice is an execution policy, not an architectural commitment.

- **Near-term — Provider and gateway isolation.** Decouple the execution engine from model providers and gateways so the pipeline runs identically against a local point-of-presence or a cloud model without per-node rewiring. **Lineage:** Slice **S2**, feature **F-MSL72J04-000J-L3M3**.
- **Mid-term — Configurable workflow model/fallback lanes.** Per-workflow model lanes and fallback selection, so operators can pin work to a preferred model and route fallbacks deterministically when a lane is unavailable.
- **Later — Mixed model orchestration.** Workflows and roles that can mix models per phase (planning on one model, execution on another), chosen and fall back independently per workflow role.

## 3. Human-in-the-Loop Control

> Strategic theme: "**Human-in-the-loop control** — approval gates, planner oversight, and authorable custom workflows keep the operator in command."

Autonomy is bounded by the operator's authority. Wherever a human gate is wanted, it stays in command of the pipeline — approving, steering, or authoring the workflows the fleet runs under.

- **Near-term — Human approval gates and operator oversight.** Explicit approval gates at pipeline boundaries (merge, PR, destructive actions) with planner/operator oversight that can observe, steer, or halt autonomous work rather than only inspecting after the fact. **Lineage:** Slice **S3**, feature **F-MSL72J08-000L-ZGFL**.
- **Mid-term — Authorable custom workflows.** Operators author the workflows the fleet executes — defining their own columns, gates, phases, and model lanes — so human-in-the-loop control extends to shaping the delivery pipeline itself.
- **Later — Granular oversight policies.** Per-workflow, per-role oversight levels and intervention tooling that scale human control cleanly as the fleet and board grow.

## 4. Reliability, Durability & Observability

> Strategic theme: "**Reliability, durability, and observability** of the delivery pipeline — tasks, agents, and their delivery are recoverable and inspectable."

The delivery pipeline must be trustworthy enough to run autonomously: tasks, agents, and their delivery are recoverable when something fails and inspectable when the operator asks why something happened.

- **Near-term — Recoverable and inspectable delivery.** Recoverable tasks and durable agents (worktrees, heartbeats, self-healing), so work survives agent or engine restarts and can be picked back up rather than lost. **Lineage:** Slice **S4**, feature **F-MSL72J0A-000M-GIJN**.
- **Mid-term — Pipeline observability and run-audit.** Durable, queryable run-audit and agent-activity signals so the pipeline's behavior (who did what, when, and why) is inspectable after the fact.
- **Later — Proactive reliability signals.** Trend and health signals over the delivery pipeline that surface degradation before it strands work, feeding operator and self-healing decisions.

## 5. Scaling to Shared Multi-Node Deployment

> Strategic theme: "**Scaling** from a single machine to shared multi-node deployments."

Fusion starts on a single machine and scales to shared, multi-node deployments — one board controlled from anywhere by multiple operators across machines, not a single-workstation tool.

- **Near-term — Shared, connected operation.** One board, controlled from anywhere — remote access and shared state so an operator's laptop, server, and cloud VM drive the same board without duplicated setup. **Lineage:** Slice **S5**, feature **F-MSL72J06-000K-QPBV**.
- **Mid-term — Multi-node deployment model.** A clear, supported path from single-workstation operation to shared multi-node deployments that keep the fleet, board, and store coherent across nodes.
- **Later — Multi-node robustness.** Coordinated multi-node operation with coherent leases/claims, membership, and recovery so nodes can join, leave, or fail without breaking the shared board.

---

## Cross-theme priority summary

Explicit prioritization across themes, ordered by dependency and impact:

| Rank | Strategic theme (from `vision.md`) | Flagship roadmap item | Why this priority |
|---|---|---|---|
| 1 | **Model-agnostic execution** | Configurable model/fallback lanes (S2) | Foundation for every other theme — the pipeline must run on any model, local or cloud, before fleet, control, reliability, or scaling assumptions hold. |
| 2 | **Multi-agent orchestration** | Fleet observation roster & activity dashboard (S1) | The operator's "single pane of glass." Visibility into the fleet is the highest-impact near-term outcome for trusting autonomous delivery. |
| 3 | **Human-in-the-loop control** | Approval gates & operator oversight (S3) | Autonomy must be bounded by operator authority; strong control attracts the reliable-autonomous usage that the other themes depend on. |
| 4 | **Reliability, durability & observability** | Recoverable/inspectable delivery (S4) | Foundation for running autonomously at all — recoverable and inspectable delivery is a prerequisite for scaling and fleet trust. |
| 5 | **Scaling to shared multi-node deployment** | Shared, connected operation (S5) | Builds on the first four being stable; multi-node scaling is the longest-horizon theme and the natural later investment. |

Sequencing note: themes 1 and 4 are enabling foundations and are prioritized for near-term work; themes 2 and 3 deliver near-term operator value on top of that foundation; theme 5 is the deliberate long-horizon investment that consolidates the rest.

## Related Documents

- [Repository README](../README.md) — product positioning ("a software factory, run by a multi-agent orchestrator")
- [Product Vision](./vision.md) — the M1 north-star this roadmap is grounded in (Mission M-MSL4E01A-0001-Y9QC, Milestone M1)
- [Missions](./missions.md) — the Mission → Milestone → Slice → Feature hierarchy this document sits within
- [Architecture](./architecture.md) — system architecture, package layout, and engine execution flow
- [Documentation Index](./README.md)