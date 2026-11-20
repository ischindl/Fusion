/*
FNXC:ReportsHealth 2026-11-18-14:44 (RUFU-716):
Type-only import of the ONE closed vocabulary of withheld-delivery reasons, from the same browser-safe
leaf the scheduler writes through and the dashboard reads through. A second list of these reasons here is
the drift this task exists to remove, and because it is `import type` it is erased at build time — the
classifier stays a pure function over declared inputs and `@fusion/core` still never depends on engine.
*/
import type { HeartbeatTimerSkipReason } from "@fusion/core/heartbeat-timer-liveness";

export type ReportHealthBucket =
  | "healthy"
  | "stale-assignment"
  | "stale"
  /**
   * RUFU-716: the lane's heartbeat trigger provably fired inside the caller's own staleness window and
   * the engine deliberately withheld the delivery, so the frozen delivery timestamp is fully explained.
   * Non-actionable: it joins no `hasStale` / `hasStuck` / `hasOperatorActionable` set and therefore
   * adds no "create a follow-up task to investigate" line to a manager's heartbeat prompt.
   */
  | "delivery-skipped"
  | "stuck"
  /**
   * FNXC:ReportsHealth 2026-11-20-02:16 (RUFU-783):
   * The lane says `running` and its last delivered heartbeat is old, but NOTHING on the row or in the run
   * registry says work is open: no unclosed run, or a run whose `fn_heartbeat_done` the engine already
   * accepted, and no session behind it. That is a bookkeeping desync the reclaim owns, not a lane the
   * operator or a manager must chase — so the bucket is non-actionable: no bold, no `stuck`/`stale`
   * substring, and it joins no `hasStale` / `hasStuck` / `hasOperatorActionable` set. Before it existed,
   * the only word for this shape was `**stuck**`, and the manager's prompt paired with it ordered "create a
   * follow-up task to investigate" for a colleague that had finished its round minutes earlier (measured on
   * a 1 h lane: the badge survived the whole cadence).
   */
  | "desynced"
  | "paused"
  | "operator-actionable"
  | "rate-limited";

/**
 * RUFU-716: the derived form of "this lane's timer fired while delivery was withheld", already
 * resolved by the single shared reader (`describeHeartbeatDeliverySkip` from
 * `@fusion/core/heartbeat-timer-liveness`) against the caller's own staleness window. Raw
 * `agent.metadata` is deliberately NOT accepted here: one reader owns what the stored row means, the
 * same boundary RUFU-286 drew for the throttle deadline.
 */
export interface ReportHealthDeliverySkip {
  reason: HeartbeatTimerSkipReason;
  firedAt: string;
  fireAgeMs: number;
}

export interface ReportHealthInput {
  state: string | undefined;
  pauseReason: string | undefined;
  heartbeatAgeMs: number;
  heartbeatTimeoutMs: number;
  staleThresholdMs: number;
  staleParkedAssignment: boolean;
  /**
   * RUFU-286: the provider-throttle re-probe deadline, already resolved by the single
   * browser-safe reader (`describeHeartbeatThrottle` from `@fusion/core/heartbeat-recovery-state`).
   * The classifier deliberately takes the derived value instead of raw `metadata` so this
   * engine-side classifier stays free of parsing policy — one reader owns what "cooling down"
   * means for every surface. Absent/null means no cooldown.
   */
  throttleCooldownUntilAt?: string | null;
  /**
   * RUFU-716: derived by the caller from the shared reader, bounded by THIS row's own
   * `staleThresholdMs`. Absent/null means no relief is due — an absent, unparseable, future-dated, or
   * too-old fire — and the row falls through to the ordinary verdicts.
   */
  deliverySkip?: ReportHealthDeliverySkip | null;
  /**
   * RUFU-783: positive evidence about the RUN behind a `running` badge, all three derived by the caller —
   * the classifier deliberately sees no store and no `metadata`:
   * - `hasUnclosedRun`: the registry still holds an `active` run row for this agent.
   * - `hasAcceptedDone`: that row carries the engine's acknowledgement that the run said it was finished
   *   (`hasAcceptedHeartbeatDone` on its `resultJson`, the one predicate that owns the question).
   * - `hasLiveSession`: this process holds a heartbeat run in flight for the agent.
   * Absent means unknown, and unknown is NOT evidence: `stuck` is withheld and the row lands in `desynced`.
   * Age may still excuse a lane from ever being judged; nothing about age can substitute for proof.
   */
  hasUnclosedRun?: boolean;
  hasAcceptedDone?: boolean;
  hasLiveSession?: boolean;
}

export interface ReportHealthClassification {
  bucket: ReportHealthBucket;
  cellText: string;
}

const OPERATOR_ACTIONABLE_PAUSE_REASONS = new Set([
  "error-unrecoverable",
  "error-retry-exhausted",
  "heartbeat-model-unavailable",
]);

/*
FNXC:ReportsHealth 2026-11-18-14:44 (RUFU-716):
Why the engine withheld a delivery, phrased as a fact rather than a symptom. Every value here must stay
free of the word "stale" and of any instruction verb: this cell is read by a manager agent whose prompt
acts on what the Health column says, and the whole defect being fixed is a cell that read as a fault and
ordered an investigation of a lane that was behaving exactly as configured.

The map's keys double as the relief-eligible set, which is why the type is `Record<HeartbeatTimerSkipReason, string>`:
if the closed vocabulary in `@fusion/core` ever grows a reason with no copy here, the declaration stops
compiling rather than silently shipping a reason with no wording. `deliverySkipCopy` is the single place
that decides, so an incoming reason OUTSIDE the set relieves nothing — refusing relief on evidence it
cannot interpret is the direction the safety property requires, and it is what stops a malformed or
future-unknown marker from laundering a genuinely dead trigger into an explained delivery.
*/
const DELIVERY_SKIP_REASON_COPY: Record<HeartbeatTimerSkipReason, string> = {
  "wake-suppressed": "nothing newer to report",
  "idle-skip": "idle with no assigned task",
  "parallel-execution": "a run is already in flight",
};

function deliverySkipCopy(reason: HeartbeatTimerSkipReason): string | null {
  return Object.prototype.hasOwnProperty.call(DELIVERY_SKIP_REASON_COPY, reason)
    ? DELIVERY_SKIP_REASON_COPY[reason]
    : null;
}

/** Compact elapsed-fire age for the health cell; never an instruction and never a verdict word. */
function formatFireAge(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "under 1m";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 1) {
    return `${minutes}m`;
  }
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * FNXC:ReportsHealth 2026-07-24-12:00:
 * FN-8569 requires pause markers to outrank the state column because independent
 * state and marker writes can persist a live-looking state alongside an
 * error-unrecoverable park marker. This classifier must be truthful for every
 * persisted shape, including desyncs that best-effort store cleanup cannot prevent.
 * `lastError` is deliberately excluded: it is diagnostic history, not a health
 * input. Keep this classifier engine-side so @fusion/core never depends on engine.
 */
export function classifyReportHealth(input: ReportHealthInput): ReportHealthClassification {
  const pauseReason = input.pauseReason?.trim();
  if (pauseReason) {
    if (OPERATOR_ACTIONABLE_PAUSE_REASONS.has(pauseReason)) {
      return {
        bucket: "operator-actionable",
        cellText: `**needs operator repair** (${pauseReason})`,
      };
    }
    return {
      bucket: "paused",
      cellText: `paused (${pauseReason})`,
    };
  }

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:17 (RUFU-286):
  A throttled agent stays in `state: "error"` while it waits out a bounded provider cooldown, so
  the pre-existing error branch below would have reported it as `**needs operator repair**` —
  the same false alarm the lifecycle used to park it with. Nothing is wrong with the credentials
  or access; the provider said "try again later" and the heartbeat timer has the re-probe armed.
  Only the state column changes (`error` stays, because the agent genuinely is not running), and
  a pause never takes this branch: pause markers outrank state above, and the shared reader
  refuses to advertise a re-probe the de-registered timer would not run.
  */
  if (input.state === "error" && input.throttleCooldownUntilAt) {
    return {
      bucket: "rate-limited",
      cellText: `rate limited — auto-retry scheduled (${input.throttleCooldownUntilAt})`,
    };
  }
  if (input.state === "error") {
    return { bucket: "operator-actionable", cellText: "**needs operator repair**" };
  }
  if (input.staleParkedAssignment) {
    return { bucket: "stale-assignment", cellText: "**stale** assignment" };
  }
  /*
  FNXC:ReportsHealth 2026-11-18-14:44 (RUFU-716):
  A frozen delivery timestamp is only evidence of a lost trigger when nothing else explains it, and
  this is the explanation the engine itself owns: the interval fired and the wake discipline, the idle
  setting, or the parallel-execution gate declined to deliver. Before this branch the classifier read
  ONLY `heartbeatAgeMs`, which by design never advances on a suppressed delivery, so a healthy idle
  lane was reported `**stale**` forever and the prompt below it ordered "create a follow-up task to
  investigate" on every manager heartbeat.

  Placement is the contract:
  - AFTER the pause / throttle / error / stale-assignment checks, because those describe a lane whose
    silence the operator genuinely must act on; relief never outranks them.
  - BEFORE the `stuck` and `stale` branches, because that is the pair of verdicts this fact defeats.
  - Gated on the same `active` / `idle` states the `stale` branch uses. A `running` lane is the `stuck`
    story and a real wedge may live there; a lane held by a live run writes no liveness row anyway.
  The caller bounded `deliverySkip` by this row's own `staleThresholdMs`, so the relief window is that
  row's effective interval plus its idle silence budget — never a shorter interval, and no threshold
  anywhere moved. An absent or expired fire reaches neither this branch nor any change in behaviour.
  */
  if (input.deliverySkip && (input.state === "active" || input.state === "idle")) {
    const copy = deliverySkipCopy(input.deliverySkip.reason);
    if (copy) {
      return {
        bucket: "delivery-skipped",
        cellText: `delivery skipped — ${copy}, timer fired ${formatFireAge(input.deliverySkip.fireAgeMs)} ago`,
      };
    }
  }
  /*
  FNXC:ReportsHealth 2026-11-20-02:16 (RUFU-783):
  `**stuck**` used to be two fields: a `running` state column and an age past twice the heartbeat timeout.
  Those two are true of a healthy lane every time a durable agent finishes a round and the engine has not
  settled its row, which is how a report lane on a 1 h cadence spent an hour ordered investigated. Age is
  still what EXCUSES a lane from judgement — below `heartbeatTimeoutMs × 2` nothing here fires — but the
  verdict itself now needs one of two proofs:
  - the registry still holds a run for this agent that was never closed and never acknowledged finished, or
  - a session in this process is genuinely in flight behind the badge.
  With neither, the honest word is `desynced`: the badge is wrong, the reclaim owns it, and a manager has
  nothing to do. The accepted-done case says so in the cell because "finished, awaiting reclaim" is the fact
  a human reading the table needs, not a hedge.
  */
  if (input.state === "running" && input.heartbeatAgeMs > input.heartbeatTimeoutMs * 2) {
    const unclosedRunProven = input.hasUnclosedRun === true && input.hasAcceptedDone !== true;
    if (unclosedRunProven || input.hasLiveSession === true) {
      return { bucket: "stuck", cellText: "**stuck**" };
    }
    return {
      bucket: "desynced",
      cellText: input.hasAcceptedDone === true
        ? "done accepted, engine reclaim pending"
        : "no live run behind the running badge",
    };
  }
  if ((input.state === "active" || input.state === "idle") && input.heartbeatAgeMs > input.staleThresholdMs) {
    return { bucket: "stale", cellText: "**stale**" };
  }
  if (input.state === "paused") {
    return { bucket: "paused", cellText: "paused" };
  }

  return { bucket: "healthy", cellText: "healthy" };
}
