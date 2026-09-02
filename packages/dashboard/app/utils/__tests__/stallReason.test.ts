import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type {
  InReviewStallSignal,
  StalePausedReviewSignal,
  StalledReviewSignal,
  TaskExternalBlock,
} from "@fusion/core";

import {
  PAUSE_REASON_LABELS,
  resolveStallReason,
  isPausedFamilyCode,
  type StallReason,
  type StallSubject,
} from "../stallReason";
import { getInReviewStallCopy } from "../inReviewStallCopy";
import { getStalePausedReviewCopy } from "../stalePausedReviewCopy";

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
These tests assert the resolver's CONTRACT the way the surrounding copy tests do — by the recorded
(t("key", "defaultString")) pairs, NOT by the rendered string. String equality would only prove the
English default happens to match; the (key, default) pair is what proves the copy reaches the
translator through the intended key. The stub below records each call and still interpolates
`{{token}}` so parameterized copy (the blocking task id, an unknown pause reason) can be asserted to
carry its runtime data.
*/

type RecordedCall = { key: string; fallback: string; resolved: string };

function makeT() {
  const calls: RecordedCall[] = [];
  const t = ((key: string, arg?: unknown, opts?: unknown) => {
    let fallback: string;
    let interpolation: Record<string, unknown> | undefined;
    if (typeof arg === "string") {
      fallback = arg;
      interpolation = (opts as Record<string, unknown> | undefined) ?? undefined;
    } else if (arg && typeof arg === "object") {
      interpolation = arg as Record<string, unknown>;
      fallback = typeof (arg as { defaultValue?: unknown }).defaultValue === "string"
        ? ((arg as { defaultValue: string }).defaultValue)
        : key;
    } else {
      fallback = key;
    }
    let resolved = fallback;
    if (interpolation) {
      for (const [name, value] of Object.entries(interpolation)) {
        resolved = resolved.split(`{{${name}}}`).join(String(value));
      }
    }
    calls.push({ key, fallback, resolved });
    return resolved;
  }) as unknown as TFunction<"app">;
  const call = (key: string) => calls.find((c) => c.key === key);
  const keys = () => calls.map((c) => c.key);
  return { t, calls, call, keys };
}

const ISO_T = "2026-01-01T00:00:00.000Z";
const T_MS = Date.parse(ISO_T);

function subject(over: Partial<StallSubject> = {}): StallSubject {
  return { column: "in-progress", updatedAt: ISO_T, ...over };
}

function fullExternalBlock(): TaskExternalBlock {
  return {
    origin: "model-provider",
    code: "quota",
    message: "provider quota exhausted",
    source: "session-failure",
    blockedAt: ISO_T,
    resume: { column: "in-progress", currentStep: 2 },
  };
}

const stalledReview: StalledReviewSignal = {
  reason: "review re-enqueued 6 times without progress",
  heuristic: "reenqueue-churn",
  matchCount: 6,
  firstMatchAt: ISO_T,
  lastMatchAt: ISO_T,
};

describe("resolveStallReason — flow and precedence", () => {
  it("returns undefined for a flowing card and never asks the translator for stall copy", () => {
    const { t, calls } = makeT();
    const result = resolveStallReason(subject({ status: "in-progress" }), { t });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does NOT read a plain queued card as a stall (symptom a): no queuedReason -> undefined", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ status: "todo", column: "todo" }), { t })).toBeUndefined();
  });

  it("lets an external block outrank every other concurrent signal", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({
        status: "blocked",
        externalBlock: fullExternalBlock(),
        // Everything else a lower-precedence classifier would also claim:
        paused: true,
        userPaused: true,
        pausedByAgentId: "agent-1",
        blockedBy: "FN-9",
        stalledReview,
      }),
      { t, mergeBlockerReason: "would-lose", completionBlockerReason: "would-lose-too" },
    );
    expect(result?.code).toBe("external-block");
    expect(result?.resumeTo).toBe("in-progress");
    expect(call("stall.external-block.badgeLabel")).toMatchObject({ fallback: "Blocked" });
  });

  it("orders the paused family agent-paused > user-paused > engine-paused", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ paused: true, userPaused: true, pausedByAgentId: "a" }), { t })?.code).toBe("agent-paused");
    expect(resolveStallReason(subject({ paused: true, userPaused: true }), { t })?.code).toBe("user-paused");
    expect(resolveStallReason(subject({ paused: true }), { t })?.code).toBe("engine-paused");
  });

  /*
  FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
  The dashboard renders `userPaused` as paused even when the engine did not also set `paused` (the
  surfaces' isPaused gate reads `paused || userPaused`). The resolver must agree, or a card the UI shows
  as paused would classify as flowing and answer "why isn't it moving?" with nothing. The badge label
  still resolves through the caller's tasks.paused key with the identical default, so the overlay is
  byte-identical to the pre-resolver inline label.
  */
  it("classifies a userPaused overlay (no engine `paused` flag) as user-paused, byte-identical badge", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: undefined, userPaused: true }), { t });
    expect(result?.code).toBe("user-paused");
    expect(call("tasks.paused")).toMatchObject({ fallback: "paused" });
  });

  it("treats an agent owner with a userPaused overlay as agent-paused (agent wins)", () => {
    const { t } = makeT();
    const result = resolveStallReason(subject({ paused: undefined, userPaused: true, pausedByAgentId: "agent-1" }), { t });
    expect(result?.code).toBe("agent-paused");
  });

  it("reports a pause (not a wedge) when both apply, per precedence", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({
        paused: true,
        wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T },
      }),
      { t },
    );
    expect(result?.code).toBe("engine-paused");
  });

  it("reports a context blocker ahead of a review-lane signal", () => {
    const { t } = makeT();
    const signal: InReviewStallSignal = { code: "merge-retries-exhausted", reason: "r", observedAt: ISO_T };
    const result = resolveStallReason(subject({ inReviewStall: signal }), { t, mergeBlockerReason: "pre-merge check" });
    expect(result?.code).toBe("merge-blocker");
  });

  it("reports failed ahead of queued but behind every review-lane signal", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ status: "failed", error: "boom", queuedReason: "x" }), { t })?.code).toBe("failed");
    const review: StallReason | undefined = resolveStallReason(
      subject({ status: "failed", stalledReview }),
      { t },
    );
    expect(review?.code).toBe("stalled-review");
  });
});

describe("resolveStallReason — pause family (byte-identity via (key, default))", () => {
  it("duplicate-decision reuses tasks.needsUserFeedback with its exact default", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "agent-x" } }),
      { t },
    );
    expect(result?.code).toBe("duplicate-decision");
    expect(call("tasks.needsUserFeedback")).toMatchObject({ fallback: "Needs your decision" });
  });

  it("a duplicate card whose reason string is set but WITHOUT duplicate provenance is NOT duplicate-decision", () => {
    const { t } = makeT();
    // pausedReason set to the duplicate marker but no sourceMetadata marker -> falls through to engine-paused.
    const result = resolveStallReason(subject({ paused: true, pausedReason: "duplicate-decision-required" }), { t });
    expect(result?.code).toBe("engine-paused");
  });

  it("agent-paused reuses tasks.pausedByAgent and the budget key, and carries ageMs from dataAsOfMs", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ paused: true, pausedByAgentId: "agent-1", pausedReason: "budget-exhausted" }),
      { t, dataAsOfMs: T_MS + 5000 },
    );
    expect(result?.code).toBe("agent-paused");
    expect(call("tasks.pausedByAgent")).toMatchObject({ fallback: "paused by agent" });
    expect(call("stall.pausedReason.budget-exhausted.headline")).toMatchObject({ fallback: "Output budget exhausted" });
    expect(result?.ageMs).toBe(5000);
  });

  it("agent-paused honours the pausedBadgeKeys override (ListView keeps listView.pausedByAgent)", () => {
    const { t, call } = makeT();
    resolveStallReason(
      subject({ paused: true, pausedByAgentId: "agent-1" }),
      { t, pausedBadgeKeys: { agentPaused: "listView.pausedByAgent" } },
    );
    // Key is the caller's; the English default stays byte-identical so zh divergence is the only delta.
    expect(call("listView.pausedByAgent")).toMatchObject({ fallback: "paused by agent" });
  });

  it("duplicate-decision honours the pausedBadgeKeys.needsDecision override", () => {
    const { t, call } = makeT();
    resolveStallReason(
      subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { nearDuplicateOf: "FN-1" } }),
      { t, pausedBadgeKeys: { needsDecision: "custom.needsDecision" } },
    );
    expect(call("custom.needsDecision")).toMatchObject({ fallback: "Needs your decision" });
  });

  it("user-paused reuses tasks.paused and the plain no-reason headline", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, userPaused: true }), { t });
    expect(result?.code).toBe("user-paused");
    expect(call("tasks.paused")).toMatchObject({ fallback: "paused" });
    expect(call("stall.paused.headline")).toMatchObject({ fallback: "This card is paused" });
  });

  it("engine-paused names an enumerated reason (heartbeat-unresponsive)", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, pausedReason: "heartbeat-unresponsive" }), { t });
    expect(result?.code).toBe("engine-paused");
    expect(call("stall.pausedReason.heartbeat-unresponsive.headline")).toMatchObject({ fallback: "Heartbeat unresponsive" });
  });

  it("an unenumerated pausedReason falls back to the generic headline that names the raw code", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ paused: true, pausedReason: "some-engine-park-reason" }), { t });
    expect(result?.code).toBe("engine-paused");
    const recorded = call("stall.pausedReason.generic.headline");
    expect(recorded).toBeDefined();
    // The recorded default is the interpolation template; the resolved string must carry the raw code.
    expect(recorded!.resolved).toContain("some-engine-park-reason");
  });

  it("a table-known but unenumerated reason renders its humanized word via the generic template", () => {
    const { t, call } = makeT();
    resolveStallReason(subject({ paused: true, pausedReason: "manual" }), { t });
    expect(call("stall.pausedReason.generic.headline")!.resolved).toContain(PAUSE_REASON_LABELS["manual"]);
  });

  it("isPausedFamilyCode classifies the four pause codes and rejects the rest", () => {
    expect(isPausedFamilyCode("agent-paused")).toBe(true);
    expect(isPausedFamilyCode("user-paused")).toBe(true);
    expect(isPausedFamilyCode("engine-paused")).toBe(true);
    expect(isPausedFamilyCode("duplicate-decision")).toBe(true);
    expect(isPausedFamilyCode("wedge")).toBe(false);
    expect(isPausedFamilyCode("failed")).toBe(false);
  });

  it("PAUSE_REASON_LABELS covers the documented Step-1 inventory", () => {
    for (const code of [
      "error-unrecoverable",
      "error-retry-exhausted",
      "awaiting-approval",
      "heartbeat-model-unavailable",
      "heartbeat-unresponsive",
      "budget-exhausted",
      "migrated-from-terminated",
      "manual",
      "user-requested",
      "testing",
      "duplicate-decision-required",
    ]) {
      expect(PAUSE_REASON_LABELS[code], `label for ${code}`).toBeTruthy();
    }
  });
});

describe("resolveStallReason — reused pause-key defaults are byte-identical", () => {
  it.each([
    ["tasks.pausedByAgent", "paused by agent"],
    ["tasks.paused", "paused"],
    ["tasks.needsUserFeedback", "Needs your decision"],
  ] as const)("records %s with default %j", (key, expectedDefault) => {
    const { t, call } = makeT();
    if (key === "tasks.pausedByAgent") {
      resolveStallReason(subject({ paused: true, pausedByAgentId: "agent-1" }), { t });
    } else if (key === "tasks.paused") {
      resolveStallReason(subject({ paused: true }), { t });
    } else {
      resolveStallReason(
        subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "a" } }),
        { t },
      );
    }
    expect(call(key)?.fallback).toBe(expectedDefault);
  });
});

describe("resolveStallReason — non-pause codes reach the translator", () => {
  it("agent-approval when the agent has a pending approval", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ status: "in-progress" }), { t, agent: { pendingApprovalCount: 2 } });
    expect(result?.code).toBe("agent-approval");
    expect(call("stall.agent-approval.badgeLabel")).toMatchObject({ fallback: "Awaiting approval" });
  });

  /*
  FNXC:StallReason 2026-09-02-15:52 (RUFU-175):
  The engine's approval gate writes `pauseReason: "awaiting-approval"` on the agent and NO count, while
  `pendingApprovalCount` is a separate API-route enrichment. Both must classify on their own, otherwise a
  board payload that carries only the pause reason reads as flowing while an approval is outstanding.
  */
  it("agent-approval from the agent's pauseReason alone, with no approval count", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "paused", pauseReason: "awaiting-approval" } },
    );
    expect(result?.code).toBe("agent-approval");
    expect(call("stall.agent-approval.headline")).toMatchObject({
      fallback: "A tool call is waiting for your approval",
    });
  });

  it("a non-approval agent pause reason with no count stays flowing", () => {
    const { t } = makeT();
    const result = resolveStallReason(
      subject({ status: "in-progress" }),
      { t, agent: { state: "paused", pauseReason: "budget-exhausted" } },
    );
    expect(result).toBeUndefined();
  });

  it("wedge (active) uses its supplied descriptor prose and computes ageMs; resolved wedge is skipped", () => {
    const { t, call } = makeT();
    const active = resolveStallReason(
      subject({
        wedgeNotification: {
          reasonKey: "wedge-review",
          episodeId: "e1",
          status: "active",
          transitionedAt: ISO_T,
          pending: { since: ISO_T, reasonKey: "wedge-review", source: "supplied", reason: "review never dispatched", action: "Re-dispatch the review" },
        },
      }),
      { t, dataAsOfMs: T_MS + 3000 },
    );
    expect(active?.code).toBe("wedge");
    expect(active?.description).toBe("review never dispatched");
    expect(active?.suggestedAction).toBe("Re-dispatch the review");
    expect(active?.ageMs).toBe(3000);
    expect(call("stall.wedge.badgeLabel")).toMatchObject({ fallback: "Stuck" });

    const resolved = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "resolved", transitionedAt: ISO_T } }),
      { t },
    );
    expect(resolved).toBeUndefined();
  });

  it("wedge without a descriptor asks the translator for a generic description", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }),
      { t },
    );
    expect(result?.description).toBe("A durable stuck-state hold is in place on this card.");
    expect(call("stall.wedge.description")).toMatchObject({ fallback: "A durable stuck-state hold is in place on this card." });
  });

  it("dependency-block names the blocking task id on the face (symptom c)", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ blockedBy: "FN-42" }), { t });
    expect(result?.code).toBe("dependency-block");
    expect(call("stall.dependency-block.headline")!.resolved).toContain("FN-42");
    expect(call("stall.dependency-block.badgeLabel")).toMatchObject({ fallback: "Blocked" });
  });

  it("overlap-block names the overlapping task id", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ overlapBlockedBy: "FN-7" }), { t });
    expect(result?.code).toBe("overlap-block");
    expect(call("stall.overlap-block.headline")!.resolved).toContain("FN-7");
  });

  it("dependency-block outranks overlap-block when both edges exist", () => {
    const { t } = makeT();
    expect(resolveStallReason(subject({ blockedBy: "FN-1", overlapBlockedBy: "FN-2" }), { t })?.code).toBe("dependency-block");
  });

  it("merge-blocker / completion-blocker carry the context reason verbatim", () => {
    const { t, call } = makeT();
    const merge = resolveStallReason(subject(), { t, mergeBlockerReason: "pre-merge check 'lint' failed" });
    expect(merge?.code).toBe("merge-blocker");
    expect(merge?.description).toBe("pre-merge check 'lint' failed");
    expect(call("stall.merge-blocker.badgeLabel")).toMatchObject({ fallback: "Merge blocked" });

    const completion = resolveStallReason(subject(), { t, completionBlockerReason: "awaiting validation" });
    expect(completion?.code).toBe("completion-blocker");
    expect(completion?.description).toBe("awaiting validation");
  });

  it("failed carries the captured error and asks the translator for its badge", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ status: "failed", error: "tool timeout" }), { t });
    expect(result?.code).toBe("failed");
    expect(result?.description).toBe("tool timeout");
    expect(call("stall.failed.badgeLabel")).toMatchObject({ fallback: "Failed" });
  });

  it("queued only fires on an asserted queuedReason and reuses tasks.queued", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ queuedReason: "waiting for an execution slot" }), { t });
    expect(result?.code).toBe("queued");
    expect(call("tasks.queued")).toMatchObject({ fallback: "Queued" });
    expect(result?.description).toBe("waiting for an execution slot");
  });
});

describe("resolveStallReason — review-lane delegation is one authority", () => {
  it("in-review-stall returns exactly getInReviewStallCopy's fields (no re-authored copy)", () => {
    const { t } = makeT();
    const signal: InReviewStallSignal = { code: "merge-retries-exhausted", reason: "merge stalled", observedAt: ISO_T };
    const expected = getInReviewStallCopy(signal);
    const result = resolveStallReason(subject({ inReviewStall: signal }), { t });
    expect(result?.code).toBe("in-review-stall");
    expect(result?.badgeLabel).toBe(expected.badgeLabel);
    expect(result?.headline).toBe(expected.headline);
    expect(result?.description).toBe(expected.description);
    expect(result?.suggestedAction).toBe(expected.suggestedAction);
  });

  it("stale-paused-review returns exactly getStalePausedReviewCopy's fields", () => {
    const { t } = makeT();
    const signal: StalePausedReviewSignal = {
      code: "stale-paused-review",
      reason: "paused in review beyond threshold",
      observedAt: ISO_T,
      ageMs: 10,
      thresholdMs: 5,
    };
    const expected = getStalePausedReviewCopy(signal);
    // stale-paused-review sits below the pause family; exercise the delegate with a non-paused subject.
    const result = resolveStallReason(subject({ stalledReview: undefined, stalePausedReview: signal }), { t });
    expect(result?.code).toBe("stale-paused-review");
    expect(result?.badgeLabel).toBe(expected.badgeLabel);
    expect(result?.headline).toBe(expected.headline);
  });

  it("stalled-review localizes its own badge and shows the signal reason verbatim", () => {
    const { t, call } = makeT();
    const result = resolveStallReason(subject({ stalledReview }), { t });
    expect(result?.code).toBe("stalled-review");
    expect(call("stall.stalled-review.badgeLabel")).toMatchObject({ fallback: "Stalled review" });
    expect(result?.description).toBe(stalledReview.reason);
  });
});

describe("resolveStallReason — age never consults the wall clock when dataAsOfMs is given", () => {
  it("computes ageMs purely from updatedAt/transitionedAt and dataAsOfMs", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const { t } = makeT();
    const paused = resolveStallReason(subject({ paused: true }), { t, dataAsOfMs: T_MS + 1234 });
    expect(paused?.ageMs).toBe(1234);
    const wedge = resolveStallReason(
      subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }),
      { t, dataAsOfMs: T_MS + 999 },
    );
    expect(wedge?.ageMs).toBe(999);
    expect(nowSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("resolveStallReason — every emitted code asks the translator for at least one key", () => {
  // The two verbatim review-lane delegates (in-review-stall, stale-paused-review) intentionally reuse
  // their English copy modules unchanged (a pre-existing localization debt, not new copy), so they are
  // excluded from the "did it call t" check and instead asserted equal to their module above.
  const localizedCodes: Record<string, () => { subject: StallSubject; ctx?: Parameters<typeof resolveStallReason>[1] }> = {
    externalBlock: () => ({ subject: subject({ status: "blocked", externalBlock: fullExternalBlock() }), ctx: undefined }),
    duplicateDecision: () => ({ subject: subject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: { duplicateSource: "a" } }) }),
    agentPaused: () => ({ subject: subject({ paused: true, pausedByAgentId: "a" }) }),
    userPaused: () => ({ subject: subject({ paused: true, userPaused: true }) }),
    enginePaused: () => ({ subject: subject({ paused: true, pausedReason: "budget-exhausted" }) }),
    agentApproval: () => ({ subject: subject({ status: "in-progress" }), ctx: { agent: { pendingApprovalCount: 1 } } as never }),
    wedge: () => ({ subject: subject({ wedgeNotification: { reasonKey: "k", episodeId: "e", status: "active", transitionedAt: ISO_T } }) }),
    dependencyBlock: () => ({ subject: subject({ blockedBy: "FN-1" }) }),
    overlapBlock: () => ({ subject: subject({ overlapBlockedBy: "FN-2" }) }),
    mergeBlocker: () => ({ subject: subject(), ctx: { mergeBlockerReason: "m" } as never }),
    completionBlocker: () => ({ subject: subject(), ctx: { completionBlockerReason: "c" } as never }),
    stalledReview: () => ({ subject: subject({ stalledReview }) }),
    failed: () => ({ subject: subject({ status: "failed", error: "e" }) }),
    queued: () => ({ subject: subject({ queuedReason: "q" }) }),
  };

  for (const [label, make] of Object.entries(localizedCodes)) {
    it(`${label} records at least one translated key`, () => {
      const { t, calls } = makeT();
      const fixture = make();
      const ctx = (fixture.ctx ?? {}) as Parameters<typeof resolveStallReason>[1];
      const result = resolveStallReason(fixture.subject, { ...ctx, t });
      expect(result).toBeDefined();
      expect(calls.length, `${label} produced no translator call`).toBeGreaterThan(0);
    });
  }
});
