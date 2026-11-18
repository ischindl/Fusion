import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MergeDetails } from "@fusion/core";
import { measureDefaultBranchLandingProof } from "../merge/default-branch-landing-proof-evidence.js";

/*
Real-git coverage for the default-branch landing probe (RUFU-702).

The load-bearing risk of this card is the FALSE POSITIVE: a card genuinely squash-landed onto `main` being
demoted or refused because its branch head differs from the landed squash sha. So the fixture reproduces
each delivery shape with real commits rather than a mocked git, and the first case is the one that must
never break. Ancestry alone would break it if it measured the wrong sha, and `git cherry` alone would
break it because a squash rewrites per-commit patch-ids — which is precisely the instrument RUFU-450's
erratum proved blind under squash.
*/

const exec = promisify(execFile);

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

let repo = "";
const shas: Record<string, string> = {};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "rufu-702-landing-"));
  const g = (...args: string[]) => gitIn(repo, ...args);
  await g("init", "--initial-branch=main");
  await g("config", "user.email", "test@example.com");
  await g("config", "user.name", "Test");
  await writeFile(join(repo, "README.md"), "base\n");
  await g("add", "README.md");
  await g("commit", "-m", "base commit");

  // ── Shape 1: squash-landed (`always-squash`, the project default). ──────────────────
  // TWO commits on the branch, so the squash combines them. This is what makes the fixture honest about
  // `git cherry`: a SINGLE-commit squash preserves the patch-id and reads `-`, while a multi-commit
  // squash cannot match any per-commit patch-id and reads `+` for every one of them. RUFU-450's erratum
  // measured the multi-commit case, which is why `cherry` is a cheap first pass here and never the decider.
  await g("switch", "-c", "fusion/fn-100");
  await writeFile(join(repo, "feature.ts"), "export const a = 1;\n");
  await g("add", ".");
  await g("commit", "-m", "feat: add feature");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "lockfile.ts"), "export const lock = true;\n");
  await g("add", ".");
  await g("commit", "-m", "feat: add lockfile module");
  shas.branchTip = await g("rev-parse", "HEAD");
  await g("switch", "main");
  await g("merge", "--squash", "fusion/fn-100");
  await g("commit", "-m", "feat(FN-100): add feature\n\nFusion-Task-Id: FN-100");
  shas.squashOnMain = await g("rev-parse", "HEAD");

  // ── Shape 2: landed by rebase (branch head differs; history rewritten). ─────────────
  await g("switch", "-c", "fusion/fn-200", "fusion/fn-100^" as string);
  await writeFile(join(repo, "rebased.ts"), "export const b = 2;\n");
  await g("add", ".");
  await g("commit", "--allow-empty", "-m", "feat: rebased work");
  shas.rebasedBranchTip = await g("rev-parse", "HEAD");
  await g("switch", "main");
  await g("cherry-pick", shas.rebasedBranchTip!);
  shas.rebasedOnMain = await g("rev-parse", "HEAD");

  // ── Shape 3: the RUFU-294 shape. Content that is NOT on main, conflicting with it. ──
  await g("switch", "-c", "fusion/rufu-293", `${shas.squashOnMain}`);
  await writeFile(join(repo, "README.md"), "divergent base from main\n");
  await writeFile(join(repo, "rufu293.ts"), "export const c = 3;\n");
  await g("add", ".");
  await g("commit", "-m", "feat(RUFU-293): mega landing");
  shas.notOnMain = await g("rev-parse", "HEAD");

  // ── Shape 4: an honest off-main commit with NO conflicts against main. ──────────────
  await g("switch", "-c", "fusion/fn-300", shas.squashOnMain!);
  await writeFile(join(repo, "pending.ts"), "export const d = 4;\n");
  await g("add", ".");
  await g("commit", "-m", "feat: not landed yet");
  shas.cleanButUnlanded = await g("rev-parse", "HEAD");
}, 60_000);

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

function details(commitSha: string, overrides: Partial<MergeDetails> = {}): MergeDetails {
  return {
    merged: true,
    commitSha,
    filesChanged: 1,
    mergedAt: Date.now(),
    ...overrides,
  } as MergeDetails;
}

describe("measureDefaultBranchLandingProof — real git", () => {
  it("proves a squash landing where the recorded sha IS the squash commit on main", async () => {
    // The common case for every card on the project default strategy: 1 459 landed files, one sha on main.
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.squashOnMain!, {
        mergeTargetBranch: "main",
        mergeTargetSource: "project-default",
      }),
    });
    expect(result.integrationRefReadable).toBe(true);
    expect(result.ancestryOutcome).toBe("proven");
    expect(result.verdict).toEqual({ disposition: "proven", proofKind: "integration-ancestry" });
  });

  it("proves a squash-landed card from its BRANCH TIP, where ancestry fails and git cherry is blind", async () => {
    // The mandatory positive control. `fusion/fn-100`'s tip is NOT an ancestor of main and `git cherry`
    // reports every commit `+` because the squash rewrote its patch-id; the match survives on post-image
    // blob identity — every path the branch created exists on main with the same blob.
    // Prove the weaker instrument really is blind on this shape before proving the decider is not: a
    // two-commit branch squashed into one commit on main matches NO per-commit patch-id.
    const cherry = await gitIn(repo, "cherry", "main", shas.branchTip!);
    const cherryLines = cherry.split("\n").filter(Boolean);
    expect(cherryLines).toHaveLength(2);
    expect(cherryLines.every((line) => line.startsWith("+"))).toBe(true);

    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.branchTip!, {
        mergeTargetBranch: "main",
        mergeTargetSource: "project-default",
      }),
    });
    expect(result.ancestryOutcome).toBe("absent");
    expect(result.patchEquivalentOutcome).toBe("proven");
    expect(result.verdict).toEqual({ disposition: "proven", proofKind: "patch-equivalent" });
  });

  it("proves a rebased landing whose branch head differs from the landed commit", async () => {
    // `auto` / `always-rebase` / a Direct Merge Commit Strategy override: the head legitimately differs.
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.rebasedBranchTip!, {
        mergeTargetBranch: "main",
        mergeTargetSource: "project-default",
      }),
    });
    expect(result.ancestryOutcome).toBe("absent");
    expect(result.patchEquivalentOutcome).toBe("proven");
    expect(result.verdict.disposition).toBe("proven");
  });

  it("refuses the RUFU-294 shape: a commit off main whose recorded target names a Fusion task branch", async () => {
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.notOnMain!, {
        mergeTargetBranch: "fusion/rufu-293",
        mergeTargetSource: "task-base-branch",
      }),
    });
    expect(result.ancestryOutcome).toBe("absent");
    expect(result.patchEquivalentOutcome).toBe("absent");
    expect(result.verdict).toMatchObject({ disposition: "refused", refusalCode: "landing-target-not-integration" });
    // The conflict count is recorded so a stale base reads differently from a cannot-land-as-is base.
    expect(typeof result.conflictCount).toBe("number");
  });

  it("refuses an honest off-main commit that claims nothing, reporting zero conflicts", async () => {
    // Data state: a card whose work is real but unlanded. The census must heal this one forward, not
    // annotate it as cannot-land, and the distinguishing fact is `conflictCount: 0`.
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.cleanButUnlanded!),
    });
    expect(result.verdict).toMatchObject({ disposition: "refused", refusalCode: "commit-not-on-integration-branch" });
    expect(result.conflictCount).toBe(0);
  });

  it("defers rather than refuses when the integration branch does not resolve", async () => {
    // Data state: bare repo / no origin/HEAD. Refusing here would fabricate a failure per hosted card.
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "refs/heads/definitely-not-a-branch",
      mergeDetails: details(shas.squashOnMain!, { mergeTargetBranch: "main", mergeTargetSource: "project-default" }),
    });
    expect(result.integrationRefReadable).toBe(false);
    expect(result.verdict).toEqual({ disposition: "deferred", reason: "integration-ref-unreadable" });
  });

  it("defers when the card carries no recorded delivery claim at all", async () => {
    const result = await measureDefaultBranchLandingProof({ repoDir: repo, integrationBranch: "main", mergeDetails: null });
    expect(result.verdict).toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("proves a shared-branch-group member whose target is a live group ref", async () => {
    const result = await measureDefaultBranchLandingProof({
      repoDir: repo,
      integrationBranch: "main",
      mergeDetails: details(shas.notOnMain!, {
        mergeTargetBranch: "fusion/rufu-293",
        mergeTargetSource: "branch-group-integration",
      }),
    });
    expect(result.groupBranchIsLive).toBe(true);
    expect(result.verdict).toEqual({ disposition: "proven", proofKind: "group-intermediate" });
  });
});

/*
FNXC:DefaultBranchLandingProof 2026-11-18-02:51 (RUFU-702, operator decision 2026-11-17T23:2xZ):
The operator ruled that a task-declared target branch which is NOT a Fusion task branch (`release`,
`release/9.9`, `integration/v2`) is a valid delivery vehicle, so this class is measured against its OWN target
ref and not against `main`. Real git rather than a fake runner, because the whole question is whether a ref
that exists holds a commit: a fake could assert any verdict the author imagined.

The negative controls matter as much as the positive one. `landing-target-not-integration` exists because
RUFU-294 advanced the SIBLING card's branch and called that delivery, so a task branch must stay refused even
when it demonstrably holds the commit, and a card whose target cannot be read must be deferred, not refused,
because an unmeasured yardstick is not an absence. `merger-ai.test.ts` covers the same class end to end
through the finalize seam; this file pins the measurement underneath it.
*/
describe("measureDefaultBranchLandingProof — a task-declared target branch is its own yardstick", () => {
  let targetRepo = "";
  const targetShas: Record<string, string> = {};

  beforeAll(async () => {
    targetRepo = await mkdtemp(join(tmpdir(), "rufu-702-declared-target-"));
    const g = (...args: string[]) => gitIn(targetRepo, ...args);
    await g("init", "--initial-branch=main");
    await g("config", "user.email", "test@example.com");
    await g("config", "user.name", "Test");
    await writeFile(join(targetRepo, "README.md"), "base\n");
    await g("add", "README.md");
    await g("commit", "-m", "base commit");
    targetShas.base = await g("rev-parse", "HEAD");

    // Shape: the card declared `release` as its base branch and landed there. `main` never saw the commit.
    await g("branch", "release", "main");
    await g("switch", "release");
    await writeFile(join(targetRepo, "release-only.ts"), "export const r = 1;\n");
    await g("add", ".");
    await g("commit", "-m", "feat(RUFU-702): work that ships on the release branch");
    targetShas.onRelease = await g("rev-parse", "HEAD");

    // Shape: a sibling card's task branch that DOES hold a commit. Held content is not delivery. The name is
    // deliberately a real task-branch shape (`<board-prefix>-<digits>`), because that shape is what the class
    // predicate has to recognize.
    await g("branch", "fusion/rufu-293", targetShas.onRelease!);

    // Shape: work that reached neither `main` nor the declared target.
    await g("switch", "-c", "fusion/rufu-702-unlanded", "main");
    await writeFile(join(targetRepo, "unlanded.ts"), "export const u = 1;\n");
    await g("add", ".");
    await g("commit", "-m", "feat: work that reached no target");
    targetShas.onNoTarget = await g("rev-parse", "HEAD");
    await g("switch", "main");
  });

  afterAll(async () => {
    await rm(targetRepo, { recursive: true, force: true });
  });

  it("proves a card whose commit is on the target branch it declared, with `main` untouched", async () => {
    const result = await measureDefaultBranchLandingProof({
      repoDir: targetRepo,
      integrationBranch: "main",
      mergeDetails: details(targetShas.onRelease!, {
        mergeTargetBranch: "release",
        mergeTargetSource: "task-base-branch",
        landedBranchTipSha: targetShas.onRelease,
      }),
    });
    // The default branch really does not hold it; the card's own target really does. Both are recorded.
    expect(result.ancestryOutcome).toBe("absent");
    expect(result.declaredTargetAncestryOutcome).toBe("proven");
    expect(result.verdict).toEqual({ disposition: "proven", proofKind: "task-declared-target" });
  });

  it("defers instead of refusing when the declared target ref is not readable here", async () => {
    // Data state: a remote-only target (`origin/release/9.9` with no local ref). Refusing would spend the
    // card's retries on a ref nobody measured, which is the same defect as refusing on an unreadable `main`.
    const result = await measureDefaultBranchLandingProof({
      repoDir: targetRepo,
      integrationBranch: "main",
      mergeDetails: details(targetShas.onRelease!, {
        mergeTargetBranch: "release/9.9",
        mergeTargetSource: "task-base-branch",
      }),
    });
    expect(result.declaredTargetAncestryOutcome).toBe("unreadable");
    expect(result.verdict).toEqual({ disposition: "deferred", reason: "landing-evidence-incomplete" });
  });

  it("refuses a declared-target card whose own target lacks the commit, naming both refs", async () => {
    const result = await measureDefaultBranchLandingProof({
      repoDir: targetRepo,
      integrationBranch: "main",
      mergeDetails: details(targetShas.onNoTarget!, {
        mergeTargetBranch: "release",
        mergeTargetSource: "task-base-branch",
      }),
    });
    expect(result.declaredTargetAncestryOutcome).toBe("absent");
    expect(result.verdict).toMatchObject({
      disposition: "refused",
      refusalCode: "commit-not-on-integration-branch",
    });
    if (result.verdict.disposition !== "refused") return;
    // "Which ref did you look at" has to be answerable from the card face for this class: both of them.
    expect(result.verdict.reason).toContain('"main"');
    expect(result.verdict.reason).toContain('"release"');
  });

  it("still refuses a target naming a SIBLING task branch even though that ref holds the commit", async () => {
    // The RUFU-294 negative control under the new rule: held content on another card's branch is exactly the
    // false positive this card exists to refuse, so the class predicate excludes task refs and the probe
    // never even measures them.
    const result = await measureDefaultBranchLandingProof({
      repoDir: targetRepo,
      integrationBranch: "main",
      mergeDetails: details(targetShas.onRelease!, {
        mergeTargetBranch: "fusion/rufu-293",
        mergeTargetSource: "task-base-branch",
      }),
    });
    expect(result.declaredTargetAncestryOutcome).toBe("unreadable");
    expect(result.verdict).toMatchObject({ refusalCode: "landing-target-not-integration" });
  });

  it("prefers the default-branch proof and skips the second probe when `main` already holds the commit", async () => {
    // Bounded probe: a card proven against the stronger yardstick must not pay for a target read it does not
    // need, and `"unreadable"` here records "not asked", not a failed measurement.
    const result = await measureDefaultBranchLandingProof({
      repoDir: targetRepo,
      integrationBranch: "main",
      mergeDetails: details(targetShas.base!, {
        mergeTargetBranch: "release",
        mergeTargetSource: "task-base-branch",
      }),
    });
    expect(result.verdict).toEqual({ disposition: "proven", proofKind: "integration-ancestry" });
    expect(result.declaredTargetAncestryOutcome).toBe("unreadable");
  });
});
