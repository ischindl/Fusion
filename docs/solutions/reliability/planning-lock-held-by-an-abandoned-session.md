---
title: "A planning-lifecycle advisory key held by a session nobody remembers"
date: 2026-11-11
category: reliability
problem_type: reliability
module: "@fusion/core"
component: postgres / planning-lifecycle-advisory-lock
tags:
  - advisory-lock
  - postgres
  - planning-lifecycle
  - retry
  - http-409
  - holder-attribution
  - self-healing
symptoms:
  - "operator presses Retry and gets HTTP 500 with 'Planning lifecycle lock acquisition timed out after 5000ms'"
  - "the same refusal repeats several times in a window while the card sits in a planning lane"
  - "pg_stat_activity shows sessions whose last statement was SELECT pg_advisory_lock(hashtext($1)) and nothing after it"
applies_when:
  - "any planning-lane write refuses with a planning-lifecycle transport error"
  - "a card looks permanently unretryable and no engine lane claims it"
---

## What the report said, and what measurement said instead

The report attributed the 46-second holder to the hold-release sweep because that sweep wrote the longest
log line in the window. It does not hold a planning key: `packages/engine/src/execution/hold-release.ts`
contains no `withPlanningLifecycleLock`, no advisory call, and no task lock. Co-occurrence was not causation,
and the reported `requirement=plan-lifecycle` / `no active lock to release` / `durationMs=` literals exist
nowhere in this repository — they came from a sibling build, so they could not be used as evidence about
this code at all.

Two other theories were also measured rather than trusted, and both failed to reproduce:

- **"Five phases each bounded by 5 s explains the 20.4 s latency."** Replaying the phase sequence against a
  real PostgreSQL with a deliberately stalled endpoint produced 404 ms against a 400 ms budget and 5008 ms
  against 5000 ms. The JS phase timer wins the race, and the un-awaited `client.end({ timeout: 0 })` destroys
  the pool in about 2 ms, so phases do not stack. The multi-phase structure is still a real defect — there
  was no single end-to-end deadline, so a caller could not state what it had waited for — but it is not the
  source of the multiplied latency in that report.
- **"An abandoned acquisition leaves a session holding the key for days."** A directly-connected PostgreSQL
  reclaims these sessions: closing the client, letting the process vanish, and even connecting through a TCP
  proxy that swallows the FIN all left the key re-acquirable within milliseconds, because postgres.js'
  `terminate()` writes an in-band Terminate packet before closing the socket. A session that genuinely
  survives requires something else owning the server-side socket, namely a transaction pooler. So on a
  direct connection, a "zombie" holder is far more often a live-but-forgotten session than a corpse.

The defects that did exist in code, and that this task removed, are narrower and worth stating exactly:
teardown was only *requested* (never awaited or verified), the cleanup unlock was guarded by an `acquired`
flag that a lost grant race leaves false, and once a grant succeeded the callback ran with **no hold bound
at all** — that last one is how a legitimate holder sits on a key for as long as its callback does.

## How to see who actually holds a card's planning key

The advisory key is `hashtext('fusion:planning-lifecycle:<projectId>:<taskId>')`, so `pg_locks` cannot name
the card. Attribution lives in the session's `application_name`, which this repo stamps at acquisition as
`fusion-planning:<lane>[:<taskId>]`:

```sql
SELECT l.pid, a.application_name, a.state,
       now() - a.state_change AS held_for, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database());
```

Note `(SELECT oid FROM pg_database ...)`: `current_database()::oid` is an illegal text-to-oid cast and fails
with `invalid input syntax for type oid`.

Product surfaces for the same question: `TaskStore.diagnosePlanningLifecycleLock(taskId)`,
`TaskStore.listPlanningLifecycleHolderSessions()`, and the card's `planning-lock` HTTP route (GET to read,
POST with `{"confirm": true}` to reclaim). Prefer the store surface: it enforces the same gates the sweep does.
Both routes answer 404 for an id that names no card — a planning key is derived from an id, not validated
against one, so a typo would otherwise be diagnosed, or terminated, against somebody else's key.

## What may end someone else's session, and why that is the only lever

PostgreSQL gives no way to release another session's advisory lock: `pg_advisory_unlock` releases keys held
by the *calling* session and `pg_cancel_backend` cannot unhold a session sitting idle in transaction. The
only reclaim primitive is `pg_terminate_backend`, so every path that reaches it is gated inside the shared
release surface (`releasePlanningLifecycleAdvisoryKey`), not in the caller that thought of the check: explicit
confirmation; the holder must carry the `fusion-planning:` prefix this product stamps, so a session it did not
open is never a candidate at any age; the holder must sit past `PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS`
(15 minutes, measured by PostgreSQL from the session's own state change); no session this process registered
as live; no session in state `active`; and the caller must be able to show the card is idle, through an
`isCardLive` probe that refuses when it is absent or throws. The floor exists because an idle-in-transaction
session is not a dead one — a planning callback holds its session idle for nearly the whole hold, and an
erlier build of this very card treated 15 minutes of idle as proof of death and terminated live work. The
automatic sweep is forbidden from moving a card: reclaiming a key only stops it refusing the next acquirer.

The HTTP route answers each refusal with a status that matches its meaning, and 200 is an allowlist (`released`
and `not-held`, the latter so a repeated Release click stays idempotent). A holder that exists and will not be
touched is a 409 (`holder-active`, `live-session`, `card-live`, `below-age-floor`, `foreign-holder`,
`identity-not-derivable`); a state that could not be read or acted on is a 503 (`holder-query-failed`,
`liveness-unproven`, `transport-unavailable`, `terminate-failed`, `release-unproven`). Reporting 200 for
`identity-not-derivable` or `holder-query-failed` — which an earlier revision did by fall-through — tells a
client that trusts the status code that the lock is free while the card stays locked behind the same holder.

## Answers a refusal now gives

`PlanningLifecycleLockTransportError` carries `reason`, `phase`, `holder`, `waitedMs`, `budgetMs` and, for a
bounded hold, `heldMs`. The message text stays one of the five canonical sentences because
`planning-handoff-recovery.ts` anchors them with `$`: appending holder detail would silently un-classify
every recovery path that matches on the message. The dashboard maps `contention` to 409 and the transport,
teardown and hold-bound reasons to 503, which is what an operator actually needs to decide between clicking
again and reporting an incident.

## Test-side traps found while covering this

- The project-agnostic shared PostgreSQL harness makes the store derive its planning key from its temp
  rootDir, so a foreign holder built with an empty project id contends with nothing and the test passes
  vacuously. Bind a project id on the harness.
- `PlanningLifecycleLockTransportError` fields are flattened onto the error, not nested under `detail`.
- Advisory-lock wake order is PostgreSQL's choice: assert non-overlapping critical windows, never arrival
  order, or the suite asserts a scheduler detail.
- postgres.js queries are lazy thenables; a "stalled" query does not reach the server until something awaits
  it, so a race against a JS timer can be won by an event that never happened.
