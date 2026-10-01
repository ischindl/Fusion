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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countGitHubWorkflowFiles,
  resetPostMergeEvidenceContractCacheForTest,
  resolveDefaultReporterEndpoints,
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
  /** Global settings layer the GitLab resolver reads when the project layer is silent. */
  globalSettings?: Record<string, unknown>;
  /** Project secrets the declared OneDev `tokenSecret` reference is checked against (presence only). */
  secrets?: Array<{ id: string; key: string }>;
  globalSettingsThrows?: boolean;
  secretsThrows?: boolean;
} = {}) {
  const recorded: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: () => (typeof options.rootDir === "function" ? options.rootDir() : options.rootDir ?? ROOT),
    readRawProjectSettings: async () => {
      if (options.settingsThrows) throw new Error("settings sink down");
      return options.settings ?? {};
    },
    ...(options.globalSettings || options.globalSettingsThrows
      ? {
          getGlobalSettingsStore: () => ({
            getSettings: async () => {
              if (options.globalSettingsThrows) throw new Error("global settings down");
              return options.globalSettings ?? {};
            },
          }),
        }
      : {}),
    ...(options.secrets || options.secretsThrows
      ? {
          getSecretsStore: async () => {
            if (options.secretsThrows) throw new Error("secrets store down");
            return { listSecrets: async () => options.secrets ?? [] };
          },
        }
      : {}),
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

/*
FNXC:PostMergeEvidenceContract 2026-10-01-07:40 (RUFU-457):
The reader is the only place that can see Fusion's own configuration, and these cases pin what it may and may
not conclude from it. Two properties are specific to this half: a reporter endpoint is derived from the ONE
place that platform's configuration lives (the GitLab settings chain, or the operator's declared OneDev base
URL — there is no OneDev settings surface in this repo), and every failure of that lookup resolves to "no
candidate", which is the pre-change answer. A settings or secrets sink that throws must never be able to
RELAX a gate by inventing a reporter, exactly as a failed `git remote` must never be able to relax one by
inventing `none`.
*/
describe("resolveDefaultReporterEndpoints", () => {
  // An ambient GITLAB_TOKEN on the developer or CI host would otherwise decide `credentialConfigured`.
  beforeEach(() => vi.stubEnv("GITLAB_TOKEN", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("derives GitLab from the project settings instance URL and reports a token as configured presence", async () => {
    const endpoints = await resolveDefaultReporterEndpoints({
      projectSettings: { gitlabEnabled: true, gitlabInstanceUrl: "https://gitlab.digitalsystems.eu", gitlabAuthToken: "glpat-xxxxxxxxxxxx" },
    });
    expect(endpoints).toEqual([{ provider: "gitlab", baseUrl: "https://gitlab.digitalsystems.eu", credentialConfigured: true }]);
    // Presence only: the serialised candidate must never carry the credential it just detected.
    expect(JSON.stringify(endpoints)).not.toContain("glpat-");
  });

  it("falls through to the global settings layer when the project layer is silent", async () => {
    const endpoints = await resolveDefaultReporterEndpoints({
      projectSettings: {},
      readGlobalSettings: async () => ({ gitlabInstanceUrl: "https://gitlab.acme.test" }),
    });
    expect(endpoints).toEqual([{ provider: "gitlab", baseUrl: "https://gitlab.acme.test", credentialConfigured: false }]);
  });

  it("CONTROL: a disabled GitLab integration derives nothing, so a default cannot claim the board", async () => {
    const endpoints = await resolveDefaultReporterEndpoints({
      projectSettings: { gitlabEnabled: false, gitlabInstanceUrl: "https://gitlab.digitalsystems.eu", gitlabAuthToken: "glpat-x" },
    });
    expect(endpoints).toEqual([]);
  });

  it("reads GITLAB_TOKEN as a credential layer without recording its value", async () => {
    vi.stubEnv("GITLAB_TOKEN", "env-secret-value");
    const endpoints = await resolveDefaultReporterEndpoints({ projectSettings: {} });
    expect(endpoints[0]).toMatchObject({ provider: "gitlab", credentialConfigured: true });
    expect(JSON.stringify(endpoints)).not.toContain("env-secret-value");
  });

  it("derives OneDev from the declared base URL and checks the secret REFERENCE for existence only", async () => {
    const hasProjectSecret = vi.fn(async (key: string) => key === "onedev-token");
    const endpoints = await resolveDefaultReporterEndpoints({
      // GitLab is switched off here so the assertion names only the OneDev candidate under test.
      projectSettings: { gitlabEnabled: false },
      declared: { provider: "onedev", baseUrl: "http://192.168.12.60:6610", tokenSecret: "onedev-token" },
      hasProjectSecret,
    });
    expect(endpoints).toEqual([{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: true }]);
    expect(hasProjectSecret).toHaveBeenCalledWith("onedev-token");
  });

  it("reports an OneDev credential as NOT configured when the named secret does not exist", async () => {
    const endpoints = await resolveDefaultReporterEndpoints({
      projectSettings: { gitlabEnabled: false },
      declared: { provider: "onedev", baseUrl: "http://192.168.12.60:6610", tokenSecret: "typo-ed-key" },
      hasProjectSecret: async () => false,
    });
    expect(endpoints).toEqual([{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: false }]);
  });

  it("CONTROL: a non-endpoint declaration and a GitHub-less GitLab default yield no candidate for the host", async () => {
    // `provider: none` names no platform, so there is nothing to match even if settings mention GitLab.
    expect(await resolveDefaultReporterEndpoints({
      projectSettings: { gitlabEnabled: false },
      declared: { provider: "none", note: "OneDev board" },
    })).toEqual([]);
  });

  it("survives a throwing global-settings sink and a throwing secrets store", async () => {
    // A dead global layer falls back to the PROJECT layer plus Fusion's GitLab defaults; it never throws and
    // never invents a host — the only candidate on offer is the integration's own default instance.
    await expect(resolveDefaultReporterEndpoints({
      projectSettings: {},
      readGlobalSettings: async () => { throw new Error("global settings down"); },
    })).resolves.toEqual([{ provider: "gitlab", baseUrl: "https://gitlab.com", credentialConfigured: false }]);

    const endpoints = await resolveDefaultReporterEndpoints({
      projectSettings: { gitlabEnabled: false },
      declared: { provider: "onedev", baseUrl: "http://192.168.12.60:6610", tokenSecret: "onedev-token" },
      hasProjectSecret: async () => { throw new Error("secrets store down"); },
    });
    // The reporter is still named by the declaration; only the credential fact degrades to "not configured".
    expect(endpoints).toEqual([{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: false }]);
  });
});

describe("post-merge evidence contract with a configured reporter endpoint", () => {
  const onedevRemote = "http://192.168.12.60:6610/saneca.git";

  it("resolves OneDev for a non-GitHub origin whose endpoint is configured, and reports it in the audit row", async () => {
    const { store, recorded } = makeStore();
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => onedevRemote,
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: async () => [{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: true }],
      auditHost: store as never,
    });
    expect(contract).toMatchObject({
      provider: "onedev",
      source: "derived",
      reason: "onedev-endpoint",
      endpointHost: "192.168.12.60:6610",
      credentialConfigured: true,
    });
    expect(recorded[0]).toMatchObject({
      metadata: { provider: "onedev", source: "derived", reason: "onedev-endpoint", endpointHost: "192.168.12.60:6610", credentialConfigured: true },
    });
  });

  it("derives GitLab from real settings through the default resolver, self-managed instance included", async () => {
    const { store, recorded } = makeStore({
      settings: { gitlabEnabled: true, gitlabInstanceUrl: "https://gitlab.digitalsystems.eu" },
    });
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => "https://gitlab.digitalsystems.eu/team/service.git",
      countGitHubWorkflowFiles: async () => 0,
      auditHost: store as never,
    });
    expect(contract).toMatchObject({ provider: "gitlab", reason: "gitlab-endpoint", endpointHost: "gitlab.digitalsystems.eu" });
    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-07:55 (RUFU-457): the CONTRACT omits a false
    `credentialConfigured` (core spreads only a true fact), while the AUDIT row states the boolean either way.
    Both shapes are load-bearing: the contract keeps "unknown/false" from reading as an affirmative credential
    fact, and the row answers the operator's question — "is a token wired up here?" — with `false`, not an
    absent field that could be misread as "not applicable".
    */
    expect(contract?.credentialConfigured).toBeUndefined();
    expect((recorded[0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      provider: "gitlab", endpointHost: "gitlab.digitalsystems.eu", credentialConfigured: false,
    });
    expect(recorded).toHaveLength(1);
  });

  it("resolves GitLab Cloud from the default instance URL when the origin really is gitlab.com", async () => {
    const { store } = makeStore();
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => "https://gitlab.com/group/project.git",
      countGitHubWorkflowFiles: async () => 0,
    });
    expect(contract).toMatchObject({ provider: "gitlab", reason: "gitlab-endpoint", endpointHost: "gitlab.com" });
  });

  it("CONTROL: a GitHub origin still resolves github-actions while GitLab settings point at gitlab.com", async () => {
    const { store } = makeStore({ settings: { gitlabInstanceUrl: "https://gitlab.com" } });
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => "https://github.com/Runfusion/Fusion.git",
      countGitHubWorkflowFiles: async () => 11,
    });
    expect(contract).toMatchObject({ provider: "github-actions", reason: "github-remote-with-workflows" });
    expect(contract?.endpointHost).toBeUndefined();
  });

  it("CONTROL: a candidate for a different host cannot claim the board, which stays unreportable", async () => {
    const { store } = makeStore();
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => onedevRemote,
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: async () => [{ provider: "onedev", baseUrl: "http://192.168.12.60:8080" }],
    });
    expect(contract).toMatchObject({ provider: "none", reason: "non-github-remote" });
  });

  it("CONTROL: an operator's `none` declaration survives a configured endpoint — the gate is never relaxed by a setting", async () => {
    const { store } = makeStore({ settings: { postMergeEvidence: { provider: "none", note: "OneDev board" } } });
    const contract = await resolvePostMergeEvidenceContract(store, {
      readRemoteUrl: async () => onedevRemote,
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: async () => [{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: true }],
    });
    expect(contract).toMatchObject({ provider: "none", source: "declared", reason: "operator-declared" });
  });

  it("CONTROL: a board with no endpoint and no remote keeps the fail-closed reasons", async () => {
    // Separate project roots: the contract is cached per root, and reusing one would assert the first case twice.
    const noRemote = await resolvePostMergeEvidenceContract(makeStore({ rootDir: "/repo/no-remote" }).store, {
      readRemoteUrl: async () => null,
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: async () => [{ provider: "gitlab", baseUrl: "https://gitlab.com" }],
    });
    expect(noRemote).toMatchObject({ provider: "none", reason: "no-remote" });

    const unreadable = await resolvePostMergeEvidenceContract(makeStore({ rootDir: "/repo/unreadable" }).store, {
      readRemoteUrl: async () => { throw new Error("worktree gone"); },
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: async () => { throw new Error("settings sink down"); },
    });
    expect(unreadable).toMatchObject({ provider: "github-actions", reason: "repo-facts-unreadable" });
  });

  it("never records the credential-bearing remote, the secret key, or the project path when an endpoint is chosen", async () => {
    const { store, recorded } = makeStore({
      settings: { postMergeEvidence: { provider: "onedev", baseUrl: "http://192.168.12.60:6610", tokenSecret: "onedev-token" } },
      secrets: [{ id: "sec-1", key: "onedev-token" }],
    });
    await resolvePostMergeEvidenceContract(store, {
      // OneDev remote carrying userinfo: legal in a git remote, forbidden in an audit row.
      readRemoteUrl: async () => "http://ci-user:s3cr3t-build@192.168.12.60:6610/saneca.git",
      countGitHubWorkflowFiles: async () => 0,
      auditHost: store as never,
    });
    const serialised = JSON.stringify(recorded);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ metadata: { provider: "onedev", credentialConfigured: true } });
    expect(serialised).not.toContain("s3cr3t-build");
    expect(serialised).not.toContain("ci-user");
    expect(serialised).not.toContain("onedev-token");
    // The row is ids/facts-only: not a scheme, not a userinfo separator, not a path.
    expect(serialised).not.toContain("http");
    expect(serialised).not.toContain("@");
    expect(serialised).not.toContain(ROOT);
    expect(serialised).not.toContain("192.168.12.60:6610/saneca");
  });

  it("consults the endpoint resolver once per project root and never for an unreadable repo", async () => {
    const { store } = makeStore();
    const resolveReporterEndpoints = vi.fn(async () => [{ provider: "onedev", baseUrl: "http://192.168.12.60:6610" }] as never);
    const deps = { readRemoteUrl: async () => onedevRemote, countGitHubWorkflowFiles: async () => 0, resolveReporterEndpoints };
    await resolvePostMergeEvidenceContract(store, deps);
    await resolvePostMergeEvidenceContract(store, deps);
    expect(resolveReporterEndpoints).toHaveBeenCalledTimes(1);

    const notCalled = vi.fn(async () => [] as never[]);
    await resolvePostMergeEvidenceContract(makeStore({ rootDir: "/repo/git-down" }).store, {
      readRemoteUrl: async () => { throw new Error("git down"); },
      countGitHubWorkflowFiles: async () => 0,
      resolveReporterEndpoints: notCalled,
    });
    // No origin to match against: the endpoint lookup is skipped, so a broken settings sink cannot even be
    // blamed for a contract that was already fail-closed on repo facts.
    expect(notCalled).not.toHaveBeenCalled();
  });
});
