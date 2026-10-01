/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
The engine half reads repo facts and stamps the decision. Two properties matter here and nowhere else:
the shellout must not enter the finalize retry loop (cache), and a fact that could NOT be read must never
be remembered (otherwise one transient git failure silently relaxes — or keeps — a completion gate for the
life of the process). The audit row is checked for the absence of the remote URL, because a remote can
carry credentials.
*/
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countGitHubWorkflowFiles,
  resetPostMergeEvidenceContractCacheForTest,
  resolvePostMergeEvidenceContract,
} from "../merge/post-merge-evidence-contract.js";

/** A throwaway `git init` checkout: the shape a no-remote board actually has on disk. */
function realGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pmec-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  return dir;
}

const ROOT = "/repo/saneca";

function makeStore(options: {
  rootDir?: string | (() => string);
  settings?: Record<string, unknown>;
  settingsThrows?: boolean;
} = {}) {
  const recorded: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: () => (typeof options.rootDir === "function" ? options.rootDir() : options.rootDir ?? ROOT),
    readRawProjectSettings: async () => {
      if (options.settingsThrows) throw new Error("settings sink down");
      return options.settings ?? {};
    },
    recordRunAuditEvent: (event: Record<string, unknown>) => {
      recorded.push(event);
      return Promise.resolve();
    },
  };
  return { store: store as never, recorded };
}

beforeEach(() => {
  resetPostMergeEvidenceContractCacheForTest();
});

describe("resolvePostMergeEvidenceContract", () => {
  it("derives no-reporter for a non-GitHub trunk and reports it once", async () => {
    const { store, recorded } = makeStore();
    const readRemoteUrl = vi.fn(async () => "http://192.168.12.60:6610/saneca.git");
    const countGitHubWorkflowFiles = vi.fn(async () => 1);
    const deps = { readRemoteUrl, countGitHubWorkflowFiles, auditHost: store as never };

    const first = await resolvePostMergeEvidenceContract(store, deps);
    const second = await resolvePostMergeEvidenceContract(store, deps);

    expect(first).toMatchObject({ provider: "none", source: "derived", reason: "non-github-remote" });
    expect(second?.reason).toBe("non-github-remote");
    // The finalize loop asks this on every retry; the observation must be read once.
    expect(readRemoteUrl).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    /*
    FNXC:RunAudit 2026-10-01-00:12 (RUFU-430): these fields are the row's ticket into
    `project.run_audit_events`, whose `target` and `project_id` are NOT NULL and whose domain set is fixed.
    The first shipped emit carried no `target` at all, `project.run_audit_events.target` is NOT NULL, and the
    bounded seam swallowed the resulting rejection — production kept zero rows, so the decision stayed
    unanswerable, which is the one thing this event exists to prevent. Asserting the whole row shape is the
    regression guard; note the domain value is convention, not enforcement (the column has no CHECK).
    */
    expect(recorded[0]).toMatchObject({
      mutationType: "merge:post-merge-evidence-contract",
      agentId: "merger",
      domain: "git",
      target: "post-merge-evidence",
    });
    expect((recorded[0] as { metadata: Record<string, unknown> }).metadata).toEqual({
      provider: "none", source: "derived", reason: "non-github-remote",
    });
  });

  it("never records the remote URL or the project path in run-audit", async () => {
    const { store, recorded } = makeStore();
    await resolvePostMergeEvidenceContract(store, {
      // A credential-bearing remote is the exact shape that must not reach the audit store.
      readRemoteUrl: async () => "https://user:secret-token@github.com/org/private.git",
      countGitHubWorkflowFiles: async () => 3,
      auditHost: store as never,
    });
    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain("secret-token");
    expect(serialised).not.toContain(ROOT);
  });

  it("derives github-actions for a GitHub trunk with workflows, so the gate stays exactly as demanding", async () => {
    const { store } = makeStore();
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => "https://github.com/Runfusion/Fusion.git",
      countGitHubWorkflowFiles: async () => 11,
    });
    expect(contract).toMatchObject({ provider: "github-actions", reason: "github-remote-with-workflows" });
  });

  it("fails closed on unreadable repo facts and does NOT cache that failure", async () => {
    const { store } = makeStore();
    const readRemoteUrl = vi.fn(async () => { throw new Error("worktree gone"); });

    const first = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl,
      countGitHubWorkflowFiles: async () => 0,
    });
    expect(first).toMatchObject({ provider: "github-actions", reason: "repo-facts-unreadable" });

    // A second pass must retry the read, and once the repo is readable the real contract wins.
    const retryReader = vi.fn(async () => "http://192.168.12.60:6610/saneca.git");
    const second = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: retryReader,
      countGitHubWorkflowFiles: async () => 0,
    });
    expect(retryReader).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ provider: "none", reason: "non-github-remote" });
  });

  it("reads an operator declaration from project settings and it beats the observed facts", async () => {
    const { store } = makeStore({ settings: { postMergeEvidence: { provider: "none", note: "OneDev board" } } });
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => "https://github.com/Runfusion/Fusion.git",
      countGitHubWorkflowFiles: async () => 11,
    });
    expect(contract).toMatchObject({ provider: "none", source: "declared", reason: "operator-declared" });
  });

  it("survives a throwing settings read and a store with no root directory", async () => {
    const brokenSettings = makeStore({ settingsThrows: true });
    await expect(resolvePostMergeEvidenceContract(brokenSettings.store, {
      readRemoteUrl: async () => null,
      countGitHubWorkflowFiles: async () => 0,
    })).resolves.toMatchObject({ provider: "none", reason: "no-remote" });

    // No root dir = no observation = no contract = the caller's pre-change behavior, untouched.
    const noRoot = { getRootDir: () => "" } as never;
    await expect(resolvePostMergeEvidenceContract(noRoot, {
      readRemoteUrl: async () => "https://github.com/org/x.git",
      countGitHubWorkflowFiles: async () => 4,
    })).resolves.toBeUndefined();
    await expect(resolvePostMergeEvidenceContract(null, {})).resolves.toBeUndefined();
  });
});

/*
FNXC:PostMergeEvidenceContract 2026-10-01-00:00 (RUFU-430):
The first shipped version was inert on exactly the boards it was written for. Against a real no-remote
checkout, `git remote get-url origin` exits 2 with `No such remote 'origin'`; the resolver read that throw
as "facts unreadable" and failed closed, so VLLM-083 stayed parked `in-review` / `failed` with
`required post-merge evidence gate 'post-merge-verification' has not reported` minutes after the deploy.
These cases run the DEFAULT readers against real throwaway repositories, because an injected fake could
never have caught a misread exit code.
*/
describe("post-merge evidence contract against real repositories", () => {
  it("reads an absent origin as the fact that there is no reporter", async () => {
    const dir = realGitRepo();
    const store = { getRootDir: () => dir, readRawProjectSettings: async () => ({}) } as never;
    await expect(resolvePostMergeEvidenceContract(store)).resolves.toMatchObject({
      provider: "none",
      reason: "no-remote",
    });
    // A repository with no `.github/workflows` answers "zero", not "unreadable".
    expect(await countGitHubWorkflowFiles(dir)).toBe(0);
  });

  it("CONTROL: a directory that is not a readable repository still demands the evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    const store = { getRootDir: () => dir, readRawProjectSettings: async () => ({}) } as never;
    await expect(resolvePostMergeEvidenceContract(store)).resolves.toMatchObject({
      provider: "github-actions",
      reason: "repo-facts-unreadable",
    });
  });

  it("CONTROL: a GitHub repository with workflow files keeps the Full Suite contract", async () => {
    const dir = realGitRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/org/repo.git"], { cwd: dir });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
    const store = { getRootDir: () => dir, readRawProjectSettings: async () => ({}) } as never;
    await expect(resolvePostMergeEvidenceContract(store)).resolves.toMatchObject({
      provider: "github-actions",
      reason: "github-remote-with-workflows",
    });
    expect(await countGitHubWorkflowFiles(dir)).toBe(1);
  });
});
