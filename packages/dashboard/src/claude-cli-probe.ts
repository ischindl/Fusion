/**
 * Probe for the locally-installed Claude CLI binary.
 *
 * Used by GET /api/providers/claude-cli/status to power the "Anthropic —
 * via Claude CLI" provider card. The card shows `authenticated=true` only
 * when the binary is on PATH *and* the user has flipped on `useClaudeCli`.
 *
 * Intentional design choices:
 *
 * - TTL memoization, not per-request probing.
 *
 *   FNXC:DashboardCliProbeMemo 2026-11-08-00:55: this bullet used to read "No caching —
 *   we'd rather pay one `spawn()` per poll", and that assumption was wrong in production.
 *   `GET /api/auth/status` (which awaits this probe) measured 9,39 s and 10,92 s for a
 *   9 219 B body on two consecutive calls, and a profile of a real 155 s event-loop stall
 *   showed ~24 % of samples in `node:child_process` spawn machinery. `--version` is only
 *   ~40 ms when the binary exists and the machine is idle; the cost is the fork itself
 *   under load, multiplied by eight probes per `/auth/status` call and ~25 endpoints on
 *   first paint. The answer is now remembered for `CLI_PROBE_SUCCESS_TTL_MS`, and a failure
 *   for `CLI_PROBE_FAILURE_TTL_MS` only, so an operator who installs `claude` mid-session
 *   sees it seconds later without a restart — the same reasoning `gh-cli.ts` applies to
 *   `gh auth login`. Concurrent callers share one spawn (single-flight), and the settings
 *   save / provider-test paths invalidate explicitly instead of waiting out the TTL, so a
 *   PATH change is never an argument for staleness: `invalidateClaudeCliProbeCache()`.
 *
 * - Short timeout. A misbehaving `claude` shim could hang indefinitely;
 *   we cap the probe at 2s and report `available: false` with a timeout
 *   reason rather than blocking the HTTP request.
 *
 * - No authorization. We never shell-interpolate PATH or user input.
 *   We spawn `claude --version` directly with argv, no shell.
 */

import { spawn } from "node:child_process";
import { createCliProbeCache } from "./cli-probe-cache.js";

/** Result shape returned to the dashboard status endpoint. */
export interface ClaudeCliBinaryStatus {
  /** True if the `claude` binary was found on PATH and ran to completion. */
  available: boolean;
  /** Trimmed stdout from `claude --version`, if available. */
  version?: string;
  /** Absolute path, if we could resolve it via `which`. */
  binaryPath?: string;
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  /** Wall-clock duration of the probe, useful for debugging slow paths. */
  probeDurationMs: number;
}

/** Default probe timeout. Claude's --version is fast; 2s is generous. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Spawn `claude --version` and return a structured status result.
 *
 * Never throws — any failure is captured as `available: false` with a reason
 * so the caller (an HTTP handler) can render the provider card without
 * try/catch.
 *
 * Memoized by probe budget: N requests inside the TTL share one child process, and
 * `probeDurationMs` on a cache hit is the duration measured by the probe that produced the
 * cached answer (it is a probe measurement, not a request latency).
 *
 * The cache key is the timeout budget rather than a blanket constant, so a caller asking for
 * a different budget gets a probe that actually ran under that budget instead of an answer
 * measured under someone else's.
 */
export function probeClaudeCli(
  options: { timeoutMs?: number } = {},
): Promise<ClaudeCliBinaryStatus> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return claudeCliProbeCache(String(timeoutMs));
}

/**
 * Drop the memoized `claude --version` answer so the next probe forks again.
 *
 * FNXC:DashboardCliProbeMemo 2026-11-08-00:55: wire this at every site that changes CLI
 * settings or asks for a re-probe (provider save / Test buttons), mirroring
 * `resetGhAvailabilityCache` — an operator action must not have to wait out the TTL.
 */
export function invalidateClaudeCliProbeCache(): void {
  claudeCliProbeCache.invalidate();
}

/*
FNXC:DashboardCliProbeMemo 2026-11-08-00:55: the cache key is the resolved probe budget, so the
produced answer always comes from a probe that ran under the budget its caller asked for.
*/
const claudeCliProbeCache = createCliProbeCache<ClaudeCliBinaryStatus>(
  (key) => runClaudeCliProbe({ timeoutMs: Number(key) || PROBE_TIMEOUT_MS }),
  { isFailure: (result) => (result as ClaudeCliBinaryStatus).available !== true },
);

/*
FNXC:DashboardCliProbeMemo 2026-11-08-00:55:
The documented contract is "we cap the probe at 2s and report `available: false` with a timeout
reason", and it did not hold: `tryResolveBinaryPath` was awaited BEFORE the deadline was armed, so a
hanging `which` — the same spawn machinery a profile of a 155 s stall put ~24 % of samples in — pinned
the probe forever, and single-flight would then hand that never-settling promise to every caller in
the sharing window. The deadline now covers both child processes. Consequence readers must know: a
timed-out result may omit `binaryPath` (the lookup had not answered yet), which is honest — it is only
ever reported alongside `available: true` or a completed lookup.
*/
function runClaudeCliProbe(
  options: { timeoutMs?: number } = {},
): Promise<ClaudeCliBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return new Promise<ClaudeCliBinaryStatus>((resolvePromise) => {
    const finish = (result: Omit<ClaudeCliBinaryStatus, "probeDurationMs">): void => {
      resolvePromise({ ...result, probeDurationMs: Date.now() - startedAt });
    };

    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // Process already gone — nothing to do.
      }
      finish({
        available: false,
        reason: `Probe timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const probe = async (): Promise<void> => {
      const binaryPath = await tryResolveBinaryPath("claude");
      // The deadline already answered for this probe; do not overwrite it.
      if (settled) return;

      child = spawn(binaryPath ?? "claude", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        finish({
          available: false,
          binaryPath,
          reason: isNotFound ? "`claude` not found on PATH" : err.message,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          finish({
            available: true,
            version: stdout.trim() || undefined,
            binaryPath,
          });
        } else {
          finish({
            available: false,
            binaryPath,
            reason:
              stderr.trim() || `claude --version exited with code ${String(code)}`,
          });
        }
      });
    };

    probe().catch((err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/**
 * Best-effort `which claude`. We don't fail probe on inability to resolve
 * the path — the spawn above is the actual authority. This is just for
 * surfacing a friendly "found at /opt/homebrew/bin/claude" in the UI.
 */
async function tryResolveBinaryPath(binary: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
