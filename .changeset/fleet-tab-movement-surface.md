---
"@runfusion/fusion": minor
---

summary: Agents tab answers "is the project moving?" — verdict strip, per-node stall reasons, and a live action log.
category: feature
dev: Org-node stall lines and the overview-bar verdict counts share the pure classifier in `fleetVerdict.ts`; the action-log drawer consumes the existing agent-activity cursor wire and shared SSE store — no new endpoints or event streams.
