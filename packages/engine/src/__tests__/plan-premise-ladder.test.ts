import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import type { PlanPremiseCheckResult } from "../execution/plan-premise-check.js";
import {
  PLAN_PREMISE_EXHAUSTED_PREFIX,
  advancePlanPremiseRejectionEpisode,
  buildPlanPremiseExhaustedError,
  computePlanPremiseRejectionSignature,
  isPlanPremiseParkTerminal,
  readPlanPremiseRejectionEpisode,
} from "../execution/plan-premise-ladder.js";

/*
FNXC:PlanPremises 2026-09-16-03:20:
RUFU-246 — pure-unit coverage for the premise-refusal escalation ladder. The door-level behavior
(hold → needs-replan → park across three identical refusals) lives in hold-release-plan-premises.
test.ts; these tests pin the signature identity rules and episode transition rules that make the
ladder stable against rewrites of unrelated state.
*/

function staleCheck(literals: string[], promptFingerprint = "fp-1"): PlanPremiseCheckResult {
  return {
    outcome: "stale",
    detail: `Plan premises no longer true — ${literals.join(", ")}`,
    promptFingerprint,
    premiseViolations: literals.map((literal) => ({
      premise: { kind: "text-present" as const, path: "App.tsx", literal },
      reason: "literal not found in file",
    })),
  };
}

function taskWithEpisode(episode: unknown): Task {
  return {
    id: "FN-LADDER", column: "todo", status: null, dependencies: [],
    sourceMetadata: episode === undefined ? undefined : { planPremiseRejection: episode },
  } as Task;
}

const NOW = () => new Date("2026-09-16T03:20:00.000Z");

describe("plan premise rejection signature", () => {
  it("is invariant to violation enumeration order and dependency order", () => {
    const a = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["alpha", "beta"]), dependencies: ["FN-A", "FN-B"] });
    const b = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["beta", "alpha"]), dependencies: ["FN-B", "FN-A"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any rejection identity input changes", () => {
    const base = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["alpha"]), dependencies: [] });
    const otherNode = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review-v2", check: staleCheck(["alpha"]), dependencies: [] });
    const otherPrompt = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["alpha"], "fp-2"), dependencies: [] });
    const otherDeps = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["alpha"]), dependencies: ["FN-X"] });
    const otherViolation = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check: staleCheck(["beta"]), dependencies: [] });
    expect(new Set([base, otherNode, otherPrompt, otherDeps, otherViolation]).size).toBe(5);
  });
});

describe("advancePlanPremiseRejectionEpisode", () => {
  it("walks hold → replan → park for one unchanged rejection identity", () => {
    const check = staleCheck(["alpha"]);
    let task = taskWithEpisode(undefined);
    const first = advancePlanPremiseRejectionEpisode(task, { planReviewNodeId: "plan-review", check, now: NOW });
    expect(first).toMatchObject({ escalation: "hold", episode: { refusalCount: 1 } });
    expect(first.episode.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(first.episode.detailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.episode.lastDetail).toBe(check.detail);
    expect(first.episode.lastAt).toBe("2026-09-16T03:20:00.000Z");

    task = taskWithEpisode(first.episode);
    const second = advancePlanPremiseRejectionEpisode(task, { planReviewNodeId: "plan-review", check, now: NOW });
    expect(second).toMatchObject({ escalation: "replan", episode: { refusalCount: 2 } });
    expect(second.resetReason).toBeUndefined();

    task = taskWithEpisode(second.episode);
    const third = advancePlanPremiseRejectionEpisode(task, { planReviewNodeId: "plan-review", check, now: NOW });
    expect(third).toMatchObject({ escalation: "park", episode: { refusalCount: 3 } });
  });

  it("resets the count on signature drift and reports why", () => {
    const first = advancePlanPremiseRejectionEpisode(taskWithEpisode(undefined), { planReviewNodeId: "plan-review", check: staleCheck(["alpha"]), now: NOW });
    const drifted = advancePlanPremiseRejectionEpisode(taskWithEpisode(first.episode), { planReviewNodeId: "plan-review", check: staleCheck(["beta"]), now: NOW });
    expect(drifted).toMatchObject({ escalation: "hold", resetReason: "signature-drift", episode: { refusalCount: 1 } });
    expect(drifted.episode.signature).not.toBe(first.episode.signature);
  });

  it("keeps a parked episode parked instead of reopening the ladder", () => {
    const check = staleCheck(["alpha"]);
    const signature = computePlanPremiseRejectionSignature({ planReviewNodeId: "plan-review", check, dependencies: [] });
    const parked = {
      signature,
      refusalCount: 3,
      lastDetail: check.detail,
      lastAt: "2026-09-15T00:00:00.000Z",
      escalation: "park" as const,
      detailHash: "d".repeat(64),
    };
    const step = advancePlanPremiseRejectionEpisode(taskWithEpisode(parked), {
      planReviewNodeId: "plan-review",
      check,
      now: NOW,
    });
    // A same-identity advance while parked returns the parked episode unchanged — the sticky park
    // never re-counts and never rewrites lastAt/lastDetail.
    expect(step.escalation).toBe("park");
    expect(step.episode).toEqual(parked);
  });

  it("starts a fresh episode when prior durable state is malformed", () => {
    const step = advancePlanPremiseRejectionEpisode(taskWithEpisode({ refusalCount: "two" }), { planReviewNodeId: "plan-review", check: staleCheck(["alpha"]), now: NOW });
    expect(step).toMatchObject({ escalation: "hold", episode: { refusalCount: 1 } });
    expect(readPlanPremiseRejectionEpisode(taskWithEpisode({ refusalCount: "two" }))).toBeNull();
  });
});

describe("terminal park predicates", () => {
  it("recognizes only the full sentinel triple as parked", () => {
    const parked = taskWithEpisode({ signature: "s", refusalCount: 3, lastDetail: "x", lastAt: "t", escalation: "park", detailHash: "d" });
    parked.status = "failed";
    parked.error = `${PLAN_PREMISE_EXHAUSTED_PREFIX} ${buildPlanPremiseExhaustedError("x").slice(PLAN_PREMISE_EXHAUSTED_PREFIX.length + 1)}`;
    expect(isPlanPremiseParkTerminal(parked)).toBe(true);

    const notFailed = { ...parked, status: null };
    expect(isPlanPremiseParkTerminal(notFailed)).toBe(false);
    const wrongError = { ...parked, error: "some other failure" };
    expect(isPlanPremiseParkTerminal(wrongError)).toBe(false);
    const notParkedEpisode = taskWithEpisode({ signature: "s", refusalCount: 2, lastDetail: "x", lastAt: "t", escalation: "replan", detailHash: "d" });
    notParkedEpisode.status = "failed";
    notParkedEpisode.error = parked.error;
    expect(isPlanPremiseParkTerminal(notParkedEpisode)).toBe(false);
  });

  it("builds the operator sentence around the checker detail", () => {
    const sentence = buildPlanPremiseExhaustedError("Plan premises no longer true — alpha");
    expect(sentence.startsWith(`${PLAN_PREMISE_EXHAUSTED_PREFIX} `)).toBe(true);
    expect(sentence).toContain("Plan premises no longer true — alpha");
    expect(sentence).toContain("three times in a row");
  });
});
