---
"@runfusion/fusion": patch
---

summary: The engine no longer re-walks an agent mailbox backlog it cannot drain, which was burning a CPU core on every host.
category: fix
dev: Durable inbox wake reconciliation (`packages/engine/src/agent-heartbeat.ts`) now remembers its no-action verdict per recipient instead of re-delivering every unread row on each 1 s pass, and the sweep reuses the recipient row it already loaded rather than re-reading it per message. A remembered verdict is dropped by any persisted agent update and by a monitor restart, and a forced user wake is never deferred. Log shape: `[mailbox-wake-reconciliation] outcome=on-heartbeat` now appears once per message per decision episode rather than once per pass, and a new rate-floored `outcome=deferred-backlog deferred=<n>` line reports the outstanding count per recipient at most once a minute. No run-audit row was added: the backlog is already durable in `project.messages`, and a pre-fix row would have been ~28 per second.
