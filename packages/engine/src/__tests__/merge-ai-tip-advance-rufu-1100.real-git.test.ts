/*
FNXC:AIMergeTipAdvance 2026-11-21-17:13 (RUFU-1100):
Symptom Verification RUFU-1100. Measured on card RUFU-702 at `main` tip `aa683491eb` on 2026-11-18: three
rebuilds, two approved squashes discarded, zero landings in 2h20m. Every pass that met a moved integration
tip threw away the approved candidate and the retry race with it, because one predicate compared
(base tip, candidate head, source head, source branch, finding ledger) as a single identity and a moved
`base tip` is not the same fact as a replaced source head.

The whole fix turns on ONE discriminator: what the reviewer approved is the PATCH, not the commit that
carried it. These tests pin that discriminator against real git plumbing rather than against log prose,
because it is the only claim in the fix that a future refactor could quietly invert — comparing trees or
candidate SHAs again would keep every other test green and restore the livelock.

Pinned here:
1. The same contribution replayed onto a newer tip keeps one `patch-id --stable` while its tree and its
   base both change — so a bare tip advance must carry the episode, not wipe it.
2. A rebuilt candidate whose CONTENT differs gets a different patch-id — credit is earned by identity,
   never granted unconditionally.
3. An unmeasurable comparison answers `undefined`, and `undefined` means no credit carries. A missing
   measurement must never be read as an approval.
*/
import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stablePatchIdBetween } from "../merge/merger-ai.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(`git ${command}`, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("Symptom Verification RUFU-1100 — approval credit is the stable patch, not the tree", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  /**
   * The RUFU-702 shape in four commits: a base, an approved contribution on the task branch, then a
   * foreign landing on the integration branch that moves the tip this card was reviewed against.
   */
  function setupApprovedCandidate(): { repo: string; baseSha: string; candidateSha: string; advancedTipSha: string } {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-tipadvance-"));
    repos.push(repo);
    git(repo, "init -q -b main");
    git(repo, "config user.email test@example.com");
    git(repo, "config user.name Test");
    writeFileSync(path.join(repo, "seed.txt"), "seed\n");
    git(repo, "add seed.txt");
    git(repo, "commit -q -m 'seed'");
    const baseSha = git(repo, "rev-parse HEAD");

    git(repo, "checkout -q -b fusion/fn-1");
    writeFileSync(path.join(repo, "feature.txt"), "feature work\n");
    git(repo, "add feature.txt");
    git(repo, "commit -q -m 'feat: the approved contribution'");
    const candidateSha = git(repo, "rev-parse HEAD");

    // Somebody else lands. The task branch is untouched; only the integration tip moved.
    git(repo, "checkout -q main");
    writeFileSync(path.join(repo, "other-card.txt"), "landed by another card\n");
    git(repo, "add other-card.txt");
    git(repo, "commit -q -m 'main: another card lands'");
    const advancedTipSha = git(repo, "rev-parse HEAD");

    return { repo, baseSha, candidateSha, advancedTipSha };
  }

  /** Rebuild the approved contribution onto the newer tip, as the merge pass does after a drift. */
  function rebuildOnto(repo: string, name: string, ontoSha: string, contributionSha: string): string {
    git(repo, `checkout -q -b ${name} ${ontoSha}`);
    git(repo, `cherry-pick ${contributionSha}`);
    return git(repo, "rev-parse HEAD");
  }

  it("keeps one patch identity when the same contribution is replayed onto the advanced tip", async () => {
    const { repo, baseSha, candidateSha, advancedTipSha } = setupApprovedCandidate();
    const approvedPatchId = await stablePatchIdBetween(repo, baseSha, candidateSha);
    expect(approvedPatchId).toMatch(/^[0-9a-f]{40}$/);

    const rebuiltSha = rebuildOnto(repo, "fusion/fn-1-rebuilt", advancedTipSha, candidateSha);
    const rebuiltPatchId = await stablePatchIdBetween(repo, advancedTipSha, rebuiltSha);

    // The identity the reviewer's approval attaches to survives the base move.
    expect(rebuiltPatchId).toBe(approvedPatchId);
    /*
    And the facts the pre-fix predicate compared all DID change: a different base, a different candidate
    head, and a different whole-repository tree. This is why SHA/tree comparison could never have carried
    the episode — asserting them here is what stops a future "simplify it back to a tree compare" edit
    from passing this file.
    */
    expect(advancedTipSha).not.toBe(baseSha);
    expect(rebuiltSha).not.toBe(candidateSha);
    expect(git(repo, `rev-parse ${rebuiltSha}^{tree}`)).not.toBe(git(repo, `rev-parse ${candidateSha}^{tree}`));
  });

  it("loses the patch identity when the rebuilt candidate's content differs", async () => {
    const { repo, baseSha, candidateSha, advancedTipSha } = setupApprovedCandidate();
    const approvedPatchId = await stablePatchIdBetween(repo, baseSha, candidateSha);

    // The corrective/rebuilt candidate that resolved a finding is a DIFFERENT patch and must earn a fresh
    // approval; credit carrying forward here would land content nobody reviewed.
    git(repo, `checkout -q -b fusion/fn-1-amended ${advancedTipSha}`);
    writeFileSync(path.join(repo, "feature.txt"), "feature work\nplus the reviewer's correction\n");
    git(repo, "add feature.txt");
    git(repo, "commit -q -m 'feat: contribution with a correction'");
    const amendedSha = git(repo, "rev-parse HEAD");

    expect(await stablePatchIdBetween(repo, advancedTipSha, amendedSha)).not.toBe(approvedPatchId);
  });

  it("answers undefined for a comparison it cannot measure, which carries no credit", async () => {
    const { repo, baseSha, candidateSha } = setupApprovedCandidate();
    // Unresolvable revision: the caller must treat this as "no credit", never as "equal".
    expect(await stablePatchIdBetween(repo, "0000000000000000000000000000000000000000", candidateSha)).toBeUndefined();
    // Empty diff (same commit on both sides) has no patch to identify.
    expect(await stablePatchIdBetween(repo, baseSha, baseSha)).toBeUndefined();
  });
});
