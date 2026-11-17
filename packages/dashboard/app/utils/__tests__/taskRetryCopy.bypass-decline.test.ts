import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { ReviewBypassDeclineReason } from "@fusion/core";
import { resolveReviewBypassDeclineHint } from "../taskRetryCopy";

/*
FNXC:ReviewBypassDecline 2026-11-17-18:50 (RUFU-583, folded from RUFU-243):
ONE SENTENCE PER REFUSAL CLASS, AND NO TWO CLASSES SHARE ONE — this is the contract RUFU-243 was folded in
to deliver, and it lives in its own file so it cannot be merged into the waiver-copy contract next door:
the waiver file (RUFU-599) states what an operator is OFFERED, this one states what an operator is REFUSED.
Two different operator questions, two separately failing tests, per the operator's fold-in instruction.

Why an assertion and not a copy review: six classes decline this affordance and every one of them used to
arrive as the absence of a row, which is how "the board cannot read your workflow" became indistinguishable
from "nothing is refusing this card". A sentence that fits two classes is a sentence that lies about one of
them, so distinctness is the property under test, in both directions: distinct i18n key (so a translated
catalog can never collapse two classes onto one string) and distinct default English text.

Every sentence also has to carry its own remedy: an operator staring at a refused action needs the next
action, not a description of the door. That is asserted as "at least two sentences", which is how the
earlier draft's bare `this card is paused` — true for a hold, actively false for an engine park that is
still bypassable — would have failed review.
*/

/**
 * Compile-time totality over the union: `Record<ReviewBypassDeclineReason, string>` refuses to typecheck
 * the moment a class is added to core without its own copy key and its own case here. That is the ratchet
 * the acceptance criterion asks for — "adding a class without copy fails a test" — and it is why this list
 * is a mapped literal rather than an array of strings an author could silently leave short.
 */
const COPY_KEY_BY_REASON: Record<ReviewBypassDeclineReason, string> = {
  "operator-task-hold": "taskDetail.bypassReview.decline.operatorTaskHold",
  "not-in-review-lane": "taskDetail.bypassReview.decline.notInReviewLane",
  "no-refusing-gate": "taskDetail.bypassReview.decline.noRefusingGate",
  "post-merge-review-not-owed": "taskDetail.bypassReview.decline.postMergeReviewNotOwed",
  "workspace-scope-withheld": "taskDetail.bypassReview.decline.workspaceScopeWithheld",
  "workflow-ir-unreadable": "taskDetail.bypassReview.decline.workflowIrUnreadable",
};

/** Two `t`s, so both halves of distinctness are observable: the catalog key asked for, and the text shipped. */
const tKeyAndText = ((key: string, fallback: string) => `${key}::${fallback}`) as unknown as TFunction<"app">;
const tText = ((_key: string, fallback: string) => String(fallback)) as unknown as TFunction<"app">;

describe("resolveReviewBypassDeclineHint — one class, one sentence (RUFU-583)", () => {
  it("says nothing when the server derived no decline at all", () => {
    // The absence half: a healthy card must not gain ambient copy on its menu.
    expect(resolveReviewBypassDeclineHint(tKeyAndText, undefined)).toBeUndefined();
  });

  it("asks for its own i18n key per class, so no translation catalog can merge two refusals", () => {
    for (const [reason, key] of Object.entries(COPY_KEY_BY_REASON)) {
      const hint = resolveReviewBypassDeclineHint(tKeyAndText, { reason: reason as ReviewBypassDeclineReason });
      expect(hint?.sentence.split("::")[0], reason).toBe(key);
    }
    const asked = Object.keys(COPY_KEY_BY_REASON).map(
      (reason) => resolveReviewBypassDeclineHint(tKeyAndText, { reason: reason as ReviewBypassDeclineReason })?.sentence.split("::")[0],
    );
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("words every class distinctly, and never reuses another class's sentence as its own", () => {
    const sentences = Object.keys(COPY_KEY_BY_REASON).map(
      (reason) => resolveReviewBypassDeclineHint(tText, { reason: reason as ReviewBypassDeclineReason })?.sentence ?? "",
    );
    for (const [index, sentence] of sentences.entries()) {
      const reason = Object.keys(COPY_KEY_BY_REASON)[index];
      expect(sentence, reason).not.toBe("");
      // A refusal with no next step is the dead end this card exists to remove.
      expect(sentence.split(". ").length, reason).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const [outer, a] of sentences.entries()) {
      for (const [inner, b] of sentences.entries()) {
        if (outer === inner) continue;
        // A copy-paste with a tacked-on tail still contains the original sentence.
        expect(a.includes(b), `${Object.keys(COPY_KEY_BY_REASON)[outer]} contains ${Object.keys(COPY_KEY_BY_REASON)[inner]}`).toBe(false);
      }
    }
  });

  it("points the two most confusable classes at different actors", () => {
    const sentence = (reason: ReviewBypassDeclineReason) =>
      resolveReviewBypassDeclineHint(tText, { reason })?.sentence ?? "";
    // A hand-held card is waiting on the operator; a card whose gates all passed is waiting on nothing.
    expect(sentence("operator-task-hold")).toMatch(/[Uu]npause/);
    expect(sentence("no-refusing-gate")).not.toMatch(/[Uu]npause/);
    // The unreadable-workflow class names the workflow, which no other class may claim to be about.
    expect(sentence("workflow-ir-unreadable")).toMatch(/workflow/i);
    expect(sentence("post-merge-review-not-owed")).toMatch(/post-merge/i);
    expect(sentence("workspace-scope-withheld")).toMatch(/repositor/i);
  });

  it("explains rather than goes silent when the payload names a class this build does not know", () => {
    /*
    A newer daemon behind an older dashboard ships a reason literal this bundle's switch never saw. Returning
    `undefined` there would reproduce RUFU-243's original defect from the other direction — a recorded refusal
    rendered as a bare absence — so the fallback arm speaks, and its text is asserted to be nobody's sentence.
    */
    const unknown = resolveReviewBypassDeclineHint(tText, { reason: "gate-requires-two-reviewers" as ReviewBypassDeclineReason });
    expect(unknown?.sentence).toBeTruthy();
    expect(unknown?.sentence).toMatch(/does not describe/);
    const known = Object.keys(COPY_KEY_BY_REASON).map(
      (reason) => resolveReviewBypassDeclineHint(tText, { reason: reason as ReviewBypassDeclineReason })?.sentence,
    );
    expect(known).not.toContain(unknown?.sentence);
  });
});
