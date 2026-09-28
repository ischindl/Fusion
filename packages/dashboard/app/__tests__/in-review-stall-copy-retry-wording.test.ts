/*
FNXC:InReviewStallBadge 2026-09-28-18:56:
`completed-review-status-none` is emitted only when `mergeRetries === 0`
(packages/core/src/tasks/in-review-stall.ts), so any copy for it that mentions a retry is false by
construction. Measured the same day: 26 saneca `in-review` cards wore a "Merge retry stalled" badge
while the real condition was a Code Review row that died with no authored verdict, and the badge sent
the operator to merge-retry tooling that had never run. This asserts the invariant on the copy object
— not a string literal from source — and pins the retry wording where it IS true so the guard cannot
pass by deleting all retry language.
*/
import { describe, expect, it } from "vitest";
import { getInReviewStallCopy } from "../utils/inReviewStallCopy";

const signal = (code: Parameters<typeof getInReviewStallCopy>[0]["code"]) => ({
  code,
  reason: `stalled: ${code}`,
  observedAt: "2026-09-28T10:00:00.000Z",
});

describe("in-review stall copy names the state it actually describes", () => {
  it("never calls a zero-retry stall a retry", () => {
    const copy = getInReviewStallCopy(signal("completed-review-status-none"), { mergeRetries: 0 });
    const stateProse = [copy.badgeLabel, copy.headline].join(" ");
    const description = copy.description;

    // The badge/headline describe the STATE; they may not claim a retry, which never ran.
    expect(stateProse).not.toMatch(/retr/i);
    expect([copy.badgeLabel, copy.headline, description, copy.suggestedAction].join(" "))
      .not.toMatch(/retr(i(es)? )?stall/i);
    // It must still say what an operator can see: review finished, nothing merged, no retry ran.
    expect(copy.badgeLabel).toBe("Review not merged");
    expect(description).toMatch(/zero merge retries/i);
    expect(description).toMatch(/verdict/i);
  });

  it("keeps the retry wording on the code where retries actually ran out", () => {
    const copy = getInReviewStallCopy(signal("merge-retries-exhausted"), { mergeRetries: 3 });
    expect(copy.badgeLabel).toMatch(/retries/i);
    expect(copy.counter).toBe("3/3");
  });
});
