/*
FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343):
The classifier is the only authorisation for the stale-content recovery lane, so its whole contract
lives in this file: which pause provenance admits a card, which refuses it, and which marker inside
the error names the shape. It runs with NO mocks at all on purpose — the classifier's answer must
not depend on a mocked door, because the defect this change fixes was invisible behind exactly one
such mock (`stale-content-park-recovery.test.ts` supplied `getTaskMergeBlocker` itself).
*/
import { describe, expect, it } from "vitest";
import {
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  STALE_CONTENT_APPROVAL_BLOCKER,
  type Task,
} from "@fusion/core";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX, classifyStaleContentPark } from "../merge/stale-content-park.js";

type ParkInput = Parameters<typeof classifyStaleContentPark>[0];

const rawBlocker = `Cannot merge RUFU-301: ${STALE_CONTENT_APPROVAL_BLOCKER}`;
const retryRejected = `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${rawBlocker}`;
/* The RUFU-301 measured shape: the stall watchdog wrote its own sentence in front of the merged
   auto-merge refusal, then parked the card. RUFU-343 reworded the middle of that sentence to name the
   evidence it counts, so this constant carries today's wording. */
const stallWrapped = `In-review stall deadlock: merge-blocker — 4 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). ${retryRejected}`;
/*
FNXC:InReviewStallAttribution 2026-10-09-22:41 (RUFU-343):
The park sentence a card carries was written by whichever build parked it, so production rows mix
pre- and post-rewording wording permanently. Admission must not care which: it keys on the pause
provenance plus `IN_REVIEW_STALL_DEADLOCK_ERROR_PREFIX`, never on the count segment. This fixture is
the superseded shape and stays in the suite to keep that byte-for-byte, because it is also the reason
other lanes' older fixtures remain valid inputs.
*/
const stallWrappedPreReword = `In-review stall deadlock: merge-blocker repeated 4× without progress. ${retryRejected}`;

const parkedCard = (overrides: Record<string, unknown> = {}): ParkInput => ({
  status: "failed",
  error: stallWrapped,
  paused: true,
  userPaused: false,
  pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  ...overrides,
}) as ParkInput;

describe("classifyStaleContentPark pause provenance", () => {
  it("admits the engine's own review-stall deadlock park", () => {
    expect(classifyStaleContentPark(parkedCard())).toBe("stall-deadlock");
  });

  it("admits a park written before the count-segment rewording identically", () => {
    expect(classifyStaleContentPark(parkedCard({ error: stallWrappedPreReword }))).toBe("stall-deadlock");
  });

  it("still refuses an operator pause, a user override, and a deleted card", () => {
    const vetoes: Array<[string, Record<string, unknown>]> = [
      ["a hand pause (no reason)", { paused: true, pausedReason: undefined }],
      ["a hand pause (other reason)", { pausedReason: "manual-hold" }],
      ["a capacity pause", { pausedReason: "capacity-paused" }],
      ["an unrelated pause reason that is not in the reason union", { pausedReason: "something-invented" }],
      ["a user override of the deadlock park", { userPaused: true }],
      ["a soft-deleted card", { deletedAt: "2026-10-04T00:00:00.000Z" }],
    ];
    for (const [label, overrides] of vetoes) {
      expect(classifyStaleContentPark(parkedCard(overrides)), label).toBeUndefined();
    }
  });

  it("refuses a park whose error was overwritten by a later failure", () => {
    expect(classifyStaleContentPark(parkedCard({ error: "Unrelated later failure" }))).toBeUndefined();
    // The canonical predicate admits a park with no error sentence at all; the classifier still has
    // to refuse it, because with no stale-content sentence there is no stale-content park.
    expect(classifyStaleContentPark(parkedCard({ error: undefined }))).toBeUndefined();
  });

  it("keeps non-paused cards classifying exactly as before", () => {
    const cases: Array<[string, ParkInput, string | undefined]> = [
      ["retry-rejected", { status: "failed", error: retryRejected }, "retry-rejected"],
      ["raw-blocker", { status: "failed", error: rawBlocker }, "raw-blocker"],
      ["retry-exhausted", { status: null, error: rawBlocker }, "retry-exhausted"],
      ["an active merge status", { status: "merging", error: rawBlocker }, undefined],
      ["the paused status", { status: "paused", error: rawBlocker }, undefined],
      ["an unrelated refusal", { status: "failed", error: "AUTO_MERGE_RETRY_FAILED: nope" }, undefined],
      ["a rejected non-stale refusal", {
        status: "failed",
        error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} Cannot merge FN-1: task is marked 'needs-replan'`,
      }, undefined],
      ["a malformed error", { status: "failed", error: 42 }, undefined],
    ];
    for (const [label, input, expected] of cases) {
      expect(classifyStaleContentPark(input), label).toBe(expected);
    }
  });
});

describe("classifyStaleContentPark marker position (wrap tolerance)", () => {
  it("reads a wrapped retry marker as retry-rejected instead of raw-blocker", () => {
    // Same wrapped sentence, no pause: the shape still has to name the terminal that wrote it.
    expect(classifyStaleContentPark({ status: "failed", error: stallWrapped } as ParkInput))
      .toBe("retry-rejected");
  });

  it("keeps a raw blocker raw when a stale-content marker precedes any retry marker", () => {
    /*
    The door matches a stale park by `endsWith`, so a container may repeat the sentence. Rule: the
    FIRST embedded marker decides the shape, and a stale-content marker ahead of any retry marker
    stays a raw blocker — the retry text after it is commentary, not the authoring terminal.
    */
    const staleFirst = `Cannot merge RUFU-301: ${STALE_CONTENT_APPROVAL_BLOCKER}. ${retryRejected}`;
    expect(classifyStaleContentPark({ status: "failed", error: staleFirst } as ParkInput)).toBe("raw-blocker");
  });

  it("keeps a park that carries no retry marker a raw blocker", () => {
    expect(classifyStaleContentPark({ status: "failed", error: rawBlocker } as ParkInput)).toBe("raw-blocker");
  });

  it("never invents a shape for an error with no stale-content sentence", () => {
    expect(classifyStaleContentPark({
      status: "failed",
      error: `In-review stall deadlock: merge-blocker — 4 identical in-review stall observations in one unchanged episode (stall observations, not merge attempts). task is paused`,
    } as ParkInput)).toBeUndefined();
  });
});
