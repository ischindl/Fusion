/**
 * Emission gate for the loggers' severity markers (`packages/core/src/process/logger.ts`
 * and `packages/engine/src/logger.ts`).
 *
 * Browser/CLI-safe leaf: imports nothing, so both logger leaves and the dashboard
 * TUI's log sink can share ONE predicate without a dependency cycle.
 *
 * @see setLogLevelMarkerCapture — flip it on while a console-capture consumer is installed
 * @see shouldEmitLogLevelMarkers — the predicate both producers consult per call
 */

/*
FNXC:LogSeverityMarkers 2026-11-19-02:47 (RUFU-666):
The `\u0000fnlvl=<level>\u0000` marker exists ONLY so an installed console-capture consumer
(the dashboard TUI's patched console in `log-sink.ts`) can recover info/warn/error semantics
when `log()` is transported via `console.error`. Emitted unconditionally, the two NUL bytes per
line made stderr of every plain `fn` run binary to pipes: `fn task list 2>&1 | grep -n 'Todo'`
reported "binary file matches" and printed zero lines (measured 32 NUL bytes per run, 26 per
`fn task show`), so agents repeatedly deduced a false "board is empty". NUL also breaks JSON
consumers and makes PostgreSQL jsonb writes reject (see
docs/solutions/reliability/chat-jsonb-nul-sanitization.md). Contract: stderr carries zero NUL
bytes unless a severity-marker consumer is active — the capture hook (installed by
`captureConsole()`), or the explicit opt-in `FUSION_LOG_SEVERITY_MARKERS=1`/`true` for scripts
and legacy consumers that parse markers themselves. The env var is re-read per call, mirroring
the `FUSION_DEBUG` pattern, so long-lived processes and tests can toggle without module reload.
*/

/** True while a console-capture consumer (dashboard TUI) has patched `console.*`. */
let captureInstalled = false;

/**
 * Declare that a console-capture consumer is installed (true) or has been
 * released (false). Only the capture owner (`DashboardLogSink.captureConsole()`
 * / `releaseConsole()`) should call this; it is process-wide because the
 * patched `console.*` it protects is itself process-wide.
 */
export function setLogLevelMarkerCapture(active: boolean): void {
  captureInstalled = active;
}

/**
 * Whether logger output should carry the NUL-delimited severity marker.
 * Enabled while a capture consumer is installed, or via
 * `FUSION_LOG_SEVERITY_MARKERS=1`/`true` (re-read per call, like `FUSION_DEBUG`).
 * When false, producers emit byte-clean text so pipes, `grep`, and JSON
 * consumers see plain stderr.
 */
export function shouldEmitLogLevelMarkers(): boolean {
  if (captureInstalled) return true;
  const raw = process.env.FUSION_LOG_SEVERITY_MARKERS?.trim();
  return raw === "1" || raw === "true";
}
