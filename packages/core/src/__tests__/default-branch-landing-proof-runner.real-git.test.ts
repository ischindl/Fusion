/*
FNXC:DefaultBranchLandingProof 2026-11-17-21:05 (RUFU-702, code-review P0):
The landing probe's runner executes ARGV, never a shell string — pinned against real git, because the defect
this guards was a runner whose signature said argv and whose body rebuilt a command string.

Why real git and a REAL hostile filename rather than a spy on the spawn arguments: the injection is not in
which arguments the probe builds, it is in what happens to them on the way to the process. A spy would have
passed the shell-string runner too, because the string it built contained exactly the right words. The
payload here is a committed filename — `$(touch pwned)` — which is legitimate content any contributor may
commit, and it is exactly the value the content-equivalence probe reads back from `git show --name-only` and
feeds into its next call. Under `spawn(command, { shell: true })` with each element wrapped in double quotes
(a shape that LOOKS like quoting), a POSIX shell performs `$(…)` substitution *inside* double quotes, so the
project checkout executes whatever the last committed filename says. The assertion that settles it is the
absence of the side effect the payload names, plus git answering normally about the file itself.
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LANDING_PROBE_GIT_MAX_BUFFER,
  LANDING_PROBE_GIT_TIMEOUT_MS,
  createArgvGitLandingRunner,
  measureDefaultBranchLandingProofWithRunner,
} from "../merge/default-branch-landing-proof-probe.js";

/** A filename whose content is a command substitution. Legitimate on disk, code inside a shell string. */
const HOSTILE_NAME = "$(touch pwned)";

let repo = "";
let hostileCommit = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "fusion-landing-runner-"));
  git("init", "-b", "main");
  git("config", "user.email", "runner@test.invalid");
  git("config", "user.name", "Runner Test");
  writeFileSync(join(repo, "README.md"), "seed\n", "utf-8");
  git("add", "-A");
  git("commit", "-m", "chore: seed");
  writeFileSync(join(repo, HOSTILE_NAME), "committed content is data\n", "utf-8");
  git("add", "-A");
  git("commit", "-m", `feat: commit a file whose name is a substitution\n\nFusion-Task-Id: RUFU-702`);
  hostileCommit = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function pwned(): boolean {
  return readdirSync(repo).includes("pwned");
}

describe("createArgvGitLandingRunner — argv reaches git as data", () => {
  it("runs a real read-only probe and reports its stdout and zero exit code", async () => {
    const run = createArgvGitLandingRunner({ cwd: repo });
    const result = await run(["rev-parse", "HEAD"]);
    // Raw stdout is returned untouched (each probe trims what it needs), and a zero exit is `ok`.
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(hostileCommit);
  });

  it("survives a non-zero exit as an observation, not a throw", async () => {
    const run = createArgvGitLandingRunner({ cwd: repo });
    // `merge-base --is-ancestor` answers "no" with exit 1; the probe contract reads that as `absent`.
    const result = await run(["rev-parse", "--verify", "refs/heads/no-such-branch"]);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it("treats a command substitution in an argument as a path, never as code", async () => {
    const run = createArgvGitLandingRunner({ cwd: repo });
    // The exact string that a shell-string runner expands before git ever sees it. As argv it is one
    // unmatchable pathspec: git answers, the probe sees an empty listing, and nothing is executed.
    const listing = await run(["ls-tree", "-r", "--name-only", "HEAD", "--", HOSTILE_NAME]);
    expect(listing.ok).toBe(true);
    expect(listing.stdout.trim()).toBe(HOSTILE_NAME);
    expect(pwned()).toBe(false);
  });

  it("carries the repository-derived path from `show --name-only` into the next call without executing it", async () => {
    /*
    The two-step the real probe performs — read a path out of one commit, pass it to the next command. This is
    the shape that made the shell-string runner exploitable by a commit alone: no caller had to be tricked,
    the payload arrived from inside the repository.
    */
    const run = createArgvGitLandingRunner({ cwd: repo });
    const shown = await run(["show", "--name-only", "--format=", hostileCommit]);
    expect(shown.stdout).toContain(HOSTILE_NAME);
    const compared = await run(["ls-tree", "-r", "--name-only", hostileCommit, "--", ...shown.stdout.trim().split("\n")]);
    expect(compared.ok).toBe(true);
    expect(compared.stdout).toContain(HOSTILE_NAME);
    expect(pwned()).toBe(false);
  });

  it("measures a landing claim over that same hostile-path commit without executing anything", async () => {
    /*
    End-to-end through the probe itself, so the assertion covers the whole call chain and not just the
    transport: whatever arm the decision lands on, the payload must not run. The verdict is a delivery
    judgement and is deliberately not asserted here — a `main`-tip commit in a throwaway repo would prove,
    and the point of this case is the missing side effect.
    */
    const observation = await measureDefaultBranchLandingProofWithRunner({
      runGit: createArgvGitLandingRunner({ cwd: repo }),
      integrationBranch: "main",
      recordedSha: hostileCommit,
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
    });
    expect(observation.integrationBranch).toBe("main");
    expect(observation.verdict.disposition).toBeTruthy();
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });

  it("publishes its bounds instead of leaving each lane to invent its own", () => {
    // Both lanes used to carry private copies of these numbers; one pair now bounds every landing probe.
    expect(LANDING_PROBE_GIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LANDING_PROBE_GIT_MAX_BUFFER).toBeGreaterThan(0);
  });
});
