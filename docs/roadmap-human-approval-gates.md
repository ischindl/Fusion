# Roadmap: Human approval gates & operator oversight

> **M2 / S3 roadmap definition item** for the **Core Product Vision & Roadmap** mission.
> **Lineage:** `M2 / S3 / F-MSL72J08-000L-ZGFL → M-MSL4E01A-0001-Y9QC` (Mission **M-MSL4E01A-0001-Y9QC** → Milestone **M2 — Roadmap Definition** → Slice **S3 — Human-in-the-Loop Control roadmap** → Feature **F-MSL72J08-000L-ZGFL**).

## Grounding

This item advances strategic theme 3, **Human-in-the-Loop Control**, from the M1 north-star vision (`docs/vision.md`):

> "Keep humans accountable and in-control at the decision boundaries that matter: approval gates, pauses, promotions, and operator oversight. AI should autonomously drive the mechanical middle of the pipeline but never make consequential commitments without a human sign-off."

And the vision's **Control** value-proposition pillar ("Primary Outcomes"):

> "operators approve the human-in-the-loop decision points and can pause, steer, or override AI work at any time — no irreversible automation."

## Scope

Human approval gates and operator oversight touchpoints should exist at the decision boundaries of the **plan → triage → execute → review → merge** pipeline — everywhere an AI commitment becomes consequential and hard to reverse. Concretely:

- **Plan approval** — before planned work is dispatched for execution, the operator approves the task's plan/spec, so AI commits to an approach under human sign-off rather than executing unplanned scope.
- **Review gates** — human confirmation at the review/merge junction: a reviewer verdict (approve/revise/rethink) is surfaced to the operator before work merges, so quality decisions stay accountable.
- **Bump override** — when the operator advances ("bumps") a held or gate-parked card, the action is explicit and recorded, never silently auto-released by the system on the operator's behalf.
- **Agent pause/override controls** — the operator can pause, steer, or halt an autonomous agent's work mid-flight (assignments, heartbeats, error-state retries), not merely inspect it after the fact.
- **Operator dashboards** — an operator-facing surface that makes current state, activity, gate status, and intervention affordances legible at a glance, so oversight is a daily tool rather than an after-the-fact audit.

## Target users

Grounded in the vision's Target Users (`docs/vision.md`):

- **Solo operators and small teams** who want AI to do the blocking-and-tackling without giving up final control of the outcome — they need lightweight, trustworthy approval/pause affordances.
- **Technical leads / engineering managers** who need visibility into what the AI is doing and want to assert human approval at the decision boundaries that matter.
- **Operators running Fusion as a shared service** who need reliability, durability, and observability comparable to a production system, with oversight that does not become a bottleneck.

## Key outcomes

- The **human stays accountable and in-control** at every consequential decision boundary — autonomy without abandoning accountability.
- **No irreversible automation:** every consequential commitment (plan dispatch, merge, PR, destructive action) requires a human sign-off or an explicit recorded override.
- **Operators trust and steer** the pipeline: pause, steer, or override AI work at any time rather than only inspecting outcomes after the fact.

## Prioritized implementation sketch

Seeded from the S3 roadmap near-term item — *"Explicit approval gates at pipeline boundaries (merge, PR, destructive actions) with planner/operator oversight that can observe, steer, or halt autonomous work rather than only inspecting after the fact."*

- **Near-term** — Explicit approval gates at pipeline boundaries: human approval on merge/PR and destructive actions, plus an operator dashboard that surfaces current work, gate status, and intervention affordances so oversight is legible at a glance.
- **Mid-term** — Planner/operator oversight controls: observe/steer/halt on autonomous work, plan-approval before execution dispatch, and bump override recorded as an explicit operator action rather than silent auto-release.
- **Later** — Granular oversight policies and per-workflow, per-role approval/oversight levels that scale human control cleanly as the fleet and board grow — agent pause/override controls and review gates made configurable per workflow.