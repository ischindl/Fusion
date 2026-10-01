# Core Product Vision

> **North-star artifact** for the **Core Product Vision & Roadmap** mission
> [M-MSL4E01A-0001-Y9QC] and feature **F-MSL4FAOV-0004-HNZU** (F1 —
> Author Core Product Vision Document). This is the reference point that
> downstream roadmap and engineering work traces back to.

Fusion is an **AI-orchestrated task board**. It turns ideas into reviewed,
merged code through a structured delivery workflow — planning, triage,
execution, review, and merge — driven and coordinated by AI agents. Fusion
is the orchestration layer that lets one operator or a team run a software
throughput pipeline whose heavy lifting (specification, execution, review,
merge, scheduling) is performed by AI.

## Target Users

- **Solo operators and small teams** who ship software and want AI to do the
  blocking-and-tackling of task execution, review, and merge without giving up
  final control of the outcome.
- **Technical leads / engineering managers** who need visibility into what the
  AI is doing — current work, state, activity, and quality — and want to assert
  human approval at the decision boundaries that matter.
- **Operators running Fusion as a shared service** across multiple machines or
  for multiple projects, who need reliability, durability, and observability
  comparable to a production system rather than a single-user prototype.
- **Reader-facing surfaces** span a desktop app, a CLI/TUI, and a web dashboard,
  so operators can drive and monitor the board from whichever interface fits the
  moment.

## Core Value Proposition

Fusion turns raw ideas and instructions into **reviewed, merged, durable work**
with AI agents performing the orchestratable core of delivery — drafting
specifications, executing implementation tasks in isolated git worktrees,
reviewing the results, and merging them — while a human stays accountable and
in-control at the decision points that matter.

The value is that a large fraction of the delivery pipeline runs
**autonomously and safely**: work is specified, executed in isolation, reviewed
before merge, and recoverable after failures. The human moves from doing every
mechanically repetitive step to setting direction, approving gated decisions,
and responding to exceptions. Fusion's output is production-quality pull
requests and merged code, not ad-hoc AI side effects, because every result
flows through the same plan → execute → review → merge discipline.

## Primary Outcomes

- **Throughput**: ideas flow to merged, reviewed code with minimal manual
  shepherding; AI executes the pipeline steps that previously consumed
  operator time.
- **Quality**: a built-in review/merge gate catches low-quality or unsafe work
  before it lands, so automated delivery does not lower the bar.
- **Control**: operators approve the human-in-the-loop decision points and can
  pause, steer, or override AI work at any time — no irreversible automation.
- **Durability & trust**: work survives restarts and failures; every step and
  outcome is observable and auditable, so operators can trust what the AI did
  and why.
- **Scale**: Fusion runs as more than a single-user script — it is a shared,
  reliable service that can grow to deploy across multiple nodes.

## Strategic Themes

These five themes are the roadmap investment areas established in milestone M2
of the vision & roadmap mission. Each traces back to the core value proposition:
combine **safety and control** with **autonomy and scale** so a human-in-the-loop
team gets reviewed, merged, durable delivery at increasing volume.

1. **Model-Agnostic Execution** — Decouple Fusion's delivery pipeline from any
   single model or provider. The pipeline must keep producing the same quality,
   review, and merge outcomes regardless of which model backs each AI lane, so
   operators are never locked to one vendor and can choose the best model per
   phase.
   *Traces to the value proposition*: reliable, quality-gated execution is the
   product's core; that guarantee must not depend on one model provider. See
   F-MSL72J04-000J-L3M3.

2. **Multi-Agent Orchestration** — Coordinate many durable, specialized agents
   (triage, executor, reviewer, merger, scheduler) across many tasks and
   projects, with clear ownership, state, and activity surfaced to operators.
   Autonomous throughput at volume comes from many agents working in parallel
   under a single orchestrated board.
   *Traces to the value proposition*: autonomy at scale — a fleet of agents
   executing the delivery pipeline in parallel, with visibility that keeps
   operators confident. See F-MSL65UCH-000G-YDNI.

3. **Human-in-the-Loop Control** — Keep humans accountable and in-control at the
   decision boundaries that matter: approval gates, pauses, promotions, and
   operator oversight. AI should autonomously drive the mechanical middle of the
   pipeline but never make consequential commitments without a human sign-off.
   *Traces to the value proposition*: control — autonomy without abandoning
   accountability, so AI does the work but the human steers and approves. See
   F-MSL72J08-000L-ZGFL.

4. **Reliability, Durability & Observability** — Make Fusion dependable like a
   production system: storage that survives restarts, self-healing that recovers
   from failures, and observability (run-audit, durable logs, diagnostics) that
   explains every step after the fact.
   *Traces to the value proposition*: durability & trust — a pipeline operators
   can rely on and audit, because unrecoverable or opaque AI work is not worth
   running. See F-MSL72J0A-000M-GIJN.

5. **Scaling to Shared Multi-Node Deployment** — Grow Fusion from a single
   machine to a shared, multi-node deployment on common infrastructure (e.g.
   shared PostgreSQL), so it can serve multiple projects and multiple machines
   as one coherent board.
   *Traces to the value proposition*: scale — shared, reliable service growth
   without losing any of the control, quality, or durability guarantees above.
   See F-MSL72J06-000K-QPBV.

## How to Use This Document

- **Roadmap grounding**: any roadmap item or feature should reference the
  strategic theme it advances (the five above), so the roadmap stays a coherent
  expression of one vision rather than a list of disconnected ideas.
- **Priority arbitration**: when engineering priorities compete, prefer work that
  advances these themes and the primary outcomes, and use the themes to explain
  and backstop decisions org-wide.
- **No fabrication**: this document describes the platform as it exists and the
  direction it is committed to. It does not claim unbuilt capabilities. Capability
  additions belong in the roadmap and become visible here as they land.