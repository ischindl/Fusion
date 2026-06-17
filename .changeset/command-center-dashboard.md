---
"@runfusion/fusion": minor
---

Add the **Command Center** dashboard — a combined analytics/observability and live Mission-Control view (`?view=command-center`).

- **Telemetry** — a queryable `usage_events` SQLite table populated via a dedicated `emitUsageEvent` capture seam (tool calls, messages, session lifecycle), feeding date-range aggregators for tokens, tool usage + autonomy ratio, activity (sessions/messages/active-nodes/stickiness), productivity (files/commits/PRs/LOC), and ecosystem breadth — all in `packages/core` and reusable by CLI/engine.
- **Cost** — derived from token counts via a hand-maintained `model-pricing` map carrying `pricingAsOf` + a staleness flag; unknown models report unavailable rather than guessing.
- **View** — a new lazy-loaded, ARIA-tabbed Command Center with hand-rolled CSS-bar chart primitives, a date-range picker, per-area panels, a live Mission-Control panel (SSE push + idle-aware polling), and an SDLC funnel.
- **API** — `GET /api/command-center/{tokens,tools,activity,productivity,live}` (agent-usable), each under session auth and project scoping, with `?format=csv` export and an opt-in OpenTelemetry (OTLP) metrics exporter.
