import type { ResearchRun } from "@fusion/core";
import { createLogger, formatError } from "../logger.js";
import type { ResearchExecutorStore, ResearchOrchestrator } from "./research-orchestrator.js";

const log = createLogger("research-dispatcher");

export interface ResearchRunDispatcherOptions {
  store: ResearchExecutorStore;
  orchestrator: ResearchOrchestrator;
  tickIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

export class ResearchRunDispatcher {
  // FNXC:ResearchStore 2026-06-28-11:30: store is the sync ResearchStore or the
  // PG-backed AsyncResearchStore union; listRuns is awaited so queued-run polling
  // works in both backends.
  private readonly store: ResearchExecutorStore;
  private readonly orchestrator: ResearchOrchestrator;
  private readonly tickIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /*
  FNXC:ResearchDispatcher 2026-10-06-09:34 (RUFU-588 follow-up):
  Overlap guard for the fixed-interval poll. `start()` fires `void this.tick()` every second, and
  `tick()` awaits `store.listRuns({ status: "queued" })`. With no guard, a slow pool means the next
  interval fires while the previous read is still suspended, so every second adds another in-flight
  read that retains its own async frame and closure. Measured in the live dashboard heap snapshot at
  25 minutes of process life: 1 125 suspended `listResearchRuns` frames and 1 130 suspended `tick`
  frames — about 19 minutes of stacked polls. The pile is self-reinforcing: a slower database stacks
  more ticks, which presses the pool harder, which slows the database.

  Skipping an overlapping tick loses nothing: a skipped pass would have read the same queued set, and
  the very next interval reads again.
  */
  private tickInFlight = false;
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: ResearchRunDispatcherOptions) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.tickIntervalMs = Math.max(100, options.tickIntervalMs ?? 1_000);
    this.shutdownTimeoutMs = Math.max(500, options.shutdownTimeoutMs ?? 5_000);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Research dispatcher stopped"));
    }

    const start = Date.now();
    while (this.inFlight.size > 0 && Date.now() - start < this.shutdownTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.tickInFlight) {
      // A previous pass is still suspended on the store. Skip this interval instead of stacking a
      // second read onto the pool — see the field comment above for the measured pile this caused.
      return;
    }
    this.tickInFlight = true;
    try {
      await this.tickOnce();
    } finally {
      // Cleared on BOTH paths, including a throwing `listRuns`, so one bad read cannot disable the
      // dispatcher for the life of the process.
      this.tickInFlight = false;
    }
  }

  private async tickOnce(): Promise<void> {
    let queuedRuns: ResearchRun[] = [];
    try {
      queuedRuns = await this.store.listRuns({ status: "queued" });
    } catch (error) {
      const { message, detail } = formatError(error);
      log.warn(`Failed to list queued research runs: ${message}\n${detail}`);
      return;
    }

    for (const run of queuedRuns) {
      if (this.inFlight.has(run.id)) continue;
      const controller = new AbortController();
      this.inFlight.add(run.id);
      this.controllers.set(run.id, controller);
      void this.orchestrator
        .startRun(run.id, run.query, { abortSignal: controller.signal })
        .catch((error) => {
          const { message, detail } = formatError(error);
          log.warn(`Failed to dispatch research run ${run.id}: ${message}\n${detail}`);
        })
        .finally(() => {
          this.inFlight.delete(run.id);
          this.controllers.delete(run.id);
        });
    }
  }
}
