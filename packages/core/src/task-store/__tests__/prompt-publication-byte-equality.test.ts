import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { computePlanApprovalFingerprint } from "../../planner/plan-approval.js";
import { BASELINE_PROMPT, createPromptWriteHarness, sha256 } from "./prompt-write-harness.js";

/**
 * RUFU-536 — the byte-equality half of an authoritative publication.
 *
 * A submission may be published byte-for-byte or refused; it may never be rewritten. Four surfaces hash or
 * compare the SAME string — the durable `PROMPT.md`, the `getTask().prompt` read-back, the `plan` database
 * mirror, and the spec-lock evidence hash — so a store that "helpfully" repaired a would-be duplicate before
 * writing would silently break all four at once. This file asserts the write path's side of that contract;
 * `agent-tools.ts`'s read-back check is the tool's half.
 *
 * A refusal must be a total no-op: a caller that gets an error is entitled to find the card exactly as it
 * left it, including a task directory that was never created.
 */
describe("authoritative prompt publication keeps one string everywhere", () => {
  const NEW_PROMPT = [
    "# Replacement spec",
    "",
    "<!-- fusion-original-description:start -->",
    "Operator asked for a replacement.",
    "<!-- fusion-original-description:end -->",
    "",
    "## Mission",
    "",
    "Replace the plan with one clean generation.",
    "",
    "## Steps",
    "",
    "### Step 0: Survey",
    "Read the current state.",
    "### Step 1: Rewrite",
    "Write the replacement.",
    "### Step 2: Confirm",
    "Check it landed.",
    "",
  ].join("\n");

  it("submitted bytes equal the durable file, the read-back, the mirror, and the evidence hash", async () => {
    const harness = createPromptWriteHarness({});
    const beforeFingerprint = computePlanApprovalFingerprint(BASELINE_PROMPT);
    const submitted = NEW_PROMPT + "\n<!-- trailing operator note -->\r\nmixed \n endings";

    const result = await harness.publish(submitted);

    expect(harness.durablePrompt()).toBe(submitted);
    expect(result).toMatchObject({ prompt: submitted });
    expect(harness.task.prompt).toBe(submitted);
    // The mirror and the evidence the lock hashes are computed over the submitted string; identity here is
    // the whole contract — a normalized write would change the hash without changing anything visible.
    expect(sha256(harness.durablePrompt())).toBe(sha256(submitted));
    expect(sha256((result as { prompt: string }).prompt)).toBe(sha256(submitted));
    // And the publication still retires the approval evidence, because the fingerprint is over those bytes.
    expect(computePlanApprovalFingerprint(harness.durablePrompt())).not.toBe(beforeFingerprint);
  });

  it("refuses a would-be duplicate section without touching the durable document, its steps, or its evidence", async () => {
    const harness = createPromptWriteHarness({});
    await harness.publish(BASELINE_PROMPT);
    const durableBefore = harness.durablePrompt();
    const stepsBefore = [...harness.durableSteps()];
    const fingerprintBefore = computePlanApprovalFingerprint(BASELINE_PROMPT);

    const spliced = `${BASELINE_PROMPT}\n## Mission\n\nSecond generation of the same mission.\n### Step 0: Preflight\nAgain.\n`;
    await expect(harness.publish(spliced)).rejects.toThrow(/would contain the "mission" section twice \(mission-duplicate\)/);

    expect(harness.durablePrompt()).toBe(durableBefore);
    expect(harness.durableSteps()).toEqual(stepsBefore);
    expect(harness.task.prompt).toBe(BASELINE_PROMPT);
    expect(computePlanApprovalFingerprint(harness.durablePrompt())).toBe(fingerprintBefore);
  });

  it("refuses a malformed step dependency before the document is written", async () => {
    const harness = createPromptWriteHarness({});
    const malformed = [
      "# Malformed spec",
      "",
      "## Mission",
      "",
      "Nothing may be written for this document.",
      "",
      "## Steps",
      "",
      "### Step 0: Preflight (depends: abc)",
      "A non-numeric coordinate is not a plan.",
      "",
    ].join("\n");

    await expect(harness.publish(malformed)).rejects.toThrow(/depends on invalid step abc \(malformed\)/);
    expect(existsSync(harness.promptPath)).toBe(false);
    expect(harness.task.steps).toHaveLength(4);
  });
});
