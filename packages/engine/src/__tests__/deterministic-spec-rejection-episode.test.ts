/*
FNXC:DeterministicSpecRejection 2026-11-08-03:20 (RUFU-485):
Unit coverage for the episode leaf that lets triage recognise "the identical deterministic verdict
twice" (RUFU-485 delivery 2). These are the pure-function halves of the contract; the lane half (a
second identical verdict parks before another session is spent) lives in
`triage-deterministic-spec-identity.test.ts`, and the owner half (the park is re-admitted exactly once
when the spec bytes actually change) in `deterministic-spec-park-ownership.test.ts`.
*/
import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED,
  advanceDeterministicSpecRejectionEpisode,
  buildDeterministicSpecExhaustedError,
  computeDeterministicRejectionIdentity,
  computeSpecFingerprint,
  deterministicSpecRejectionPatch,
  isDeterministicSpecValidationParkError,
  readDeterministicSpecRejectionEpisode,
  readDeterministicSpecRejectionPark,
} from "../healing/deterministic-spec-rejection.js";
import { buildManualRetryResetPatch, DETERMINISTIC_SPEC_REJECTION_METADATA_KEY } from "@fusion/core";

const DIAGNOSTIC = "REVISE — Dangling task-document references in PROMPT.md:\n  - .fusion/tasks/RUFU-482/… (cited in: Steps)";
const SPEC = "# Task: X\n\n## Steps\n\n### Step 0: Preflight\n\n- read the spec\n";

function taskWith(episode: unknown): { sourceMetadata: Record<string, unknown> } {
  return { sourceMetadata: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: episode } };
}

describe("computeSpecFingerprint", () => {
  /*
  ONE normalization, shared by the triage writer and the self-healing reader (RUFU-485). If the two
  lanes normalized differently, every operator edit on disk would read as "unchanged" or every trailing
  newline as "changed", and the owner would either never re-admit or re-admit forever.
  */
  it("maps identical content with and without a trailing newline to one value", () => {
    expect(computeSpecFingerprint(SPEC)).toBe(computeSpecFingerprint(`${SPEC}\n`));
    expect(computeSpecFingerprint(SPEC)).toBe(computeSpecFingerprint(`${SPEC}\n\n\n`));
  });

  it("treats CRLF and LF line endings as the same content", () => {
    expect(computeSpecFingerprint(SPEC.replace(/\n/g, "\r\n")))
      .toBe(computeSpecFingerprint(SPEC));
  });

  it("distinguishes content that changes what the deterministic checker reads", () => {
    expect(computeSpecFingerprint(SPEC)).not.toBe(computeSpecFingerprint(`${SPEC}## Added\n`));
    expect(computeSpecFingerprint(SPEC)).not.toBe(computeSpecFingerprint(SPEC.replace("Preflight", "Preflightx")));
  });
});

describe("computeDeterministicRejectionIdentity", () => {
  it("is stable for the same diagnostic", () => {
    expect(computeDeterministicRejectionIdentity({ diagnostic: DIAGNOSTIC }))
      .toBe(computeDeterministicRejectionIdentity({ diagnostic: DIAGNOSTIC }));
  });

  it("keys on the verdict alone, never on the surrounding spec", () => {
    /*
    The identity is the deterministic ANSWER, not the file it was computed over, because the branch that
    refuses is only reachable when the planner rewrote the artifact (`artifactChangedByAttempt`). A
    fingerprint of the whole spec inside the identity would make every reachable refusal a brand-new
    episode and the bound unreachable over RUFU-482's own shape. The spec fingerprint is carried in the
    episode separately, as the evidence that the INPUT changed.
    */
    expect(computeDeterministicRejectionIdentity({ diagnostic: DIAGNOSTIC }))
      .toBe(computeDeterministicRejectionIdentity({ diagnostic: DIAGNOSTIC }));
    expect(computeDeterministicRejectionIdentity({ diagnostic: "other" }))
      .not.toBe(computeDeterministicRejectionIdentity({ diagnostic: DIAGNOSTIC }));
  });
});

describe("advanceDeterministicSpecRejectionEpisode", () => {
  it("holds on the first refusal and records one count", () => {
    const step = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
      now: () => new Date("2026-11-08T03:00:00.000Z"),
    });
    expect(step.identicalRejection).toBe(false);
    expect(step.episode).toMatchObject({ rejectionCount: 1, escalation: "hold" });
    expect(step.episode.firstAt).toBe("2026-11-08T03:00:00.000Z");
    expect(step.episode.parkedAt).toBeUndefined();
  });

  it("parks on the second identical verdict even when unrelated bytes moved", () => {
    const first = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
      now: () => new Date("2026-11-08T03:00:00.000Z"),
    });
    const second = advanceDeterministicSpecRejectionEpisode(taskWith(first.episode), {
      diagnostic: DIAGNOSTIC,
      specContent: `${SPEC}\nThe planner reworded an unrelated paragraph.\n`,
      now: () => new Date("2026-11-08T03:40:00.000Z"),
    });
    expect(second.identicalRejection).toBe(true);
    expect(second.episode.escalation).toBe("park");
    expect(second.episode.rejectionCount).toBe(2);
    // RUFU-246's discipline: the episode's first observation survives, so the operator can read how
    // long the episode has run, not just when the last copy arrived.
    expect(second.episode.firstAt).toBe("2026-11-08T03:00:00.000Z");
    expect(second.episode.parkedAt).toBe("2026-11-08T03:40:00.000Z");
    // The refused-input fingerprint still advances, so the owner can see the CURRENT bytes.
    expect(second.episode.specFingerprint).toBe(computeSpecFingerprint(`${SPEC}\nThe planner reworded an unrelated paragraph.\n`));
  });

  it("starts a fresh budget when the verdict drifts", () => {
    const first = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const drifted = advanceDeterministicSpecRejectionEpisode(taskWith(first.episode), {
      diagnostic: "REVISE — Missing ## Surface Enumeration section",
      specContent: SPEC,
    });
    expect(drifted.identicalRejection).toBe(false);
    expect(drifted.resetReason).toBe("diagnostic-drift");
    expect(drifted.episode).toMatchObject({ rejectionCount: 1, escalation: "hold" });
  });

  it("buys exactly one fresh attempt when a parked card's spec actually changed", () => {
    /*
    Delivery 3's promise read from the ladder side: the park sentence tells the operator to rewrite the
    spec, so arriving over different bytes must NOT re-park on the spot. The fingerprint is the proof
    that the promised repair happened; the same bytes are not.
    */
    const parkedEpisode = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const repaired = advanceDeterministicSpecRejectionEpisode(taskWith({
      ...parkedEpisode.episode,
      escalation: "park",
      parkedAt: "2026-11-08T04:00:00.000Z",
    }), {
      diagnostic: DIAGNOSTIC,
      specContent: `${SPEC}\nThe operator deleted the refused sentence.\n`,
    });
    expect(repaired.identicalRejection).toBe(false);
    expect(repaired.resetReason).toBe("input-changed");
    expect(repaired.episode).toMatchObject({ rejectionCount: 1, escalation: "hold" });
    expect(repaired.episode.parkedAt).toBeUndefined();
  });

  it("re-parks without inflating the count when a parked card returns over the same bytes", () => {
    const parkedEpisode = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const parkedAgain = advanceDeterministicSpecRejectionEpisode(taskWith({
      ...parkedEpisode.episode,
      escalation: "park",
      rejectionCount: 2,
    }), { diagnostic: DIAGNOSTIC, specContent: SPEC, now: () => new Date("2026-11-09T00:00:00.000Z") });
    expect(parkedAgain.identicalRejection).toBe(true);
    expect(parkedAgain.episode.rejectionCount).toBe(2);
    expect(parkedAgain.episode.lastAt).not.toBe("2026-11-09T00:00:00.000Z");
  });

  it("preserves a repair stamp across a re-refusal so the owner cannot re-admit twice", () => {
    const first = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const afterRepair = advanceDeterministicSpecRejectionEpisode(taskWith({
      ...first.episode,
      escalation: "park",
      staleSpecFingerprint: computeSpecFingerprint(SPEC),
    }), { diagnostic: DIAGNOSTIC, specContent: SPEC });
    // Same bytes, already repaired once: the stamp survives so the sweep's no-action arm can see it.
    expect(afterRepair.episode.staleSpecFingerprint).toBe(computeSpecFingerprint(SPEC));
  });

  /*
  FNXC:DeterministicSpecRejection 2026-11-08-04:18 (RUFU-485):
  RUFU-246's discipline for this lane's park. RUFU-395 proved that a park keyed on a durable register is
  only liftable if the Retry clears the register too: a Retry that strips the visible disposition and
  leaves the count standing re-parks the card on the very next refusal, which reads to the operator as a
  Retry that silently did nothing. So this asserts the two halves TOGETHER - the real `buildManualRetryResetPatch`
  (not a copy of its key list) applied with the store's key-level merge - and then that the next refusal
  is counted as a first refusal rather than the third.
  */
  it("restarts refusals at 1 after an operator Retry, instead of instantly re-parking", () => {
    const first = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const parked = advanceDeterministicSpecRejectionEpisode(taskWith(first.episode), {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    expect(parked.episode.escalation).toBe("park");
    // Precondition: the park predicate is satisfied, so this test would fail if the clear did nothing.
    const error = buildDeterministicSpecExhaustedError({ attempts: 2, diagnostic: DIAGNOSTIC });
    expect(readDeterministicSpecRejectionPark({ status: "failed", error, sourceMetadata: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: parked.episode } }))
      .not.toBeNull();

    // The Retry write, reproduced the way `TaskStore` applies it: key-level merge, null deletes.
    const retriedSourceMetadata = { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: parked.episode } as Record<string, unknown>;
    for (const [key, value] of Object.entries(buildManualRetryResetPatch().sourceMetadataPatch ?? {})) {
      if (value === null) delete retriedSourceMetadata[key];
      else retriedSourceMetadata[key] = value;
    }

    // Half one: no episode to read, so the park predicate is dead even while the sentinel sentence stands.
    expect(readDeterministicSpecRejectionEpisode({ sourceMetadata: retriedSourceMetadata })).toBeNull();
    expect(readDeterministicSpecRejectionPark({ status: "failed", error, sourceMetadata: retriedSourceMetadata }))
      .toBeNull();

    // Half two: the next identical refusal is a FIRST refusal, not the third in a row.
    const afterRetry = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: retriedSourceMetadata }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    expect(afterRetry.identicalRejection).toBe(false);
    expect(afterRetry.episode).toMatchObject({ rejectionCount: 1, escalation: "hold" });
    expect(afterRetry.episode.parkedAt).toBeUndefined();
  });
});

describe("readDeterministicSpecRejectionEpisode", () => {
  it("fails open on a malformed episode rather than short-circuiting on a corrupt read", () => {
    expect(readDeterministicSpecRejectionEpisode(taskWith({ rejectionCount: 2 }))).toBeNull();
    expect(readDeterministicSpecRejectionEpisode(taskWith("nonsense"))).toBeNull();
    expect(readDeterministicSpecRejectionEpisode(taskWith(null))).toBeNull();
    expect(readDeterministicSpecRejectionEpisode(undefined)).toBeNull();
  });
});

describe("park error sentence", () => {
  it("names only remedies some lane can actually perform, and no retired demand", () => {
    const error = buildDeterministicSpecExhaustedError({ attempts: 2, diagnostic: DIAGNOSTIC });
    expect(error.startsWith(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED)).toBe(true);
    expect(error).toContain("fn_task_prompt_write");
    expect(error).toContain("fn_task_update");
    expect(error).toContain("operator can edit the on-disk PROMPT.md");
    expect(error).toContain("re-admitted automatically once its spec changes");
    // The demand FN-9512 retired must not be resurrected through this lane's own sentence.
    expect(error).not.toMatch(/retry\s+after\s+adjusting/i);
    // Counts, not an unbounded transcript: the diagnostic is quoted once, bounded by the checker itself.
    expect(error).toContain("2 consecutive attempts");
  });

  it("is recognized by the one discriminator every reader uses", () => {
    const error = buildDeterministicSpecExhaustedError({ attempts: 2, diagnostic: DIAGNOSTIC });
    expect(isDeterministicSpecValidationParkError(error)).toBe(true);
    expect(isDeterministicSpecValidationParkError("PLANNING_RESEED_CYCLE_EXHAUSTED: ...")).toBe(false);
    expect(isDeterministicSpecValidationParkError(null)).toBe(false);
    expect(isDeterministicSpecValidationParkError(undefined)).toBe(false);
  });
});

describe("deterministicSpecRejectionPatch", () => {
  it("writes KEY-level so unrelated sourceMetadata provenance keys survive", () => {
    const step = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: {} }, {
      diagnostic: DIAGNOSTIC,
      specContent: SPEC,
    });
    const patch = deterministicSpecRejectionPatch(step.episode);
    expect(Object.keys(patch.sourceMetadataPatch)).toEqual([DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]);
    expect("sourceMetadata" in patch).toBe(false);
  });
});
