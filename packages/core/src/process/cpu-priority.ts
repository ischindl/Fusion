/**
 * CPU priority demotion for agent-lane children.
 *
 * FNXC:AgentCpuPriority 2026-11-08-17:22 (RUFU-901):
 * Measured on a 24-core fleet host at load average 16-27 with 113 event-loop-stall episodes in one day.
 * The operator's decision was explicit — give the agent lanes lower CPU priority, do NOT reduce their
 * concurrency. This module is the mechanism for that decision, and it is deliberately narrow: it can only
 * LOWER priority, and only for a spawned lane child.
 *
 * FNXC:AgentCpuPriority 2026-11-08-18:00 (RUFU-901):
 * The measurement, stated honestly, because it bounds what this mechanism can achieve. Per-process CPU at
 * the time of the decision: `java` 382 %, `kasm` 133 % and 111 % (two tenants), a Fusion agent lane 118 %,
 * and the dashboard 124 %. The two largest consumers were therefore NEITHER Fusion's lanes NOR its dashboard.
 * Demoting lanes cannot repair a host whose top tenants are other workloads — it only stops Fusion's own
 * batch work from adding to the pressure, and stops it ahead of the UI. An earlier draft of this comment
 * claimed the lanes were the largest consumers; that was wrong and the correction is what keeps a later
 * reader from expecting this knob to move the load average.
 *
 * Why a post-spawn `setpriority` syscall rather than a `nice -n N` argv prefix:
 * `spawn`/`pty.spawn` have no niceness option, so the two candidate mechanisms are (a) prefix the launch
 * argv with `nice -n N`, or (b) lower priority against the child pid after it exists. Option (a) was
 * rejected on identity, not on merit: the lane's `command`/`args` are the adapter's `buildLaunch`/
 * `buildResume` output, and that argv is the process identity other code reads — the durable `cli_sessions`
 * row, resume matching, and provenance attribution. Prefixing it would make the recorded launch command
 * disagree with what the adapter built, and on Windows there is no `nice` binary at all. Option (b) is
 * `os.setPriority(pid, n)`: one `setpriority()` syscall in-process, no argv change, no extra spawn, no
 * PATH dependency, no shell, and therefore nothing for the async-spawn allowlist to police.
 *
 * The inheritance property is what makes pid-targeting sufficient rather than partial: a child's niceness
 * is inherited across fork/exec, so demoting the lane's direct child also covers the tool subprocesses it
 * later starts (git, ripgrep, a language server) without naming them.
 */

import { setPriority } from "node:os";

/**
 * Operator-facing opt-in. Unset (or blank) means the mechanism is entirely inert and every lane spawns
 * exactly as it always did — this is why an existing deployment changes nothing at upgrade.
 *
 * Read from the process environment at each lane spawn, so an operator sets it in the service environment
 * (a systemd `Environment=` line, the launcher's `.env`, or the shell that starts Fusion) and restarts.
 * There is intentionally no settings row and no per-task override: a priority policy that a task could
 * raise about itself is not a priority policy.
 */
export const AGENT_CPU_NICENESS_ENV = "FUSION_AGENT_CPU_NICENESS";

/**
 * Highest accepted demotion. The valid range is 0..19 by design, not POSIX's -20..19.
 *
 * Negative values would PROMPT A LANE ABOVE the interactive server — the exact inverse of the requirement —
 * and on Linux an unprivileged process cannot raise priority anyway, so accepting them would only convert a
 * config typo into an EPERM at every spawn. Refusing the whole negative half here names the mistake instead.
 */
export const AGENT_CPU_NICENESS_MAX = 19;

/** Smallest accepted value: an explicit `0` is the operator asking for "spawn at inherited priority". */
export const AGENT_CPU_NICENESS_MIN = 0;

/**
 * Closed outcome vocabulary. Every arm is a distinct operator-answerable question, and the reason strings
 * are what let a test assert the mechanism WITHOUT reading source text.
 */
export type AgentCpuPriorityReason =
  /** Variable unset/blank — the default. Nothing happened, and nothing was supposed to. */
  | "disabled"
  /** Variable present but unusable (non-numeric, negative, fractional, or above the max). */
  | "invalid-config"
  /** The spawner handed us no usable pid, so there is no process to demote. */
  | "no-pid"
  /** The target pid is this process — see the self-process guard below. */
  | "self-process"
  /** Runtime has no `os.setPriority` (older/exotic bundling). */
  | "setter-unavailable"
  /** The kernel/refusal path said no (EPERM, ESRCH, or an unmapped Windows priority class). */
  | "setter-threw";

export type AgentCpuPriorityOutcome =
  | { applied: true; pid: number; niceness: number }
  | { applied: false; reason: AgentCpuPriorityReason; detail?: string };

/** Resolved view of {@link AGENT_CPU_NICENESS_ENV}; `null` means the mechanism is inert. */
export type AgentCpuNicenessConfig =
  | { kind: "off" }
  | { kind: "invalid"; raw: string }
  | { kind: "on"; niceness: number };

/**
 * Parse the opt-in without side effects.
 *
 * `Number.parseInt` is deliberately avoided: `"8abc"` would silently become `8` and `"200"` a typo for
 * `20`, so the value must be a plain integer string in range or it is reported as invalid rather than
 * coerced into something the operator did not write.
 */
export function resolveAgentCpuNiceness(
  env: NodeJS.ProcessEnv = process.env,
): AgentCpuNicenessConfig {
  const raw = env[AGENT_CPU_NICENESS_ENV];
  if (raw === undefined || String(raw).trim() === "") return { kind: "off" };
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return { kind: "invalid", raw: text };
  const parsed = Number(text);
  if (
    !Number.isInteger(parsed)
    || parsed < AGENT_CPU_NICENESS_MIN
    || parsed > AGENT_CPU_NICENESS_MAX
  ) {
    return { kind: "invalid", raw: text };
  }
  return { kind: "on", niceness: parsed };
}

export interface ApplyAgentCpuPriorityOptions {
  /** Environment to read the opt-in from. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * The `os.setPriority` call to perform. Injectable so a test can assert the EXACT (pid, niceness) pair
   * the mechanism handed the kernel, and so a runtime without the primitive is representable.
   */
  setPriorityImpl?: (pid: number, priority: number) => void;
}

/**
 * Demote one freshly-spawned agent-lane child.
 *
 * This function never throws: every failure mode returns a named outcome. A priority knob that could fail
 * a lane spawn would be a worse outcome than a lane that keeps its inherited priority, and the caller is a
 * session boundary whose contract is that a spawn error means the child failed to start.
 *
 * Platform guard: `os.setPriority` is a core primitive on every platform Node supports, and on Windows it
 * maps the niceness value onto a Windows priority class rather than failing. There is therefore no
 * `process.platform` branch — the honest guard is that a platform which refuses the value answers through
 * `setter-threw` and the child simply keeps the priority it was born with. What never happens is a shell
 * out to `renice`, which would give Windows an outright broken path and POSIX an unnecessary PATH lookup.
 */
export function applyAgentCpuPriority(
  pid: number | undefined,
  options: ApplyAgentCpuPriorityOptions = {},
): AgentCpuPriorityOutcome {
  const config = resolveAgentCpuNiceness(options.env ?? process.env);
  if (config.kind === "off") return { applied: false, reason: "disabled" };
  if (config.kind === "invalid") {
    return {
      applied: false,
      reason: "invalid-config",
      detail: `${AGENT_CPU_NICENESS_ENV}="${config.raw}" is not an integer in ${AGENT_CPU_NICENESS_MIN}..${AGENT_CPU_NICENESS_MAX}`,
    };
  }

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { applied: false, reason: "no-pid", detail: String(pid) };
  }

  /*
  FNXC:AgentCpuPriority 2026-11-08-17:22 (RUFU-901):
  The self-process guard is the requirement "the dashboard/server process keeps interactive priority",
  enforced structurally rather than by convention. No legitimate lane child ever has this process's pid, so
  refusing it costs nothing today and makes the one refactor that would silently demote the UI — routing the
  server's own pid through this seam — answer `self-process` instead of quietly making the interface the
  lowest-priority tenant on the box.
  */
  if (pid === process.pid) {
    return { applied: false, reason: "self-process" };
  }

  const setter = options.setPriorityImpl ?? setPriority;
  if (typeof setter !== "function") {
    return { applied: false, reason: "setter-unavailable" };
  }

  try {
    setter(pid, config.niceness);
  } catch (error) {
    return {
      applied: false,
      reason: "setter-threw",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { applied: true, pid, niceness: config.niceness };
}
