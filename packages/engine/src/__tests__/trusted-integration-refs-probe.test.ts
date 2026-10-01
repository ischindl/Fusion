import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __resetTrustedIntegrationRefsForTests,
  __trustedIntegrationRefsGitCalls,
  resolveTrustedIntegrationRefs,
} from "../execution/branch-conflicts.js";

/*
FNXC:BranchBaseIdentity 2026-10-01-23:50 (RUFU-481):
`resolveTrustedIntegrationRefs` was the largest git generator in the running dashboard — 13% of all process
CPU in a CPU profile taken while ONE 100-card board page loaded. It ran `git remote` plus one `git
rev-parse` per configured remote (six in the production checkout) and had six production call sites, one
inside a per-entry sweep, so the board's 0.11 s SQL read spent ~11 s queued behind it.

The fix must not change a single verdict: the trusted set is the local integration branch first, then the
`<remote>/<integrationRef>` identities that are BOTH configured remotes AND present locally. These cases
use real git repositories because "does this remote-tracking ref exist" is a git fact, not our fact.
*/

const execAsync = promisify(exec);
const roots: string[] = [];

async function git(cwd: string, args: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

async function makeRepo(name: string, branch = "main"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `rufu-481-${name}-`));
  roots.push(dir);
  await git(dir, `init -b ${branch} .`);
  await git(dir, "config user.email test@example.com");
  await git(dir, "config user.name Test");
  await git(dir, "config commit.gpgsign false");
  return dir;
}

async function commitFile(dir: string, file: string, message: string, branch?: string): Promise<void> {
  // Only switch back when a base branch exists to return to: a repo whose sole branch is created here
  // has nothing to check out, and `git checkout main` against a branchless repo is a harness bug.
  const returnTo = branch ? await git(dir, "rev-parse --abbrev-ref HEAD").catch(() => "") : "";
  if (branch) await git(dir, `checkout -b ${branch}`);
  await execAsync(`echo content > ${file}`, { cwd: dir, shell: "/bin/sh" });
  await git(dir, `add ${file}`);
  await git(dir, `commit -m "${message}"`);
  if (branch && returnTo && returnTo !== branch) await git(dir, `checkout ${returnTo}`);
}

let repoDir = "";

beforeAll(async () => {
  // The subject repository.
  repoDir = await makeRepo("subject");
  await commitFile(repoDir, "seed.txt", "seed");

  // Remote `one` has main AND a slashed branch, so both integration-ref shapes are exercised.
  const one = await makeRepo("remote-one");
  await commitFile(one, "seed.txt", "seed");
  await commitFile(one, "layered.txt", "layered", "layer/main");
  await git(repoDir, `remote add one ${one}`);
  await git(repoDir, "fetch one --quiet");

  // Remote `two` deliberately lacks `main`: its tracking refs must NOT become trusted.
  const two = await makeRepo("remote-two", "topic");
  await commitFile(two, "other.txt", "other");
  await git(repoDir, `remote add two ${two}`);
  await git(repoDir, "fetch two --quiet");

  // Remote `three` is configured but never fetched: no remote-tracking refs at all.
  await git(repoDir, `remote add three ${await makeRepo("remote-three")}`);

  __resetTrustedIntegrationRefsForTests();
});

afterAll(async () => {
  for (const dir of roots) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveTrustedIntegrationRefs", () => {
  it("trusts the local branch first, then configured remotes that actually have the ref", async () => {
    const refs = await resolveTrustedIntegrationRefs(repoDir, "main");
    expect(refs[0]).toBe("main");
    expect(refs).toContain("one/main");
    expect(refs).not.toContain("two/main");
    expect(refs).not.toContain("three/main");
    // A remote-tracking branch that merely ENDS with the integration ref is not a counterpart of it.
    expect(refs).not.toContain("one/layer/main");
  });

  it("resolves a slashed integration ref against the same remote set", async () => {
    const refs = await resolveTrustedIntegrationRefs(repoDir, "layer/main");
    expect(refs[0]).toBe("layer/main");
    expect(refs).toContain("one/layer/main");
    expect(refs).not.toContain("two/layer/main");
  });

  it("answers a repeat call from the memo without spending another subprocess", async () => {
    __resetTrustedIntegrationRefsForTests();
    const cold = await resolveTrustedIntegrationRefs(repoDir, "main");
    // Exactly TWO git subprocesses: one `git remote`, one `refs/remotes` listing. Before this fix the same
    // answer cost 1 + one `rev-parse` per configured remote (three remotes here = 4, six in production = 7).
    const coldCalls = __trustedIntegrationRefsGitCalls();
    expect(coldCalls).toBe(2);

    const warm = await resolveTrustedIntegrationRefs(repoDir, "main");
    expect(warm).toEqual(cold);
    expect(__trustedIntegrationRefsGitCalls()).toBe(coldCalls);

    // A different base branch is a different identity, so it may not reuse the `main` entry.
    await resolveTrustedIntegrationRefs(repoDir, "layer/main");
    expect(__trustedIntegrationRefsGitCalls()).toBe(coldCalls + 2);
  });

  it("re-probes after the memo is dropped rather than serving a removed identity", async () => {
    __resetTrustedIntegrationRefsForTests();
    const first = await resolveTrustedIntegrationRefs(repoDir, "main");
    expect(__trustedIntegrationRefsGitCalls()).toBe(2);
    __resetTrustedIntegrationRefsForTests();
    const afterExpiry = await resolveTrustedIntegrationRefs(repoDir, "main");
    expect(afterExpiry).toEqual(first);
    // The counter was zeroed with the memo, so a fresh 2 means the identity was RE-READ, not replayed.
    expect(__trustedIntegrationRefsGitCalls()).toBe(2);
  });

  it("degrades to the local identity alone when the repository has no remotes", async () => {
    const lonely = await makeRepo("no-remotes");
    await commitFile(lonely, "seed.txt", "seed");
    __resetTrustedIntegrationRefsForTests();
    expect(await resolveTrustedIntegrationRefs(lonely, "main")).toEqual(["main"]);
  });
});
