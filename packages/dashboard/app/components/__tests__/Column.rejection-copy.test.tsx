import { describe, expect, it } from "vitest";
import { extractTransitionRejection, translateRejection, translateRejectionKey } from "../Column";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-19:35 (RUFU-406):
Copy contract for the complete-column gate-evidence refusal. FN-8471 is the motivating defect, measured in
this file's own history: the server gained a rejection code (`unplanned-for-execution`) with no client case
and no catalog entry, `translateRejection` fell through to `t(messageKey, messageKey)`, and the board printed
the literal `board.rejection.unplannedForExecution` at operators. RUFU-406 adds `gate-evidence-missing`, so
the same trap was available for free. These assertions hold the copy rather than the prose: the cheap way to
satisfy them is the wrong one (re-adding text to shipped source to appease a test), so each case states the
behavior an operator actually sees — real sentences, never a raw key.

The refusal itself is a 409 whose `message` already names the silent gates; the dashboard renders the
translated rejection, so a missing case here would silently downgrade the operator's explanation to a key
while the CLI printed the full sentence. That asymmetry between surfaces is what this test exists to prevent.
*/

const rejection = (code: string, messageKey: string) => ({ code, messageKey, retryable: false });

describe("translateRejection — gate-evidence refusal copy", () => {
  it("resolves the gate-evidence code to a sentence about a gate, not to a merge complaint", () => {
    /*
    `merge-blocked` is the neighbouring code and the wrong copy for this condition: RUFU-389 reached the
    terminal lane with a `plan-review` approval and ZERO `code-review` rows, so its merge diff was fine —
    its GATE was missing. Telling an operator "wait for the merge step" on that card sends them to the
    wrong subsystem, so the two renderings must stay observably different strings.
    */
    const seen = new Map<string, string>();
    const t = (key: string, defaultValue: string) => {
      seen.set(key, defaultValue);
      return defaultValue;
    };

    const gateCopy = translateRejection(t, rejection("gate-evidence-missing", "transition.rejected.gateEvidenceMissing"));
    const mergeCopy = translateRejection(t, rejection("merge-blocked", "transition.rejected.mergeBlocked"));

    expect(gateCopy).toContain("gate");
    expect(gateCopy.toLowerCase()).toContain("verdict");
    expect(gateCopy).not.toBe(mergeCopy);
    // The static literal is what the i18next extractor harvests, so the key must be spelled here.
    expect([...seen.keys()]).toContain("board.rejection.gateEvidenceMissing");
  });

  it("never falls through to the raw messageKey for the codes the move seam can emit", () => {
    /*
    The general invariant behind the FN-8471 case: every code the store can put on a
    `TransitionRejectionError` must resolve to copy. Asserted as a loop over the closed rejection-code
    vocabulary rather than one case per code, so a future code that forgets its case fails here instead of
    shipping a raw key to the board.
    */
    const emittedByStore = [
      "guard-rejected",
      "capacity-exhausted",
      "unknown-column",
      "workflow-mismatch",
      "merge-blocked",
      "gate-evidence-missing",
      "unplanned-for-execution",
      "stale-move-precondition",
    ];
    const t = (_key: string, defaultValue: string) => defaultValue;

    for (const code of emittedByStore) {
      const messageKey = `board.rejection.${code.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())}`;
      const rendered = translateRejection(t, rejection(code, messageKey));
      expect(rendered, `code "${code}" must not render its raw key`).not.toBe(messageKey);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  it("treats a code it has never seen as the generic guard rejection it came from", () => {
    /*
    Boundary of the fallback: an unknown code still renders its own messageKey, which is the shipped
    behaviour for server codes a client build predates. Pinned so widening the switch is a deliberate act
    and the loop above stays the census of store-emitted codes.
    */
    const t = (key: string, _defaultValue: string) => key;
    expect(translateRejection(t, rejection("brand-new-code", "board.rejection.brandNewCode"))).toBe(
      "board.rejection.brandNewCode",
    );
  });
});

describe("extractTransitionRejection — the 409 the move route emits", () => {
  it("reads the structured details a refused move arrives with", () => {
    expect(
      extractTransitionRejection({
        details: { code: "gate-evidence-missing", messageKey: "transition.rejected.gateEvidenceMissing", retryable: false },
      }),
    ).toEqual({
      code: "gate-evidence-missing",
      messageKey: "transition.rejected.gateEvidenceMissing",
      retryable: false,
    });
  });

  it("returns null for the legacy error shape so untouched surfaces keep their old handling", () => {
    expect(extractTransitionRejection(new Error("Invalid transition"))).toBeNull();
    expect(extractTransitionRejection({ details: { code: "gate-evidence-missing" } })).toBeNull();
  });
});

/*
FNXC:ExecutionAdmissionReason 2026-10-18-10:00 (RUFU-718):
`unplanned-for-execution` is ONE wire code carrying six different conditions, and the refusal now says
which one by carrying a reason-specific messageKey. FN-8471 is the failure mode this loop exists to
keep impossible: the server gained a key the client had no case for, `t(key, key)` printed the raw key
on the board, and the operator lost the explanation at the exact moment they needed it. The key strings
below are the same closed set the move and promote routes resolve from
(`UNPLANNED_ADMISSION_MESSAGE_KEYS` in `register-task-workflow-routes.ts`); both sides name them, so a
rename on either side goes red here or there rather than shipping untranslated copy.
*/
const UNPLANNED_REASON_KEYS: Record<string, string> = {
  "plan-review-pending": "board.rejection.unplannedForExecutionPlanReviewPending",
  "human-plan-approval-pending": "board.rejection.unplannedForExecutionHumanApprovalPending",
  "planning-status": "board.rejection.unplannedForExecutionPlanningInFlight",
  "needs-replan": "board.rejection.unplannedForExecutionNeedsReplan",
  "duplicate-prompt": "board.rejection.unplannedForExecutionDuplicateRedirect",
  "seed-prompt": "board.rejection.unplannedForExecutionSeedPrompt",
};
const GENERIC_UNPLANNED_KEY = "board.rejection.unplannedForExecution";

describe("translateRejection — unplanned-for-execution reason copy", () => {
  const t = (_key: string, defaultValue: string) => defaultValue;

  it("renders real copy for every reason key the release routes can emit, never the raw key", () => {
    for (const [reason, messageKey] of Object.entries(UNPLANNED_REASON_KEYS)) {
      const rendered = translateRejection(t, rejection("unplanned-for-execution", messageKey));
      expect(rendered, `reason "${reason}" must not render its raw key`).not.toBe(messageKey);
      expect(rendered.trim().length).toBeGreaterThan(0);
      // The same sentence must come back for the bare drag pre-check path, which carries only a key.
      expect(translateRejectionKey(t, messageKey)).toBe(rendered);
    }
  });

  it("keeps the generic unplanned key as the fallback and never a raw key", () => {
    const generic = translateRejection(t, rejection("unplanned-for-execution", GENERIC_UNPLANNED_KEY));
    expect(generic).not.toBe(GENERIC_UNPLANNED_KEY);
    expect(generic.toLowerCase()).toContain("execution");
    expect(translateRejectionKey(t, GENERIC_UNPLANNED_KEY)).toBe(generic);
    // A key this build has never seen still degrades to the generic sentence, not to a key.
    expect(translateRejection(t, rejection("unplanned-for-execution", "board.rejection.unplannedForExecutionBrandNewReason")))
      .toBe(generic);
  });

  it("says something different for each condition, because each has a different remedy", () => {
    /*
    A pending Plan Review is a gate that will clear itself; a duplicate redirect and a seed prompt are
    cards that were never planned, and a human-approval wait needs the operator's own decision. One
    sentence for all of them sends the operator to the wrong subsystem, so the sentences must stay
    observably distinct strings — asserted pairwise, not by paraphrasing the copy here.
    */
    const seen = new Map<string, string>();
    for (const [reason, messageKey] of Object.entries(UNPLANNED_REASON_KEYS)) {
      seen.set(reason, translateRejection(t, rejection("unplanned-for-execution", messageKey)));
    }
    const distinct = new Set(seen.values());
    expect(distinct.size).toBe(seen.size);

    // The three named pairs whose remedies live in different subsystems.
    expect(seen.get("plan-review-pending")).not.toBe(seen.get("seed-prompt"));
    expect(seen.get("plan-review-pending")).not.toBe(seen.get("duplicate-prompt"));
    expect(seen.get("human-plan-approval-pending")).not.toBe(seen.get("planning-status"));

    // And each sentence names its own cause in words an operator can act on.
    expect(seen.get("plan-review-pending")).toMatch(/plan review/i);
    expect(seen.get("human-plan-approval-pending")).toMatch(/approval/i);
    expect(seen.get("planning-status")).toMatch(/planner|planning/i);
    expect(seen.get("needs-replan")).toMatch(/replan/i);
    expect(seen.get("duplicate-prompt")).toMatch(/duplicate/i);
    expect(seen.get("seed-prompt")).toMatch(/plan/i);
  });
});
