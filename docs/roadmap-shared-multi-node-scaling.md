# Roadmap: Shared multi-node deployment & scaling

> **M2 / S5 roadmap definition item** for the **Core Product Vision & Roadmap** mission.
> **Lineage:** `M2 / S5 / F-MSL72J06-000K-QPBV → M-MSL4E01A-0001-Y9QC` (Mission **M-MSL4E01A-0001-Y9QC** → Milestone **M2 — Roadmap Definition** `MS-MSL655GU-000A-GHJG` → Slice **S5 — Scaling to Shared Multi-Node Deployment** `SL-MSL65MWM-000E-M8P5` → Feature **F-MSL72J06-000K-QPBV**).

<!--
FNXC:RoadmapSharedMultiNode 2026-08-14-19:35:
This doc is the M2/S5 roadmap-definition deliverable that converts the M1 vision's "Scaling to Shared Multi-Node Deployment" strategic theme (docs/vision.md, theme 5) and the short S5 section of the M2 roadmap (docs/roadmap.md, section 5) into a durable, implementation-ready definition for feature F-MSL72J06-000K-QPBV. It states the scaling vision and problem statement, the target deployment topology from single machine to shared multi-node, the milestone/gate set a multi-node deployment must satisfy, and the convention for filing future implementation work against the feature lineage. Modeled on the landed S3 roadmap-definition doc (docs/roadmap-human-approval-gates.md) and the S2/S4 sections of docs/roadmap.md for the Near-term → Mid-term → Later sequencing.
-->

## Grounding

This item advances strategic theme 5, **Scaling to Shared Multi-Node Deployment**, from the M1 north-star vision (`docs/vision.md`):

> "Grow Fusion from a single machine to a shared, multi-node deployment on common infrastructure (e.g. shared PostgreSQL), so it can serve multiple projects and multiple machines as one coherent board."

And the vision's **Scale** value-proposition pillar ("Primary Outcomes"):

> "Fusion runs as more than a single-user script — it is a shared, reliable service that can grow to deploy across multiple nodes."

Grounded in the vision's Target Users (`docs/vision.md`):

> "Operators running Fusion as a shared service across multiple machines or for multiple projects, who need reliability, durability, and observability comparable to a production system rather than a single-user prototype."

And seeded from the S5 near-term item of the M2 roadmap (`docs/roadmap.md`):

> "**Near-term — Shared, connected operation.** One board, controlled from anywhere — remote access and shared state so an operator's laptop, server, and cloud VM drive the same board without duplicated setup. **Lineage:** Slice **S5**, feature **F-MSL72J06-000K-QPBV**."

## Scaling vision & problem statement

**Scaling vision.** Fusion is not a single-workstation tool. Its scaling vision is **one board, controlled from anywhere**: multiple operators driving the same coherent board across a laptop, a Linux server, a cloud VM, and other surfaces, with the fleet, task/mission state, and store all shared and consistent across every deployed node. A shared multi-node deployment lets Fusion serve multiple projects and multiple machines as a single coordinated system that retains the quality, control, and durability guarantees defined in the vision — not a set of loosely-coupled per-machine instances.

**Problem statement.** Nearly all of Fusion's current correctness and coordination assumptions are single-machine. Today a single project runtime owns its task store and agents locally; correctness (task/mission state, ownership claims, lease locking) is reasoned about under the assumption that one process instance is authoritative. A shared multi-node deployment breaks those assumptions: multiple nodes now read and mutate the same shared task/mission state and coordinate the same agents, so the board, fleet, and store must stay coherent across nodes without two nodes claiming or executing the same work, without operators losing visibility into which node owns what, and without one node's failure stranding work that another node could recover. Delivering this means the deployment topology and its milestones below are made concrete and supported rather than incidental.

## Target deployment topology

Grounded in the vision's strategic theme ("from a single machine to a shared, multi-node deployment") and the S5 roadmap item's "single-workstation → multi-node" framing, the supported deployment progression is:

1. **Single machine (laptop/workstation).** One operator runs Fusion on one device; the store, fleet, and board are all local to that machine. This is today's baseline.
2. **Connected multi-device operation.** Remote access and shared state let an operator's laptop, server, and cloud VM drive the same board without duplicated setup — one board controlled from anywhere, still primarily a single active runtime behind the scenes.
3. **Shared multi-node deployment.** Multiple nodes join one shared board and store (e.g. shared PostgreSQL), with coordinated membership so each node claims and executes distinct work against shared task/mission state.
4. **Coordinated multi-node robustness.** The shared deployment is resilient — nodes can join, leave, or fail without breaking the shared board, with coherent leases/claims, membership, and recovery.

## Milestones & gates

The milestone set below defines the multi-node deployment gates a shared deployment must satisfy. Gated milestones are sequenced **Near-term → Mid-term → Later** following the S2/S4 roadmap sections of `docs/roadmap.md`. For operational detail and known gaps, reference the supporting design/findings docs cited inline and in **Related Documents** — this doc defines the roadmap, not the implementation.

### Near-term

- **Shared task/mission state.** Tasks and missions live in one shared store that every node reads and writes coherently (structured metadata unified in shared PostgreSQL per `docs/shared-mesh-protocol.md`, with large per-task blobs remaining on project filesystem). Gate: a task created or updated on one node is visible and consistent to every other node without manual sync; the board reflects one shared state.
- **Node coordination (membership, coordination/leases).** Nodes form a single membership set and coordinate ownership so only one node executes any given task/agent. _Supporting context:_ `docs/design/fn-4814-multi-node-runtime-readiness.md` (distributed claim-ownership boundary), `docs/design/fn-4819-distributed-multi-node-coordination-gap.md` (distributed checkout/lease semantics on the shared store). Gate: no two nodes execute the same task concurrently; membership is observable and stale nodes are reconciled.

### Mid-term

- **Cross-node agent routing.** Task/agent assignment is routed across nodes with deterministic ownership and cross-node wake signaling so an assigned agent on another node is woken and picks up work promptly. _Supporting context:_ `docs/design/fn-4824-cross-node-assignment-wake-contract.md` (push, fallback, and missed-wake recovery for assignment-driven wakes), `docs/findings/fn-4820-multi-node-coordination-validation.md` (validation of ownership, wake propagation, and conflict handling against the shared-store model). Gate: an assignment written on one node reliably and promptly reaches and wakes the owning agent on the assigned node, with missed-wake recovery.
- **Storage/isolation semantics.** Shared-store consistency is preserved across the existing project/isolation boundaries — the shared store respects per-project isolation while all nodes share the coherent top-level board. Gate: single-project and multi-project/isolation transitions keep their semantics under shared storage, and isolation boundaries do not leak state across projects or nodes.

### Later

- **Failure containment.** Nodes can join, leave, or fail without breaking the shared board — leases/claims are released or recovered, membership converges, and work stranded by a failed node is recoverable by another node rather than lost. Gate: node fail / leave / recovery is contained (no two-node split of the board, no orphaned stranded work) and converges automatically.

## Filing implementation work

Future implementation work for this roadmap item should be filed against the **approved feature lineage** so tasks land against already-approved roadmap items rather than being re-derived (per `docs/missions.md`):

- Feature **F-MSL72J06-000K-QPBV** under Slice **SL-MSL65MWM-000E-M8P5** (S5 — Scaling to Shared Multi-Node Deployment), Milestone **M2 — Roadmap Definition**, Mission **M-MSL4E01A-0001-Y9QC**.

Each new task should carry this lineage and reference **this document** as the roadmap definition it advances. Implementation tasks may cite the supporting design/findings docs (`docs/design/fn-4814-multi-node-runtime-readiness.md`, `docs/design/fn-4819-distributed-multi-node-coordination-gap.md`, `docs/design/fn-4824-cross-node-assignment-wake-contract.md`, `docs/findings/fn-4820-multi-node-coordination-validation.md`, `docs/shared-mesh-protocol.md`) for operational detail.

## Related Documents

- [Repository README](../README.md) — product positioning ("a software factory, run by a multi-agent orchestrator")
- [Product Vision](./vision.md) — the M1 north-star this roadmap item is grounded in (Mission M-MSL4E01A-0001-Y9QC, Milestone M1)
- [Core Product Roadmap](./roadmap.md) — the M2 roadmap section 5 this item expands, including the S2/S4 sections this doc models its near/mid/later sequencing on
- [Human approval gates & operator oversight](./roadmap-human-approval-gates.md) — the landed S3 roadmap-definition doc this item is modeled on
- [Missions](./missions.md) — the Mission → Milestone → Slice → Feature hierarchy this document sits within
- [Shared Cluster Protocol](./shared-mesh-protocol.md) — the shared PostgreSQL multi-node contract (claims/leases, membership, auth)
- [Documentation Index](./README.md)