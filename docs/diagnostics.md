# Diagnostics

## Insight run sweeper (`[insight-sweeper]`)

The dashboard insight router runs stale-run recovery sweeps for `project_insight_runs` rows stuck in `pending`/`running` without a live controller owner.

- Recovery writes `terminalCause: "orphaned_active_run_recovered"` and lifecycle failure metadata (`failureClass: "non_retryable"`, `retryable: false`).
- Recovery appends both `warning` and `status_changed` events on `project_insight_run_events` with `metadata.recovery = "orphaned_active_run"`.
- `metadata.recoverySource` indicates where recovery occurred: `startup`, `periodic`, `drive_by`, or `manual`.

## Dependency-blocked Todo backlog health (`[dependency-blocked-todo]`)

Self-healing now runs `surface-dependency-blocked-todos` during both startup recovery and periodic maintenance.

- Normal path emits a workflow insight titled `Backlog health: dependency-blocked todos YYYY-MM-DD`.
- Fallback path (insight store unavailable) writes a per-task log entry prefixed with `[dependency-blocked-todo]` against the top blocker task.
- Reporter summary warnings include group count, total blocked Todo count, and top blocker IDs.

Operator interpretation:
- `ageBucket: "fresh"` → expected dependency queueing.
- `ageBucket: "aging"` → review blocker progress.
- `ageBucket: "stale"` → emerging stall; escalate/unblock blocker.

## Process supervisor (`[process-supervisor]`)

The process supervisor logs when it registers a supervised child, starts teardown, expires the grace window, escalates to `SIGKILL`, or observes a natural child exit.

- `spawned pid=<pid> pgid=<pgid|n/a> command=<cmd>` — child registered for parent-death supervision.
- `terminating pid=<pid> pgid=<pgid|n/a> reason=<reason>` — teardown cascade started.
- `grace expired for pid=<pid>; escalating to SIGKILL` — child ignored the grace window.
- `sent SIGKILL to pid=<pid> pgid=<pgid|n/a>` — hard-kill escalation sent.
- `maxLifetime exceeded for pid=<pid> after <ms>ms` — lifetime watchdog fired.
- `child pid=<pid> exited naturally code=<n|null> signal=<n|null>` — child deregistered after exit.

## Self-healing surfacing passes (`[self-healing]`)

- `surface-in-review-stalls`
  - Log prefix: `In-review stall surfaced [`
  - Purpose: reason-driven in-review stall detector (`merge-blocker`, retry exhaustion, no-worktree, transient merge-status orphaning).
- `surface-in-review-stalled`
  - Log prefix: `In-review stalled surfaced [in-review-stalled]: quiet ...`
  - Purpose: time-quiet detector for unpaused in-review tasks beyond `inReviewStalledThresholdMs`.
  - Non-overlap: skipped when reason-driven `In-review stall surfaced [` is fresh, and skipped for paused tasks (owned by stale-paused-review).
- `surface-stale-paused-reviews`
  - Log prefix: `Stale paused review surfaced [stale-paused-review]: paused ...`
  - Purpose: paused in-review backlog-health detector gated by `stalePausedReviewThresholdMs`.

## No-progress churn stuck-task escalation (`[executor]`, `[stuck-detector]`, `[self-healing]`)

Time-based stuck/stalled/stale surfaces now floor activity timestamps using `settings.engineActiveSinceMs` plus `settings.engineActivationGraceMs` (default `300000`). The runtime stamps `engineActiveSinceMs` on startup and each unpause transition so engine pause/downtime does not count as quiet time.

- Trigger shape: one loop classification/compact-and-resume has already fired for the current `execute()` lifecycle, then ignored `fn_task_update` rebuffs accumulate to `ignoredStepUpdateCount >= 25` without intervening progress.
- Executor diagnostic: `[executor] <taskId>: no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — escalating to STUCK_NO_PROGRESS_CHURN`.
- Self-healing diagnostic: `<taskId> no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — marking failed`.
- Audit event: `task:stuck-no-progress-churn-terminalized` with `{ taskId, ignoredStepUpdateCount, stuckKillStreak, lastReason: "no-progress-churn" }`.
- Outcome: task is marked `status: "failed"`, moved to `in-review`, and not requeued; operators should decompose/rescope the task instead of waiting for more automatic stuck-kill retries.

## Stale self-owned active-session cleanup diagnostics (`[executor]`)

FN-5346 adds a same-task stale-binding reconcile marker before worktree removal:

- `[FN-5346] <taskId>: dropped stale self-owned activeSessionRegistry entry before removeWorktree at <worktreePath>`
- Follow-up task log entry: `Cleared stale self-owned active-session entry before remove`

## Reports health stale-classifier diagnostics (`[reports-health]`)

Direct-report stale decisions in `HeartbeatMonitor.buildReportsHealthSection()` now emit a structured log when an agent is marked `**stale**`.

- Log shape: `[reports-health] stale report <agentId> intervalSource=<source> staleThresholdMs=<n> heartbeatAgeMs=<n>`
- `intervalSource` values:
  - `runtimeConfig` — interval came from cached per-agent runtime config
  - `persisted-agent` — cache was missing/sparse; interval came from persisted `getAgent()` row
  - `monitor-default` — no per-agent interval available; monitor default interval used
- `staleThresholdMs` is the computed stale threshold (`max(1.5 × interval, 5m floor)`)
- `heartbeatAgeMs` is the report's current heartbeat age at classification time
- Healthy reports do not emit this diagnostic; only stale decisions do

## Resume instrumentation (FN-5389, Phase 1)

Dashboard Phase 1 resume instrumentation adds observation-only client/server traces for refetch/reconnect attribution. It does not change visibility/pageshow/SSE behavior; FN-5392 consumes this data for fixes.

- Client event shape (`ResumeEvent`): `{ ts, view, trigger, projectId?, gapMs?, replayAttempted, replayFromEventId?, lastEventId?, sseChannel?, reason?, detail? }`.
- Trigger taxonomy: `visibility`, `pageshow`, `sse-error`, `sse-reconnect`, `sse-open`, `remount`, `route-active`, `route-inactive`, `project-context-change`.
- Sources:
  - `sse-bus` (`pageshow`, visible `visibilitychange`, `openChannel`, `forceReconnect`, EventSource `error`)
  - Hooks: `useTasks` (`visibility`, `sse-reconnect`), `useChatRooms` (`sse-reconnect`), `useChat` (`sse-open`, `project-context-change`)
  - Components: `Board` and `ChatView` mount/unmount route markers (`remount` / `route-active` / `route-inactive`)
- Access paths:
  - Client ring (500): `window.__fusionDebug.resumeInstrumentation.get()` / `.clear()`
  - Server ring (5000, in-memory): `GET /api/diagnostics/resume-events?limit=&since=&view=` returns `{ events, droppedSinceLastRead }`
- Client batching: POST `/api/diagnostics/resume-events` in idle batches (`<=25` per POST).
- Disable knob: `window.__fusionDebug.resumeInstrumentation.setEnabled(false)`.

FN-5415 extends this coverage across remaining board/data visibility hooks: `useNodes`, `useMeshState`, `useProjects`, and `useManagedDockerNodes`. Each now emits `trigger: "visibility"` with `reason: "debounced-refresh"` when refresh is taken and `reason: "debounce-skipped"` (including `detail.timeSinceLastRefreshMs`) when suppressed by debounce. This completes board/data-hook resume-correlation coverage needed for FN-5392 Phase 2 remediation analysis.
