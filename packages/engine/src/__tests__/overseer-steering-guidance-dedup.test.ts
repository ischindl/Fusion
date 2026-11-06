import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  PlannerRecoveryController,
  PLANNER_OVERSEER_GUIDANCE_DEDUPE_MS,
  type PlannerRecoveryHandlers,
} from "../overseer/planner-recovery-controller.js";
import type { OverseerStageObservation, OverseerWatchedStage } from "../overseer/planner-overseer.js";

/*
FNXC:PlannerOversight 2026-11-06-17:30:
RUFU-871 acceptance for bounding the overseer's steering side effect.

The production shape this pins is a card whose executor signal oscillates between a problem signal and a
healthy one every tick: FN-7577 clears the attempt budget on the healthy tick, so the bounded budget can
never fill and the SAME guidance sentence was posted 681 times onto one card (7,898 identical entries across
476 cards; 117,305 copies of one sentence retained in the dashboard heap). Steering must still happen for a
genuinely new episode — it is the byte-identical re-post inside the window that has to stop.
*/

const TICK_MS = 45_000;

function task(): Task {
  return { id: "RUFU-871", title: "t", description: "", column: "in-progress" } as Task;
}

/**
 * Controller whose snapshot is rebuilt per tick from `build(tick, now)`, sharing one clock with the test so
 * `ctx.now()` and the observation always agree.
 */
function makeController(
  build: (tick: number, now: number) => Partial<OverseerStageObservation>,
  handlers: PlannerRecoveryHandlers,
): { controller: PlannerRecoveryController; clock: { ms: number; n: number } } {
  const clock = { ms: 1_700_000_000_000, n: 0 };
  const controller = new PlannerRecoveryController({
    snapshotProvider: {
      getSnapshot: (): OverseerStageObservation => ({
        taskId: "RUFU-871",
        stage: "executor" as OverseerWatchedStage,
        signal: "stuck",
        oversightLevel: "autonomous",
        observedAt: clock.ms,
        reason: "observed",
        sources: [],
        ...build(clock.n, clock.ms),
      }),
    },
    handlers,
  });
  return { controller, clock };
}

/** Advances the shared overseer tick counter and clock, then runs one tick. */
async function tick(
  controller: PlannerRecoveryController,
  clock: { ms: number; n: number },
  advance = TICK_MS,
): Promise<void> {
  clock.n += 1;
  clock.ms += advance;
  await controller.tick(task(), { now: () => clock.ms });
}

async function ticks(
  controller: PlannerRecoveryController,
  clock: { ms: number; n: number },
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await tick(controller, clock);
  }
}

describe("overseer steering guidance dedupe (RUFU-871)", () => {
  it("posts identical executor steering once across an oscillating stuck/progressing stall", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const { controller, clock } = makeController(
      (tickIndex) => ({ signal: tickIndex % 2 === 0 ? "stuck" : "progressing" }),
      { injectGuidance },
    );

    await ticks(controller, clock, 40);

    // 20 problem ticks produced one post. Each healthy tick cleared the budget, so before RUFU-871 every
    // one of those 20 ticks appended a comment.
    expect(injectGuidance).toHaveBeenCalledTimes(1);
    expect(controller.getSuppressedGuidanceCount()).toBe(19);
  });

  it("steers again when the guidance text actually changes", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    // `stuck` and `blocked` render different `decision.reason` strings, so the second carries new text.
    const { controller, clock } = makeController((n) => ({ signal: n <= 1 ? "stuck" : "blocked" }), {
      injectGuidance,
    });

    await ticks(controller, clock, 6);

    expect(injectGuidance).toHaveBeenCalledTimes(2);
    expect(controller.getSuppressedGuidanceCount()).toBe(4);
  });

  it("re-posts the same guidance once the dedupe window has elapsed", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const { controller, clock } = makeController(() => ({ signal: "stuck" }), { injectGuidance });
    const startedAt = clock.ms;

    await tick(controller, clock);
    // Still inside the window: the agent already holds this exact guidance.
    await tick(controller, clock, PLANNER_OVERSEER_GUIDANCE_DEDUPE_MS - 2 * TICK_MS);
    expect(injectGuidance).toHaveBeenCalledTimes(1);

    // A new episode past the window, so the agent is told again.
    await tick(controller, clock, TICK_MS * 2);
    expect(injectGuidance).toHaveBeenCalledTimes(2);
    expect(clock.ms - startedAt).toBeGreaterThan(PLANNER_OVERSEER_GUIDANCE_DEDUPE_MS);
  });

  it("does not burn the bounded attempt budget on a suppressed post", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const { controller, clock } = makeController(() => ({ signal: "stuck" }), { injectGuidance });

    await ticks(controller, clock, 10);

    // One dispatch burned one attempt; the nine suppressed re-posts burned none, leaving the budget for
    // actions that could still change something (retry_step, targeted fix).
    expect(controller.getAttemptCount("RUFU-871", "executor")).toBe(1);
    expect(controller.getSuppressedGuidanceCount()).toBe(9);
  });

  it("suppresses an identical targeted-fix post the same way", async () => {
    const requestTargetedFix = vi.fn().mockResolvedValue(undefined);
    // A failed stage carrying an error source asks for a targeted fix, whose reason is verbatim text too.
    const { controller, clock } = makeController(
      () => ({ signal: "failed", sources: [{ kind: "failed-check", ref: "ci#1" }] }),
      { requestTargetedFix },
    );

    await ticks(controller, clock, 5);

    expect(requestTargetedFix).toHaveBeenCalledTimes(1);
    expect(controller.getSuppressedGuidanceCount()).toBe(4);
  });

  it("leaves retry_step dispatching untouched, since it is not a text post", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const { controller, clock } = makeController(() => ({ signal: "failed" }), { retryStep });

    await ticks(controller, clock, 3);

    expect(retryStep).toHaveBeenCalledTimes(3);
    expect(controller.getSuppressedGuidanceCount()).toBe(0);
  });

  it("retries a guidance post that failed instead of silencing the card", async () => {
    // The window is recorded only after the handler resolves: a throwing store must not cost the card its
    // next 30 minutes of steering for a comment that never landed.
    const injectGuidance = vi.fn().mockRejectedValueOnce(new Error("store unavailable"));
    const { controller, clock } = makeController(() => ({ signal: "stuck" }), { injectGuidance });

    await ticks(controller, clock, 3);

    // Tick 1 threw and recorded nothing, tick 2 landed, tick 3 is the first genuine duplicate.
    expect(injectGuidance).toHaveBeenCalledTimes(2);
    expect(controller.getSuppressedGuidanceCount()).toBe(1);
  });
});
