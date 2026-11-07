/**
 * FNXC:ProjectRuntimeOff 2026-11-07-15:56:
 * The ONE choke point behind which a project's engine runtime is loaded or unloaded.
 *
 * Production measurement that motivated this: ~435 DB transactions/second with zero UI
 * requests; 1107 sampled scheduler passes averaging 51–183 s (max 584 s) per project with
 * ~25 projects hosted in one process; `/api/tasks/page` 11–26 s against `/api/health`
 * 0.09 s. `globalPause`/`enginePaused` cannot fix that because `Scheduler.schedule()` does
 * not consult them at entry — they stop dispatch at the END of a pass, so the pass and all
 * its board reads still run.
 *
 * Contract every consumer must respect:
 * - `runtimeEnabled: false` (persisted project setting, absent = true) means the project
 *   runs NO engine work from the next pass onward: no scheduler pass, no triage poll, no
 *   self-healing maintenance, no heartbeat dispatch, no planner-overseer poll, no cron, no
 *   maintenance sweep, no workflow-continuation pump.
 * - A pass already in flight is NEVER aborted. Disarming stops the timers and the next
 *   pass entry; it performs no cancel, no abort, no session kill, so nothing is left
 *   half-written.
 * - Disarmed means disarmed: the interval is cleared, so a disabled project produces no
 *   work AND no wakeups.
 * - Read paths are never gated. The dashboard keeps serving the project's board, cards and
 *   history through the TaskStore while the runtime is unloaded.
 *
 * Every periodic engine driver registers itself here as an arm/disarm pair instead of
 * guarding its own callback, which is what keeps this a single gate rather than one check
 * per lane.
 */

/** A periodic engine driver and how to start/stop its wakeups. */
export interface RuntimeLane {
  /** Fixed label for the startup/unload log line — never free-form text. */
  name: string;
  arm: () => void;
  disarm: () => void;
}

/**
 * FNXC:ProjectRuntimeOff 2026-11-07-15:56:
 * Read the persisted project gate. Absent means enabled: the setting is opt-out and rows
 * written before it existed must keep running their engine.
 */
export function isProjectRuntimeEnabled(
  settings: { runtimeEnabled?: boolean } | null | undefined,
): boolean {
  return settings?.runtimeEnabled !== false;
}

/**
 * The gate itself. One instance per project engine (one for the runtime's lanes, one for
 * the engine-owned periodic arms); both apply the same `runtimeEnabled` value.
 */
export class RuntimeLaneGate {
  private enabled: boolean;
  private readonly lanes: RuntimeLane[] = [];
  private readonly armed = new Set<RuntimeLane>();

  constructor(initial: boolean = true) {
    this.enabled = initial;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Register a lane and arm it only while the gate is open. Registration is
   * unconditional so a later enable can arm a lane that startup skipped.
   */
  register(lane: RuntimeLane): RuntimeLane {
    this.lanes.push(lane);
    if (this.enabled) this.armLane(lane);
    return lane;
  }

  /**
   * Apply a gate change. Disarming runs every registered disarm (clearing intervals and
   * listeners, so no wakeup survives) and never cancels running work; enabling re-arms any
   * lane that is not currently armed.
   */
  apply(enabled: boolean): { disarmed: string[]; armed: string[] } {
    const disarmed: string[] = [];
    const armed: string[] = [];
    if (enabled === this.enabled) return { disarmed, armed };
    this.enabled = enabled;
    if (!enabled) {
      for (const lane of [...this.armed].reverse()) {
        if (this.disarmLane(lane)) disarmed.push(lane.name);
      }
    } else {
      for (const lane of this.lanes) {
        if (!this.armed.has(lane) && this.armLane(lane)) armed.push(lane.name);
      }
    }
    return { disarmed, armed };
  }

  private armLane(lane: RuntimeLane): boolean {
    if (this.armed.has(lane)) return false;
    try {
      lane.arm();
    } catch {
      // A lane that fails to arm stays disarmed; the gate must not fail engine start.
      return false;
    }
    this.armed.add(lane);
    return true;
  }

  private disarmLane(lane: RuntimeLane): boolean {
    if (!this.armed.has(lane)) return false;
    try {
      lane.disarm();
    } catch {
      return false;
    }
    this.armed.delete(lane);
    return true;
  }
}
