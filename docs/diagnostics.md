# Diagnostics

## Insight run sweeper (`[insight-sweeper]`)

The dashboard insight router runs stale-run recovery sweeps for `project_insight_runs` rows stuck in `pending`/`running` without a live controller owner.

- Recovery writes `terminalCause: "orphaned_active_run_recovered"` and lifecycle failure metadata (`failureClass: "non_retryable"`, `retryable: false`).
- Recovery appends both `warning` and `status_changed` events on `project_insight_run_events` with `metadata.recovery = "orphaned_active_run"`.
- `metadata.recoverySource` indicates where recovery occurred: `startup`, `periodic`, `drive_by`, or `manual`.
