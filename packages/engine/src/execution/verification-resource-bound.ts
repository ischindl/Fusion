/**
 * Verification resource bound — bounds WHAT ONE verification can consume.
 *
 * FNXC:VerificationResourceBound 2026-09-10-03:38:
 * The count cap (verification-concurrency.ts) bounds how many verifications run at once and is
 * deliberately untouched here; a count of one still pegged every core of a 24-core host because a
 * single verification's own worker pool (tsc `-pts`, vitest forks, cargo codegen) inherits the full
 * CPU allowance, and nothing bounded its memory at all. Symptom: dashboard `/api/tasks` took
 * 1.4–2.8 s for minutes after any executor verification start — the dashboard UI is in-process and
 * starves exactly like the terminal and IDE a developer sits in front of. This module complements
 * the count cap with a resource bound: a CPU quota (~half the machine), a below-neutral scheduler
 * weight for CPU+IO share, and an optional (off-by-default) memory ceiling, applied per spawn by
 * wrapping the command into a confined scope.
 *
 * Rungs, probed once per process and cached (the probe is three trivial `true` spawns, nothing
 * heavy): "scope" (systemd user-scope cgroup properties) → "priority" (nice/ionice, degrades
 * gracefully) → "bare" (today's command, byte-for-byte). A missing primitive degrades plus warns
 * via the returned note; it never fails the verification or the card. CI (GitHub ubuntu-latest, no
 * usable systemd user manager) exercises every rung through injected capabilities.
 *
 * Precedence (mirror of the settings doc): project value → global value → built-in default derived
 * from the CORE COUNT (read only inside the resolver). The store merge (settings-ops
 * canonicalizeSettings: defaults → global → project) already gives callers merged values with
 * project-over-global precedence, so lanes feed the merged value into the `project` slot; the
 * `global` slot exists for callers holding the raw tiers.
 *
 * Machine aggregation mirrors verification-concurrency.ts's most-conservative-of-registered
 * semantics: concurrent ProjectEngine instances on one host do not last-write each other, and a
 * project that DISABLES the bound (0) must not unbind the shared machine for projects that
 * requested it — disabled dimensions contribute nothing to the aggregate.
 */
import * as os from "node:os";
import { exec } from "node:child_process";
import type { RunAuditEventInput } from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { quoteShellArg } from "../executor/shell-quote.js";

/** The three operator-tunable numbers (merged, project-over-global already resolved upstream). */
export interface VerificationResourceBoundConfig {
  /** CPU quota as a percentage of one core (600 = six cores). 0 disables this dimension. */
  cpuQuotaPercent?: number;
  /** Scheduler weight 1–10000 (neutral 100) applied as CPUWeight and IOWeight. 0 disables. */
  cpuIoWeight?: number;
  /** Memory ceiling in MB. 0 disables; unset means "no ceiling" (built-in default is unset). */
  memoryMaxMb?: number;
}

/** An effective per-dimension bound. A dimension absent here is not enforced (property omitted). */
export interface VerificationResourceProfile {
  cpuQuotaPercent?: number;
  cpuIoWeight?: number;
  memoryMaxMb?: number;
}

export type VerificationResourceRung = "scope" | "priority" | "bare";

export interface VerificationResourceCapabilities {
  rung: VerificationResourceRung;
  niceAvailable: boolean;
  ioniceAvailable: boolean;
}

/** Fixed lane identifiers for run-audit metadata — never free-text, never command lines or paths. */
export type VerificationResourceBoundLane =
  | "tool"
  | "deterministic"
  | "mission"
  | "attempt-fix"
  | "stuck-detector"
  | "scheduled-prompt";

// ── Built-in defaults and clamps ───────────────────────────────────────────────

/** Half the machine's cores as a percentage of one core, floored at one full core. */
export function builtinCpuQuotaPercent(coreCount: number): number {
  const cores = Math.max(1, Math.floor(coreCount) || 1);
  return Math.max(100, Math.round(cores * 50));
}

/**
 * Below the scheduler's neutral value (100) so verification yields to interactive work under any
 * contention. 10 is the systemd-managed-service scale — a machine running verifications stays usable.
 */
export const BUILTIN_CPU_IO_WEIGHT = 10;

const QUOTA_MIN_PERCENT = 10;
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 10_000;
const MEMORY_MIN_MB = 128;
const MEMORY_MAX_MB = 1_048_576; // 1 TiB

/** Commands at/above this duration with an applied bound emit the sustained audit event. */
export const VERIFICATION_BOUND_SUSTAINED_MS = 120_000;

/** Bounded lifetime of each probe command — probe spawns `true`, so this is a hang guard only. */
const PROBE_TIMEOUT_MS = 5_000;

// ── Pure resolver (project → global → built-in default) ────────────────────────

export interface VerificationResourceProfileInput {
  /** Project-tier values (or already-merged values; see module FNXC note). */
  project?: VerificationResourceBoundConfig;
  /** Global-tier machine-wide fallback values. */
  global?: VerificationResourceBoundConfig;
  /** Host core count for built-in default derivation. */
  coreCount: number;
}

function pick(
  project: number | undefined,
  global: number | undefined,
): number | undefined {
  return project !== undefined ? project : global;
}

/** true = operator explicitly disabled this dimension; undefined = fall through to default. */
function isDisabled(raw: number | undefined): boolean {
  return raw === 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Resolve the effective per-dimension profile. Non-finite or negative inputs behave as unset
 * (built-in default) — a stored NaN must not silently remove the machine's protection.
 * `0` is the operator-disable signal and yields an absent (unenforced) dimension.
 */
export function resolveVerificationResourceProfile(
  input: VerificationResourceProfileInput,
): VerificationResourceProfile {
  const cores = Math.max(1, Math.floor(input.coreCount) || 1);
  const profile: VerificationResourceProfile = {};

  const quotaRaw = pick(input.project?.cpuQuotaPercent, input.global?.cpuQuotaPercent);
  if (quotaRaw === undefined || !Number.isFinite(quotaRaw) || quotaRaw < 0) {
    profile.cpuQuotaPercent = builtinCpuQuotaPercent(cores);
  } else if (!isDisabled(quotaRaw)) {
    profile.cpuQuotaPercent = clamp(quotaRaw, QUOTA_MIN_PERCENT, Math.max(100, cores * 100));
  }

  const weightRaw = pick(input.project?.cpuIoWeight, input.global?.cpuIoWeight);
  if (weightRaw === undefined || !Number.isFinite(weightRaw) || weightRaw < 0) {
    profile.cpuIoWeight = BUILTIN_CPU_IO_WEIGHT;
  } else if (!isDisabled(weightRaw)) {
    profile.cpuIoWeight = clamp(weightRaw, WEIGHT_MIN, WEIGHT_MAX);
  }

  const memoryRaw = pick(input.project?.memoryMaxMb, input.global?.memoryMaxMb);
  if (memoryRaw !== undefined && Number.isFinite(memoryRaw) && memoryRaw > 0) {
    profile.memoryMaxMb = clamp(memoryRaw, MEMORY_MIN_MB, MEMORY_MAX_MB);
  }

  return profile;
}

export function isVerificationResourceProfileEnabled(profile: VerificationResourceProfile): boolean {
  return (
    profile.cpuQuotaPercent !== undefined
    || profile.cpuIoWeight !== undefined
    || profile.memoryMaxMb !== undefined
  );
}

// ── Shared-machine registry (most-conservative-of-registered) ──────────────────

const projectProfiles = new Map<string, VerificationResourceProfile>();

/**
 * Register one project's resolved profile. Fully-disabled profiles are NOT stored: a disabled
 * dimension contributes nothing to the machine aggregate, so a disabling project can never
 * unbind the machine for projects that requested the bound (mirror of the count-cap lesson that
 * last-write-per-engine races the singleton).
 */
export function registerProjectVerificationResourceProfile(
  projectId: string,
  profile: VerificationResourceProfile,
): void {
  if (!isVerificationResourceProfileEnabled(profile)) {
    projectProfiles.delete(projectId);
    return;
  }
  projectProfiles.set(projectId, profile);
}

export function unregisterProjectVerificationResourceProfile(projectId: string): void {
  projectProfiles.delete(projectId);
}

export function resetVerificationResourceProfileRegistryForTests(): void {
  projectProfiles.clear();
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? Math.min(...present) : undefined;
}

/**
 * The bound one spawn must honour: the most conservative (smallest) enabled value per dimension
 * across this caller's own profile and every registered project profile. A dimension nobody
 * enabled stays absent (unenforced); a caller-disabled dimension is still bound when ANOTHER
 * project registered it, because the shared machine is the resource being protected.
 */
export function resolveEffectiveVerificationResourceProfile(
  own: VerificationResourceProfile,
): VerificationResourceProfile {
  const effective: VerificationResourceProfile = {};
  const registered = [...projectProfiles.values()];
  const quota = minDefined([own.cpuQuotaPercent, ...registered.map((p) => p.cpuQuotaPercent)]);
  const weight = minDefined([own.cpuIoWeight, ...registered.map((p) => p.cpuIoWeight)]);
  const memory = minDefined([own.memoryMaxMb, ...registered.map((p) => p.memoryMaxMb)]);
  if (quota !== undefined) effective.cpuQuotaPercent = quota;
  if (weight !== undefined) effective.cpuIoWeight = weight;
  if (memory !== undefined) effective.memoryMaxMb = memory;
  return effective;
}

/**
 * Convenience for callers holding store-merged settings: canonicalizeSettings already layers
 * defaults → global → project, so the merged value is passed as the `project` slot (it carries
 * project-over-global precedence) and defaults apply to whatever remains unset.
 */
export function verificationResourceProfileFromMergedSettings(
  settings: VerificationResourceBoundConfig,
  coreCount: number,
): VerificationResourceProfile {
  return resolveVerificationResourceProfile({ project: settings, coreCount });
}

// ── Capability probe (cached once per process) ─────────────────────────────────

export type ProbeRunner = (command: string) => Promise<boolean>;

async function defaultProbeRunner(command: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      exec(command, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

const SYSTEMD_SCOPE_PROBE =
  "systemd-run --user --scope -p CPUQuota=100% -p CPUWeight=10 -p IOWeight=10 true";
const NICE_PROBE = "nice -n 10 true";
const IONICE_PROBE = "ionice -c3 true";

let probeRunner: ProbeRunner = defaultProbeRunner;
let capabilitiesPromise: Promise<VerificationResourceCapabilities> | null = null;

export function setVerificationResourceProbeRunnerForTests(runner: ProbeRunner | null): void {
  probeRunner = runner ?? defaultProbeRunner;
}

async function computeCapabilities(): Promise<VerificationResourceCapabilities> {
  const [scopeOk, niceOk, ioniceOk] = await Promise.all([
    probeRunner(SYSTEMD_SCOPE_PROBE),
    probeRunner(NICE_PROBE),
    probeRunner(IONICE_PROBE),
  ]);
  if (scopeOk) return { rung: "scope", niceAvailable: niceOk, ioniceAvailable: ioniceOk };
  return { rung: niceOk ? "priority" : "bare", niceAvailable: niceOk, ioniceAvailable: ioniceOk };
}

/**
 * Cached once per process — the same mistake class the description forbids ("the probe re-runs on
 * every verification"). The cached promise is shared by concurrent first callers, and a failed
 * computation still caches as `bare` so a probe can never fail a verification.
 */
export function getVerificationResourceCapabilities(): Promise<VerificationResourceCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = computeCapabilities().catch(() => ({
      rung: "bare" as const,
      niceAvailable: false,
      ioniceAvailable: false,
    }));
  }
  return capabilitiesPromise;
}

/** Deterministic CI/test injection — fake every rung without needing systemd. */
export function setVerificationResourceCapabilitiesForTests(
  capabilities: VerificationResourceCapabilities | null,
): void {
  capabilitiesPromise = capabilities ? Promise.resolve(capabilities) : null;
}

export function resetVerificationResourceProbeForTests(): void {
  capabilitiesPromise = null;
  coreCountCache = null;
}

// ── Core count (read only inside the resolver's default derivation) ───────────

let coreCountCache: number | null = null;

export function getHostCoreCount(): number {
  if (coreCountCache === null) {
    // FNXC:VerificationResourceBound 2026-09-10-03:38: os.cpus() runs once per process; the spec's
    // "probe stays tiny" applies here too — the count is read only to derive built-in defaults.
    coreCountCache = Math.max(1, os.cpus().length);
  }
  return coreCountCache;
}

// ── Command wrapper ────────────────────────────────────────────────────────────

/**
 * Wrap a verification command so its whole process tree carries the bound.
 *
 * The scope rung uses `exec` so the wrapper REPLACES the spawn shell instead of nesting a second
 * shell, and the scope payload keeps the caller's process group (preflight proof: a negative-pgid
 * kill reached every payload process), so superviseSpawn's SIGTERM→SIGKILL escalation and the
 * post-close reap still own the whole tree.
 *
 * Only probed-accepted properties are emitted: `CPUQuota=`, `CPUWeight=`, `IOWeight=`, `MemoryMax=`.
 * `Nice=` and `IoWeight=` are NOT valid scope properties (systemd rejects them outright) — the
 * priority rung reaches them through the `nice`/`ionice` binaries instead.
 */
export function wrapVerificationCommandForBound(
  command: string,
  capabilities: VerificationResourceCapabilities,
  profile: VerificationResourceProfile,
): string {
  if (!isVerificationResourceProfileEnabled(profile)) return command;

  if (capabilities.rung === "scope") {
    const props: string[] = [];
    if (profile.cpuQuotaPercent !== undefined) {
      props.push(`-p CPUQuota=${profile.cpuQuotaPercent}%`);
    }
    if (profile.cpuIoWeight !== undefined) {
      props.push(`-p CPUWeight=${profile.cpuIoWeight}`, `-p IOWeight=${profile.cpuIoWeight}`);
    }
    if (profile.memoryMaxMb !== undefined) {
      props.push(`-p MemoryMax=${profile.memoryMaxMb}M`);
    }
    if (props.length === 0) return command;
    return `exec systemd-run --user --scope ${props.join(" ")} sh -c ${quoteShellArg(command)}`;
  }

  if (capabilities.rung === "priority" && capabilities.niceAvailable) {
    const ionicePrefix = capabilities.ioniceAvailable ? "ionice -c3 " : "";
    return `exec nice -n 10 ${ionicePrefix}sh -c ${quoteShellArg(command)}`;
  }

  // Bare rung, or priority rung without even `nice`: byte-for-byte today's command.
  return command;
}

// ── Run-audit visibility ───────────────────────────────────────────────────────
// Domain "sandbox" is reused deliberately: its documented meaning is command-execution
// confinement metadata, and widening the core RunAuditDomain union would touch a core type
// outside this task's file scope. The `verification:` mutationType prefix namespaces the events.

export const VERIFICATION_BOUND_ENGAGED = "verification:resource-bound-engaged";
export const VERIFICATION_BOUND_SUSTAINED = "verification:resource-bound-sustained";
const VERIFICATION_BOUND_AUDIT_AGENT_ID = "verification";
const VERIFICATION_BOUND_AUDIT_RUN_ID = "verification-resource-bound";

function quotaBucket(profile: VerificationResourceProfile, coreCount: number): string {
  if (profile.cpuQuotaPercent === undefined) return "none";
  const share = profile.cpuQuotaPercent / (Math.max(1, coreCount) * 100);
  if (share < 0.25) return "lt-25";
  if (share < 0.5) return "25-50";
  if (share < 0.75) return "50-75";
  return "gte-75";
}

function durationBucket(durationMs: number): string {
  if (durationMs < 2 * 60_000) return "lt-2m";
  if (durationMs < 5 * 60_000) return "2-5m";
  if (durationMs < 15 * 60_000) return "5-15m";
  return "gte-15m";
}

function boundAuditMetadata(
  lane: VerificationResourceBoundLane,
  capabilities: VerificationResourceCapabilities,
  profile: VerificationResourceProfile,
  coreCount: number,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    lane,
    rung: capabilities.rung,
    quotaBucket: quotaBucket(profile, coreCount),
  };
  if (profile.cpuIoWeight !== undefined) metadata.cpuIoWeight = profile.cpuIoWeight;
  if (profile.memoryMaxMb !== undefined) metadata.memoryMaxMb = profile.memoryMaxMb;
  return metadata;
}

// ── Apply (spawn-time seam used by every bound lane) ───────────────────────────

export interface VerificationResourceBoundRequest {
  command: string;
  /** Merged (project-over-global) operator values for this lane's task/project. */
  settings: VerificationResourceBoundConfig;
  lane: VerificationResourceBoundLane;
  taskId?: string;
  /** Sink host for bounded best-effort run-audit; telemetry can never fail the verification. */
  auditHost?: RunAuditSinkHost;
  capabilities?: VerificationResourceCapabilities;
  coreCount?: number;
}

export interface AppliedVerificationResourceBound {
  /** Possibly-wrapped command; identical to the input when no bound applied. */
  command: string;
  rung: VerificationResourceRung;
  profile: VerificationResourceProfile;
  applied: boolean;
  /**
   * Report the run's wall-clock duration from the lane's existing exit/close path (no new timer).
   * Emits the sustained event past VERIFICATION_BOUND_SUSTAINED_MS when a bound was applied.
   */
  reportCompletion: (durationMs: number) => void;
}

/**
 * Resolve capabilities + effective profile and wrap the command. Callers gate on containment
 * (never wrap a real confined sandbox backend); this function itself only degrades:
 * disabled profile, bare rung, or unbounded dimensions → unwrapped command and NO audit event
 * ("a disabled rung emits nothing").
 */
export async function applyVerificationResourceBound(
  request: VerificationResourceBoundRequest,
): Promise<AppliedVerificationResourceBound> {
  const coreCount = request.coreCount ?? getHostCoreCount();
  const capabilities = request.capabilities ?? await getVerificationResourceCapabilities();
  const ownProfile = verificationResourceProfileFromMergedSettings(request.settings, coreCount);
  const profile = resolveEffectiveVerificationResourceProfile(ownProfile);

  const noop = (rung: VerificationResourceRung, applied: boolean): AppliedVerificationResourceBound => ({
    command: request.command,
    rung,
    profile,
    applied,
    reportCompletion: () => undefined,
  });

  if (!isVerificationResourceProfileEnabled(profile)) return noop("bare", false);
  if (capabilities.rung === "bare") return noop("bare", false);

  const wrapped = wrapVerificationCommandForBound(request.command, capabilities, profile);
  if (wrapped === request.command) return noop(capabilities.rung, false);

  const baseMetadata = boundAuditMetadata(request.lane, capabilities, profile, coreCount);
  const auditInput = (mutationType: string, extra?: Record<string, unknown>): RunAuditEventInput => ({
    taskId: request.taskId,
    agentId: VERIFICATION_BOUND_AUDIT_AGENT_ID,
    runId: VERIFICATION_BOUND_AUDIT_RUN_ID,
    domain: "sandbox",
    mutationType,
    target: request.taskId ?? `lane:${request.lane}`,
    metadata: { ...baseMetadata, ...extra },
  });

  // FNXC:RunAudit 2026-09-10-03:38: best-effort via the bounded seam — an absent, throwing, or
  // hanging audit sink cannot alter or delay the verification itself.
  void emitBoundedRunAudit(request.auditHost, auditInput(VERIFICATION_BOUND_ENGAGED));

  return {
    command: wrapped,
    rung: capabilities.rung,
    profile,
    applied: true,
    reportCompletion: (durationMs: number) => {
      if (durationMs < VERIFICATION_BOUND_SUSTAINED_MS) return;
      void emitBoundedRunAudit(
        request.auditHost,
        auditInput(VERIFICATION_BOUND_SUSTAINED, {
          durationBucket: durationBucket(durationMs),
          durationMs,
        }),
      );
    },
  };
}

/**
 * Short operator-facing line for verification results — the task/operator can SEE the bound
 * without opening a database, per the task's visibility requirement.
 */
export function describeAppliedVerificationResourceBound(
  applied: AppliedVerificationResourceBound,
): string | undefined {
  if (!applied.applied) return undefined;
  const parts: string[] = [];
  if (applied.profile.cpuQuotaPercent !== undefined) {
    parts.push(`CPUQuota=${applied.profile.cpuQuotaPercent}%`);
  }
  if (applied.profile.cpuIoWeight !== undefined) {
    parts.push(`weight=${applied.profile.cpuIoWeight}`);
  }
  if (applied.profile.memoryMaxMb !== undefined) {
    parts.push(`MemoryMax=${applied.profile.memoryMaxMb}M`);
  }
  const scopeNote = applied.rung === "scope" ? " (systemd scope)" : " (nice/ionice)";
  return `resource bound: ${parts.join(" ")}${scopeNote}`;
}
