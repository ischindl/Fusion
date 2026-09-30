/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
The engine half reads repo facts and stamps the decision. Two properties matter here and nowhere else:
the shellout must not enter the finalize retry loop (cache), and a fact that could NOT be read must never
be remembered (otherwise one transient git failure silently relaxes — or keeps — a completion gate for the
life of the process). The audit row is checked for the absence of the remote URL, because a remote can
carry credentials.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPostMergeEvidenceContractCacheForTest,
  resolvePostMergeEvidenceContract,
} from "../merge/post-merge-evidence-contract.js";

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
    expect(recorded[0]).toMatchObject({ mutationType: "merge:post-merge-evidence-contract" });
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
