---
"@gsxdsm/fusion": patch
---

Enforce deterministic merge verification so tests stay green

When `testCommand` or `buildCommand` are configured in project settings, these commands now run as deterministic engine-level gates before merge completion. Previously, verification was only mediated through AI agent prompts, which could be unreliable.

**Changes:**
- Added deterministic verification runner that executes `testCommand` first, then `buildCommand`
- Verification runs on all merge paths (AI resolve, auto-resolve, and `-X theirs`)
- If verification fails, the merge is aborted and the task stays out of `done`
- Detailed logging of verification results to the task log

**Behavior:**
- Tasks with failing tests/builds will no longer reach `done`
- This ensures repository health is maintained automatically
- Agent prompt instructions are still included as a secondary check
