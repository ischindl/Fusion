import { describe, expect, it } from "vitest";
import {
  applyPlannerSteeringDelivery,
  asPlannerSteeringEpisode,
  deriveSteeringReasonClass,
  deriveSteeringSignature,
  evaluatePlannerSteeringEpisode,
  withPlannerSteeringNotice,
} from "../planner/planner-steering-episode.js";
import { PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS, PLANNER_RECOVERY_MAX_ATTEMPTS } from "../planner/planner-recovery.js";
import type { PlannerOversightSteeringEpisode } from "../types.js";

/*
FNXC:PlannerOversight 2026-11-11-11:25 (RUFU-586):
The arithmetic that bounds the planner overseer re-posting ITS OWN instruction. These cases are the whole
contract of the durable episode, and they are pure - no store, no clock injection gymnastics - because the
engine ledger around them owns only reading and writing this value.

The shape under test exists because three ordinary production events used to lower the only bound that
existed (an in-memory attempt count in `PlannerRecoveryController`: restart, healthy signal, stage change),
which is how one card reached 77 identical steering comments in ~20 h against a documented cap of 3.
*/

const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const cap = PLANNER_RECOVERY_MAX_ATTEMPTS;

function sig(over: Partial<{ action: string; stage: string; reason: string }> = {}): string {
  return deriveSteeringSignature({
    action: over.action ?? "inject_guidance",
    stage: over.stage ?? "executor",
    reason: over.reason ?? "Executor stage inactive for over 3h with no execution activity",
  });
}

function episode(over: Partial<PlannerOversightSteeringEpisode> = {}): PlannerOversightSteeringEpisode {
  return {
    signature: sig(),
    deliveredCount: 1,
    firstAt: new Date(T0).toISOString(),
    lastAt: new Date(T0).toISOString(),
    ...over,
  };
}

describe("deriveSteeringSignature", () => {
  it("does NOT depend on hour-bucket churn in the reason (the RUFU-442 key-stability trap)", () => {
    const at3h = deriveSteeringSignature({
      action: "inject_guidance",
      stage: "executor",
      reason: "Executor stage inactive for over 3h with no execution activity",
    });
    const at7h = deriveSteeringSignature({
      action: "inject_guidance",
      stage: "executor",
      reason: "Executor stage inactive for over 7h  with  no execution activity",
    });
    expect(at7h).toBe(at3h);
    expect(deriveSteeringReasonClass("inactive for over 3h, retry 12 of 40")).toBe("inactive for over Nh, retry N of N");
  });

  it("does NOT change when a number crosses into another digit count", () => {
    // 9 → 10 and 59m → 60m are clock ticks, not new information. Per-digit substitution would fail here
    // ("Nh" vs "NNh"); a digit RUN collapsing to one N is what makes the key stable.
    const nine = deriveSteeringSignature({ action: "inject_guidance", stage: "planning", reason: "Reason: 9h elapsed" });
    const ten = deriveSteeringSignature({ action: "inject_guidance", stage: "planning", reason: "Reason: 10h elapsed" });
    expect(ten).toBe(nine);
    const m41 = deriveSteeringSignature({ action: "inject_guidance", stage: "planning", reason: "Reason: 41m elapsed" });
    const m97 = deriveSteeringSignature({ action: "inject_guidance", stage: "planning", reason: "Reason: 97m elapsed" });
    expect(m97).toBe(m41);
  });

  it("DOES change when the reason genuinely differs", () => {
    const staleBranch = deriveSteeringSignature({
      action: "inject_guidance",
      stage: "planning",
      reason: 'Stale branch commit "a1b2c3d Initial commit" is not on main',
    });
    const executorIdle = deriveSteeringSignature({
      action: "inject_guidance",
      stage: "executor",
      reason: "Executor stage inactive for over 3h with no execution activity",
    });
    expect(staleBranch).not.toBe(executorIdle);
    expect(staleBranch).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates the watched stage, so a reviewer's steering never spends an executor's budget", () => {
    const executor = deriveSteeringSignature({ action: "inject_guidance", stage: "executor", reason: "same reason" });
    const gate = deriveSteeringSignature({ action: "inject_guidance", stage: "workflow-gate", reason: "same reason" });
    expect(executor).not.toBe(gate);
  });

  it("separates the action, so a targeted fix never spends a guidance budget", () => {
    const guidance = deriveSteeringSignature({ action: "inject_guidance", stage: "executor", reason: "same reason" });
    const fix = deriveSteeringSignature({ action: "request_targeted_fix", stage: "executor", reason: "same reason" });
    expect(guidance).not.toBe(fix);
  });

  it("is total: empty and missing inputs still produce a stable digest and never throw", () => {
    expect(() => deriveSteeringSignature({ action: "", stage: "", reason: "" })).not.toThrow();
    expect(deriveSteeringSignature({ action: "a", stage: "b", reason: undefined as unknown as string })).toBe(
      deriveSteeringSignature({ action: "a", stage: "b", reason: "" }),
    );
  });
});

describe("evaluatePlannerSteeringEpisode", () => {
  it("delivers when the card carries no episode at all", () => {
    const result = evaluatePlannerSteeringEpisode(null, { signature: sig(), now: T0 });
    expect(result.verdict).toBe("deliver");
    expect(result.basis).toBe("fresh");
    expect(result.allowed).toBe(true);
    expect(result.deliveredCountAfter).toBe(1);
  });

  it("delivers and starts a fresh budget when the signature differs - new information for the agent", () => {
    const prior = episode({ signature: sig({ reason: "a completely different problem" }), deliveredCount: 3 });
    const result = evaluatePlannerSteeringEpisode(prior, { signature: sig(), now: T0 + MIN });
    expect(result.verdict).toBe("deliver");
    expect(result.basis).toBe("reason-changed");
    expect(result.deliveredCount).toBe(0);
    expect(result.deliveredCountAfter).toBe(1);
    expect(result.startsNewEpisode).toBe(true);
  });

  it("delivers and INCREMENTS while the episode is under the cap", () => {
    for (let delivered = 1; delivered < cap; delivered += 1) {
      const result = evaluatePlannerSteeringEpisode(episode({ deliveredCount: delivered }), {
        signature: sig(),
        now: T0 + delivered * MIN,
      });
      expect(result.verdict, `deliveredCount=${delivered}`).toBe("deliver");
      expect(result.basis).toBe("cooldown");
      expect(result.deliveredCountAfter).toBe(delivered + 1);
      expect(result.startsNewEpisode).toBe(false);
    }
  });

  it("refuses at the cap while the cooldown is still running", () => {
    const spent = episode({ deliveredCount: cap });
    for (const elapsed of [MIN, 30 * MIN, 5 * HOUR, PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS - MIN]) {
      const result = evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 + elapsed });
      expect(result.verdict, `elapsed=${elapsed}`).toBe("suppress");
      expect(result.basis).toBe("cap-reached");
      expect(result.allowed).toBe(false);
      expect(result.budgetExhausted).toBe(true);
      expect(result.deliveredCountAfter).toBe(cap);
    }
  });

  it("re-arms once the cooldown has elapsed since the LAST delivery", () => {
    const spent = episode({ deliveredCount: cap, lastAt: new Date(T0).toISOString() });
    const before = evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 + PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS - 1 });
    const at = evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 + PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS });
    expect(before.verdict).toBe("suppress");
    expect(at.verdict).toBe("re-arm");
    expect(at.basis).toBe("cooldown-elapsed");
    expect(at.allowed).toBe(true);
    expect(at.deliveredCountAfter).toBe(1);
    expect(at.startsNewEpisode).toBe(true);
  });

  it("measures the cooldown from `lastAt`, never from `firstAt`", () => {
    // Episode opened 26h ago but its last delivery was 1h ago: still inside the cooldown.
    const spent = episode({
      deliveredCount: cap,
      firstAt: new Date(T0 - 26 * HOUR).toISOString(),
      lastAt: new Date(T0 - HOUR).toISOString(),
    });
    expect(evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 }).verdict).toBe("suppress");
  });

  it("honours an explicit cap and cooldown so a caller can tighten them without a new constant", () => {
    const spent = episode({ deliveredCount: 2 });
    expect(evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0, cap: 2 }).verdict).toBe("suppress");
    expect(evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0, cap: 3 }).verdict).toBe("deliver");
    expect(
      evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 + HOUR, cap: 2, cooldownMs: 2 * HOUR }).verdict,
    ).toBe("suppress");
    expect(
      evaluatePlannerSteeringEpisode(spent, { signature: sig(), now: T0 + 3 * HOUR, cap: 2, cooldownMs: 2 * HOUR }).verdict,
    ).toBe("re-arm");
  });

  it("degrades to a fresh delivery on a corrupt episode rather than throwing or silencing a stuck card", () => {
    const corrupt: unknown[] = [
      "not-an-object",
      42,
      [],
      {},
      { signature: "", deliveredCount: 1, lastAt: new Date(T0).toISOString() },
      { signature: sig(), deliveredCount: -3, lastAt: new Date(T0).toISOString() },
      { signature: sig(), deliveredCount: "3", lastAt: new Date(T0).toISOString() },
      { signature: sig(), deliveredCount: 1, lastAt: "not-a-date" },
      { signature: sig(), deliveredCount: Number.NaN, lastAt: new Date(T0).toISOString() },
    ];
    for (const value of corrupt) {
      const result = evaluatePlannerSteeringEpisode(value as PlannerOversightSteeringEpisode | null, {
        signature: sig(),
        now: T0,
      });
      expect(result.verdict, JSON.stringify(value)).toBe("deliver");
      expect(result.basis).toBe("fresh");
      expect(result.allowed).toBe(true);
    }
  });

  it("ignores a corrupt `prior` entry instead of trusting it or crashing on it", () => {
    const withBadPrior = {
      ...episode(),
      prior: [
        { signature: sig({ reason: "garbage" }), deliveredCount: Number.NaN, firstAt: "nope", lastAt: "nope" },
        { signature: sig({ reason: "good" }), deliveredCount: cap, firstAt: new Date(T0).toISOString(), lastAt: new Date(T0).toISOString() },
      ],
    } as unknown as PlannerOversightSteeringEpisode;
    // The garbage entry cannot grant a budget...
    expect(
      evaluatePlannerSteeringEpisode(withBadPrior, { signature: sig({ reason: "garbage" }), now: T0 }).basis,
    ).toBe("reason-changed");
    // ...and the parseable one is still honoured as spent.
    expect(
      evaluatePlannerSteeringEpisode(withBadPrior, { signature: sig({ reason: "good" }), now: T0 + MIN }).verdict,
    ).toBe("suppress");
  });

  it("tolerates a missing or non-finite clock instead of deciding from NaN", () => {
    const spent = episode({ deliveredCount: cap });
    for (const now of [undefined, Number.NaN, null] as unknown as number[]) {
      expect(() => evaluatePlannerSteeringEpisode(spent, { signature: sig(), now })).not.toThrow();
      expect(evaluatePlannerSteeringEpisode(spent, { signature: sig(), now }).allowed).toBe(true);
    }
  });
});

describe("applyPlannerSteeringDelivery", () => {
  it("writes a one-based first budget for a card that had none", () => {
    const next = applyPlannerSteeringDelivery(null, { signature: sig(), now: T0 });
    expect(next).toEqual({
      signature: sig(),
      deliveredCount: 1,
      firstAt: new Date(T0).toISOString(),
      lastAt: new Date(T0).toISOString(),
      prior: [],
    });
  });

  it("increments an in-budget repeat and keeps the episode clock", () => {
    const prior = episode({ deliveredCount: 2 });
    const next = applyPlannerSteeringDelivery(prior, { signature: sig(), now: T0 + 5 * MIN });
    expect(next.deliveredCount).toBe(3);
    expect(next.firstAt).toBe(prior.firstAt);
    expect(next.lastAt).toBe(new Date(T0 + 5 * MIN).toISOString());
  });

  it("restarts the count AND the clock on a re-arm, so `firstAt` stays meaningful", () => {
    const spent = episode({ deliveredCount: cap, lastAt: new Date(T0).toISOString() });
    const now = T0 + PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS;
    const next = applyPlannerSteeringDelivery(spent, { signature: sig(), now });
    expect(next.deliveredCount).toBe(1);
    expect(next.firstAt).toBe(new Date(now).toISOString());
    expect(next.lastAt).toBe(new Date(now).toISOString());
    // A restarted budget may announce itself once again.
    expect(next.noticeRecordedAt).toBeUndefined();
  });

  it("restarts the count on a reason change and carries no stale signature", () => {
    const other = sig({ reason: "another problem entirely" });
    const prior = episode({ signature: other, deliveredCount: cap });
    const next = applyPlannerSteeringDelivery(prior, { signature: sig(), now: T0 + MIN });
    expect(next.signature).toBe(sig());
    expect(next.deliveredCount).toBe(1);
  });

  it("keeps the PREVIOUS instruction's spent budget alive, so oscillation cannot refill it", () => {
    // This is the shape a single-slot budget lost: `reasonForSignal` alternates "stuck"/"blocked" for one
    // stall, and if the old budget were overwritten, each flip would look like a first-ever delivery.
    const stuck = sig({ reason: "Signal: `stuck`" });
    const blocked = sig({ reason: "Signal: `blocked`" });
    let stored = applyPlannerSteeringDelivery(null, { signature: stuck, now: T0 });
    stored = applyPlannerSteeringDelivery(stored, { signature: blocked, now: T0 + MIN });

    expect(stored.signature).toBe(blocked);
    expect((stored.prior ?? []).map((entry) => entry.signature)).toContain(stuck);
    // Both budgets are one delivery deep and neither can be refilled by flipping back and forth.
    for (let i = 0; i < 8; i += 1) {
      const now = T0 + (2 + i) * MIN;
      const target = i % 2 === 0 ? stuck : blocked;
      const decision = evaluatePlannerSteeringEpisode(stored, { signature: target, now });
      if (decision.allowed) stored = applyPlannerSteeringDelivery(stored, { signature: target, now });
    }
    const counts = [stored, ...(stored.prior ?? [])].filter((e) => e.signature === stuck || e.signature === blocked);
    for (const entry of counts) expect(entry.deliveredCount).toBeLessThanOrEqual(cap);
  });

  it("caps how many instructions one card tracks, newest-first", () => {
    let stored: PlannerOversightSteeringEpisode | null = null;
    for (let i = 0; i < 12; i += 1) {
      // Letters, not numbers: digits normalise to `N`, so a test that varied only a number would be
      // asserting against twelve identical signatures.
      const signature = sig({ reason: `distinct reason letter ${String.fromCharCode(97 + i)}` });
      stored = applyPlannerSteeringDelivery(stored, { signature, now: T0 + i * MIN });
      expect([stored.signature, ...(stored.prior ?? [])].length).toBeLessThanOrEqual(4);
    }
    // The two oldest reasons are gone; the four most recent are still held.
    const held = new Set([stored!.signature, ...(stored!.prior ?? []).map((entry) => entry.signature)]);
    expect(held.has(sig({ reason: "distinct reason letter a" }))).toBe(false);
    expect(held.has(sig({ reason: "distinct reason letter l" }))).toBe(true);
    expect(held.size).toBe(4);
  });

  it("carries the notice stamp forward across in-budget repeats only", () => {
    const stamped = withPlannerSteeringNotice(episode({ deliveredCount: 1 }), T0 + MIN)!;
    expect(stamped.noticeRecordedAt).toBe(new Date(T0 + MIN).toISOString());
    const repeat = applyPlannerSteeringDelivery(stamped, { signature: sig(), now: T0 + 2 * MIN });
    expect(repeat.noticeRecordedAt).toBe(stamped.noticeRecordedAt);
    const reArm = applyPlannerSteeringDelivery(episode({ deliveredCount: cap, lastAt: new Date(T0).toISOString() }), {
      signature: sig(),
      now: T0 + PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS,
    });
    expect(reArm.noticeRecordedAt).toBeUndefined();
  });

  it("refuses to stamp a notice onto a budget that does not exist", () => {
    expect(withPlannerSteeringNotice(null, T0)).toBeNull();
    expect(withPlannerSteeringNotice({ signature: "x" } as unknown as PlannerOversightSteeringEpisode, T0)).toBeNull();
  });

  it("preserves the other budgets when stamping a notice", () => {
    const stuck = sig({ reason: "Signal: `stuck`" });
    const blocked = sig({ reason: "Signal: `blocked`" });
    let stored = applyPlannerSteeringDelivery(null, { signature: stuck, now: T0 });
    stored = applyPlannerSteeringDelivery(stored, { signature: blocked, now: T0 + MIN });
    const stamped = withPlannerSteeringNotice(stored, T0 + 2 * MIN)!;
    expect(stamped.noticeRecordedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect((stamped.prior ?? []).map((entry) => entry.signature)).toContain(stuck);
  });

  /*
  FNXC:PlannerOversight 2026-11-12-14:54 (RUFU-586 review F-2):
  The refusal notice can name an instruction whose budget sits in `prior`. Promotion used to be recomputed by
  the engine ledger from a copy of this slot rule; these cases are what make the ONE rule observable, so a
  future edit to the survivor list cannot quietly diverge between the notice write and the delivery write.
  */
  it("promotes a prior budget into the active slot when the refusal names it", () => {
    const stuck = sig({ reason: "Signal: `stuck`" });
    const blocked = sig({ reason: "Signal: `blocked`" });
    let stored = applyPlannerSteeringDelivery(null, { signature: stuck, now: T0 });
    stored = applyPlannerSteeringDelivery(stored, { signature: blocked, now: T0 + MIN });
    expect(stored.signature).toBe(blocked); // the active slot is the newest instruction

    const stamped = withPlannerSteeringNotice(stored, T0 + 2 * MIN, stuck)!;
    expect(stamped.signature).toBe(stuck);
    expect(stamped.noticeRecordedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(stamped.deliveredCount).toBe(1);
    // The displaced instruction survives as the only prior budget - nothing is duplicated or dropped.
    expect((stamped.prior ?? []).map((entry) => entry.signature)).toEqual([blocked]);
  });

  it("keeps the survivor list identical when the refusal names the active budget itself", () => {
    const stuck = sig({ reason: "Signal: `stuck`" });
    const blocked = sig({ reason: "Signal: `blocked`" });
    let stored = applyPlannerSteeringDelivery(null, { signature: stuck, now: T0 });
    stored = applyPlannerSteeringDelivery(stored, { signature: blocked, now: T0 + MIN });

    const stamped = withPlannerSteeringNotice(stored, T0 + 2 * MIN, blocked)!;
    expect(stamped.signature).toBe(blocked);
    expect(stamped.noticeRecordedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect((stamped.prior ?? []).map((entry) => entry.signature)).toEqual([stuck]);
  });

  it("will NOT invent a budget for a promoted signature the card never tracked", () => {
    const stored = applyPlannerSteeringDelivery(null, { signature: sig(), now: T0 });
    const stamped = withPlannerSteeringNotice(stored, T0 + MIN, "ffffffffffffffff")!;
    expect(stamped.signature).toBe(stored!.signature);
    expect(stamped.deliveredCount).toBe(stored!.deliveredCount);
    expect(stamped.prior).toEqual(stored!.prior ?? undefined);
  });

  it("will NOT suppress anything on a value it never wrote (a failed post leaves no trace)", () => {
    // The engine only calls apply() after a real delivery, so an episode that stayed `null` must keep
    // reading as "deliver" no matter how many attempts the controller made.
    for (let i = 0; i < 40; i += 1) {
      expect(evaluatePlannerSteeringEpisode(null, { signature: sig(), now: T0 + i * MIN }).allowed).toBe(true);
    }
  });
});

describe("asPlannerSteeringEpisode", () => {
  it("reads back only a value it can trust", () => {
    const good = episode();
    expect(asPlannerSteeringEpisode(good)).toEqual(good);
    expect(asPlannerSteeringEpisode(undefined)).toBeNull();
    expect(asPlannerSteeringEpisode({ signature: sig(), deliveredCount: 1 })).toBeNull();
  });
});

describe("RUFU-286 reproduction (77 comments in ~20h) against the pure arithmetic", () => {
  /** Posts one instruction per problem tick for 77 ticks across ~20 h, exactly as the poll loop does. */
  function flood(signaturesForTick: (i: number) => string, ticks: number, windowMs: number) {
    const stepMs = Math.floor(windowMs / ticks);
    let stored: PlannerOversightSteeringEpisode | null = null;
    const delivered: { at: number; signature: string }[] = [];
    for (let i = 0; i < ticks; i += 1) {
      const now = T0 + i * stepMs;
      const signature = signaturesForTick(i);
      const decision = evaluatePlannerSteeringEpisode(stored, { signature, now });
      if (!decision.allowed) continue;
      delivered.push({ at: now, signature });
      stored = applyPlannerSteeringDelivery(stored, { signature, now });
    }
    return { stored, delivered };
  }

  /** The invariant the task states: no instruction exceeds its cap inside any cooldown-length window. */
  function assertWindowBounded(delivered: { at: number; signature: string }[]) {
    for (const row of delivered) {
      const peers = delivered.filter(
        (other) =>
          other.signature === row.signature &&
          other.at >= row.at &&
          other.at < row.at + PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS,
      );
      expect(peers.length, `${row.signature} @ ${new Date(row.at).toISOString()}`).toBeLessThanOrEqual(
        PLANNER_RECOVERY_MAX_ATTEMPTS,
      );
    }
  }

  it("bounds a single stalled instruction far below the 77 that actually shipped", () => {
    const signature = sig();
    const { delivered } = flood(() => signature, 77, 20 * HOUR);

    expect(delivered.length).toBeLessThan(15);
    assertWindowBounded(delivered);
    // The suppression is what makes it quiet: the overwhelming majority of ticks posted nothing.
    expect(delivered.length).toBeLessThan(77 / 5);
  });

  it("bounds the shape the byte-equality guards cannot absorb: reason text that alternates every tick", () => {
    // `reasonForSignal` renders "Signal: `stuck`" vs "Signal: `blocked`" for one stall. On main that
    // alternation wrote one comment per tick (measured 24 in 24), because neither the 30-min in-memory
    // window nor the store's newest-entry equality matches text that keeps changing.
    const texts = ["Signal: `stuck`", "Signal: `blocked`"];
    const { stored, delivered } = flood((i) => deriveSteeringSignature({ action: "inject_guidance", stage: "executor", reason: texts[i % 2] }), 24, 24 * 45_000);

    expect(delivered.length).toBeLessThan(24);
    assertWindowBounded(delivered);
    // Each distinct instruction still gets its own honest budget (so a genuinely new problem IS reported),
    // and both budgets survive on the card for the next reader.
    const held = [stored!.signature, ...(stored!.prior ?? []).map((entry) => entry.signature)];
    expect(new Set(held).size).toBeGreaterThan(1);
  });

  it("survives a restart, a clear(), and a healthy-signal flap because the budgets are the stored value", () => {
    // The controller's `attempts` Map and RUFU-871's `guidancePostedAt` are not in this picture at all:
    // the ledger reads and writes only the card, which is why none of the three resets can refill a budget.
    const signature = sig();
    let stored = applyPlannerSteeringDelivery(null, { signature, now: T0 });
    stored = applyPlannerSteeringDelivery(stored, { signature, now: T0 + MIN });
    stored = applyPlannerSteeringDelivery(stored, { signature, now: T0 + 2 * MIN });
    // Budget spent. Neither "the process restarted" nor "the signal looked healthy for a tick" is a state
    // this module can perform - only a delivery is.
    for (let restart = 0; restart < 3; restart += 1) {
      for (let tick = 0; tick < 5; tick += 1) {
        const now = T0 + (3 + restart * 5 + tick) * MIN;
        expect(evaluatePlannerSteeringEpisode(stored, { signature, now }).allowed).toBe(false);
      }
    }
  });
});

describe("declared policy", () => {
  it("steering cooldown is the repo's notice-cooldown convention (6h), not a new number", () => {
    expect(PLANNER_OVERSIGHT_STEERING_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("reuses the documented recovery cap rather than inventing a second one", () => {
    expect(PLANNER_RECOVERY_MAX_ATTEMPTS).toBe(3);
  });
});
