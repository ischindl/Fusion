/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:51 (RUFU-457):
RUFU-430 gave the post-merge evidence contract a `provider` axis but shipped one reporter, so every OneDev and
GitLab board resolved `none` and was exempted from the CI evidence gate — 24 boards in this fleet with a real
pipeline and no machine-checked delivery gate. These cases pin the two new reporters at the fact layer and, more
importantly, the boundaries that keep the addition from becoming a new way to lose a gate: an endpoint only ever
ADDS a reporter (it cannot erase `no-remote`, `repo-facts-unreadable`, or an operator's `none`), the match is
host+port rather than host-only (this fleet's OneDev is `http://192.168.12.60:6610`, so a second service on the
same box must not claim the board), and no returned value ever carries a token or userinfo because a git remote
can legitimately embed one.
*/
import { describe, expect, it } from "vitest";
import {
  derivePostMergeEvidenceContract,
  isPostMergeEvidenceUnreportable,
  normalizePostMergeReporterBaseUrl,
  parseDeclaredPostMergeEvidence,
} from "../merge/post-merge-evidence-contract.js";
import type { PostMergeReporterEndpoint } from "../merge/post-merge-evidence-contract.js";

const OBSERVED_AT = "2026-10-01T06:00:00.000Z";

const onedevEndpoint: PostMergeReporterEndpoint = {
  provider: "onedev",
  baseUrl: "http://192.168.12.60:6610",
  credentialConfigured: true,
};
const gitlabSelfHosted: PostMergeReporterEndpoint = { provider: "gitlab", baseUrl: "https://gitlab.digitalsystems.eu" };
const gitlabCloud: PostMergeReporterEndpoint = { provider: "gitlab", baseUrl: "https://gitlab.com" };

function derive(input: Parameters<typeof derivePostMergeEvidenceContract>[0]) {
  return derivePostMergeEvidenceContract({ ...input, observedAt: OBSERVED_AT });
}

describe("OneDev reporter derivation", () => {
  it("names OneDev when the configured OneDev endpoint serves the origin, port included", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [onedevEndpoint],
    });
    expect(contract).toMatchObject({
      provider: "onedev",
      source: "derived",
      reason: "onedev-endpoint",
      endpointHost: "192.168.12.60:6610",
      credentialConfigured: true,
      observedAt: OBSERVED_AT,
    });
    // The whole point of the new provider: this board is no longer excused from the CI evidence gate.
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(false);
  });

  it("CONTROL: a different port on the same host is a different service, so the board stays unreportable", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [{ provider: "onedev", baseUrl: "http://192.168.12.60:8080" }],
    });
    expect(contract).toMatchObject({ provider: "none", reason: "non-github-remote" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(true);
  });

  it("treats an explicit default port as the same reporter", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "https://onedev.internal:443/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [{ provider: "onedev", baseUrl: "https://onedev.internal" }],
    });
    expect(contract).toMatchObject({ provider: "onedev", reason: "onedev-endpoint" });
  });

  it("matches the scp-style remote on host alone, since git's ssh syntax has no port slot", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "git@onedev.internal:saneca/core.git", githubWorkflowFileCount: 0 },
      endpoints: [{ provider: "onedev", baseUrl: "https://onedev.internal:6610" }],
    });
    expect(contract).toMatchObject({ provider: "onedev", reason: "onedev-endpoint", endpointHost: "onedev.internal:6610" });
  });
});

describe("GitLab reporter derivation", () => {
  it("names GitLab for a self-managed instance whose configured URL matches the origin", () => {
    const contract = derive({
      repo: {
        factsReadable: true,
        remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git",
        githubWorkflowFileCount: 0,
      },
      endpoints: [gitlabSelfHosted],
    });
    expect(contract).toMatchObject({ provider: "gitlab", source: "derived", reason: "gitlab-endpoint" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(false);
  });

  it("names GitLab for gitlab.com, which previously fell through to the exemption", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "https://gitlab.com/acme/rozvrh.git", githubWorkflowFileCount: 0 },
      endpoints: [gitlabCloud],
    });
    expect(contract).toMatchObject({ provider: "gitlab", reason: "gitlab-endpoint", endpointHost: "gitlab.com" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(false);
  });

  it("CONTROL: the same self-managed remote with no configured instance keeps RUFU-430's exemption unchanged", () => {
    const contract = derive({
      repo: {
        factsReadable: true,
        remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git",
        githubWorkflowFileCount: 0,
      },
    });
    expect(contract).toMatchObject({ provider: "none", source: "derived", reason: "non-github-remote" });
    expect(contract.endpointHost).toBeUndefined();
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(true);
  });

  it("never re-routes a GitHub origin onto a GitLab endpoint that happens to name github.com", () => {
    // Endpoint candidates are OneDev/GitLab only, so a GitHub board keeps the historical shard contract.
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "https://github.com/Runfusion/Fusion.git", githubWorkflowFileCount: 11 },
      endpoints: [gitlabCloud, onedevEndpoint],
    });
    expect(contract).toMatchObject({ provider: "github-actions", reason: "github-remote-with-workflows" });
    expect(contract.endpointHost).toBeUndefined();
  });
});

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:51 (RUFU-457):
The credential boundary, pinned where it is cheapest to prove. A remote may carry `https://<token>@host/...`,
so the classifier reads the token-bearing URL and the CONTRACT MUST NOT ECHO IT: only host[:port] is ever
taken out of the parsed URL, and the token side of the pair is a project-secret REFERENCE.
*/
describe("reporter endpoints never carry a credential", () => {
  it("classifies a userinfo-bearing remote while returning nothing that could be the credential", () => {
    const secret = "glpat-Sup3rS3cr3tTokenValue";
    const contract = derive({
      repo: {
        factsReadable: true,
        remoteUrl: `https://${secret}@gitlab.digitalsystems.eu/ai/test_banks.git`,
        githubWorkflowFileCount: 0,
      },
      endpoints: [gitlabSelfHosted],
    });
    expect(contract).toMatchObject({ provider: "gitlab", reason: "gitlab-endpoint" });
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("gitlab.digitalsystems.eu/ai");
    expect(contract.endpointHost).toBe("gitlab.digitalsystems.eu");
  });

  it("reports credential presence as a boolean, never as the reference it was derived from", () => {
    const declared = parseDeclaredPostMergeEvidence({
      provider: "onedev",
      baseUrl: "http://192.168.12.60:6610",
      tokenSecret: "ONDEV_SA_TOKEN",
    });
    expect(declared).toEqual({ provider: "onedev", baseUrl: "http://192.168.12.60:6610", tokenSecret: "ONDEV_SA_TOKEN" });

    const contract = derive({
      declared,
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
    });
    expect(contract).toMatchObject({ provider: "onedev", reason: "onedev-endpoint", credentialConfigured: true });
    expect(JSON.stringify(contract)).not.toContain("ONDEV_SA_TOKEN");
  });

  it("refuses a base URL that embeds userinfo, so a secret cannot be persisted as configuration", () => {
    expect(normalizePostMergeReporterBaseUrl("https://oauth2:tok@gitlab.example.com/")).toBeUndefined();
    expect(normalizePostMergeReporterBaseUrl("not a url")).toBeUndefined();
    expect(normalizePostMergeReporterBaseUrl("ftp://gitlab.example.com")).toBeUndefined();
    expect(normalizePostMergeReporterBaseUrl("https://gitlab.example.com/ci/?token=abc#frag")).toBe(
      "https://gitlab.example.com/ci",
    );
    expect(normalizePostMergeReporterBaseUrl(undefined)).toBeUndefined();
    expect(normalizePostMergeReporterBaseUrl(42)).toBeUndefined();
  });

  it("drops a malformed endpoint field individually instead of cancelling the operator's declaration", () => {
    // Losing the whole declaration would fall through to derivation, and derivation of an unmatched host is
    // `none`: a misspelled URL would relax a completion gate.
    expect(parseDeclaredPostMergeEvidence({ provider: "gitlab", baseUrl: "https://" })).toEqual({ provider: "gitlab" });
    expect(parseDeclaredPostMergeEvidence({ provider: "gitlab", tokenSecret: "https://x/y" })).toEqual({
      provider: "gitlab",
    });
    expect(parseDeclaredPostMergeEvidence({ provider: "gitlab", baseUrl: "https://gitlab.example.com/" })).toEqual({
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com",
    });
  });
});

describe("declaration still outranks derivation, in both directions", () => {
  it("keeps a declared provider when the configured host does not match the origin", () => {
    const contract = derive({
      declared: { provider: "onedev", baseUrl: "https://onedev.example.com", note: "staging board" },
      repo: { factsReadable: true, remoteUrl: "https://gitlab.com/acme/rozvrh.git", githubWorkflowFileCount: 0 },
      endpoints: [gitlabCloud],
    });
    // The operator's word decides, but the row must not claim a host match that never happened.
    expect(contract).toMatchObject({ provider: "onedev", source: "declared", reason: "operator-declared" });
    expect(contract.endpointHost).toBe("onedev.example.com");
  });

  it("reports the endpoint reason when a declaration names the endpoint this origin actually serves", () => {
    const contract = derive({
      declared: { provider: "gitlab", baseUrl: "https://gitlab.digitalsystems.eu" },
      repo: {
        factsReadable: true,
        remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git",
        githubWorkflowFileCount: 0,
      },
    });
    expect(contract).toMatchObject({ provider: "gitlab", source: "declared", reason: "gitlab-endpoint" });
  });

  it("CONTROL: a declared 'none' still exempts a board that has a matching reporter", () => {
    const contract = derive({
      declared: { provider: "none", note: "CI is manual here" },
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [onedevEndpoint],
    });
    expect(contract).toMatchObject({ provider: "none", source: "declared", reason: "operator-declared" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(true);
  });

  it("lets a configured endpoint claim a declared board whose declaration named no URL", () => {
    const contract = derive({
      declared: { provider: "onedev" },
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [onedevEndpoint],
    });
    expect(contract).toMatchObject({ provider: "onedev", reason: "onedev-endpoint" });
  });
});

/*
FNXC:PostMergeEvidenceContract 2026-10-01-06:51 (RUFU-457):
Fail-closed order. An endpoint is the weakest fact in the room: it may ADD a reporter and may never REMOVE a
gate, so the guards that existed before RUFU-457 must still win when an endpoint matches.
*/
describe("an endpoint cannot relax a fail-closed guard", () => {
  it("keeps an unreadable repo on the historical blocking contract even with a matching endpoint", () => {
    const contract = derive({
      repo: { factsReadable: false },
      endpoints: [onedevEndpoint],
    });
    expect(contract).toMatchObject({ provider: "github-actions", reason: "repo-facts-unreadable" });
    expect(contract.endpointHost).toBeUndefined();
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(false);
  });

  it("keeps a board with no origin exempt even when an endpoint is configured", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: null, githubWorkflowFileCount: 0 },
      endpoints: [onedevEndpoint],
    });
    expect(contract).toMatchObject({ provider: "none", reason: "no-remote" });
    expect(isPostMergeEvidenceUnreportable(contract)).toBe(true);
  });

  it("takes the first matching endpoint in configured order", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "https://gitlab.example.com/team/app.git", githubWorkflowFileCount: 0 },
      endpoints: [
        { provider: "onedev", baseUrl: "https://gitlab.example.com" },
        { provider: "gitlab", baseUrl: "https://gitlab.example.com" },
      ],
    });
    expect(contract).toMatchObject({ provider: "onedev", reason: "onedev-endpoint" });
  });

  it("ignores endpoint candidates that are not usable", () => {
    const contract = derive({
      repo: { factsReadable: true, remoteUrl: "https://gitlab.example.com/team/app.git", githubWorkflowFileCount: 0 },
      endpoints: [{ provider: "gitlab", baseUrl: "  " }, { provider: "gitlab", baseUrl: "https://gitlab.example.com" }],
    });
    expect(contract).toMatchObject({ provider: "gitlab", reason: "gitlab-endpoint" });
  });
});
