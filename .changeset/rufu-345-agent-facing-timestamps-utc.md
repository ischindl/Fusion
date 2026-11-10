---
"@runfusion/fusion": patch
---

summary: Agent-facing timestamps are now UTC-labelled truth, with one authoritative clock in every heartbeat.
category: fix
dev: All agent/machine-facing stamps render through `formatAgentTimestamp` (`@fusion/core`, output `YYYY-MM-DD HH:mm:ss UTC`) instead of host-locale `toLocale*`; both heartbeat prompt builders emit `- execution time (authoritative, UTC): ...` in `## Wake Delta`, declared the clock of record in the heartbeat Critical Rules. Enforced by `agent-prompt-timestamp-ratchet.test.ts` (engine) and `message-timestamp.test.ts` (CLI). No migration; dashboard relative timestamps are unchanged.
