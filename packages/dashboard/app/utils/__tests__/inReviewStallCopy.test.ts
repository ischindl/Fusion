import { describe, expect, it } from "vitest";

import { getInReviewStallCopy, shouldShowInReviewStallBadge } from "../inReviewStallCopy";

describe("inReviewStallCopy", () => {
  it.each([
    "merge-blocker",
    "transient-merge-status-no-owner",
    "merge-retries-exhausted",
    "no-worktree-no-merge-confirmed",
  ] as const)("returns populated copy for %s", (code) => {
    const copy = getInReviewStallCopy({
      code,
      reason: "reason",
      observedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(copy.badgeLabel).toBe("Stall");
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
    expect(copy.suggestedAction.length).toBeGreaterThan(0);
  });

  it.each([
    { column: "in-review", paused: false, inReviewStall: undefined },
    {
      column: "in-review",
      paused: true,
      inReviewStall: { code: "merge-blocker", reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
    },
    {
      column: "in-progress",
      paused: false,
      inReviewStall: { code: "merge-blocker", reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
    },
  ] as const)("hides badge for non-canonical visibility cases", (task) => {
    expect(shouldShowInReviewStallBadge(task)).toBe(false);
  });

  it("shows badge only for in-review non-paused task with signal", () => {
    expect(
      shouldShowInReviewStallBadge({
        column: "in-review",
        paused: false,
        inReviewStall: { code: "merge-blocker", reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
      }),
    ).toBe(true);
  });

  it("falls back to defensive default for unknown codes", () => {
    const copy = getInReviewStallCopy({
      code: "future-code" as never,
      reason: "future reason",
      observedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(copy.headline).toBe("In-review stall surfaced");
    expect(copy.description).toBe("future reason");
    expect(copy.suggestedAction).toBe("Open the activity log for details.");
    expect(copy.badgeLabel).toBe("Stall");
  });
});
