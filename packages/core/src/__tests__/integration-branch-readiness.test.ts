import { describe, expect, it } from "vitest";
import { selectIntegrationBranch } from "../git/integration-branch-readiness.js";

describe("selectIntegrationBranch", () => {
  it("prefers an explicitly configured branch over every inferred candidate", () => {
    expect(selectIntegrationBranch({
      configuredBranch: "release/1.0",
      originHeadBranch: "develop",
      localBranches: ["main"],
      currentBranch: "main",
      remoteBranches: ["trunk"],
    })).toEqual({ branch: "release/1.0", source: "configured" });
  });

  it("prefers origin/HEAD over local and remote candidates", () => {
    expect(selectIntegrationBranch({
      originHeadBranch: "develop",
      localBranches: ["main"],
      currentBranch: "main",
      remoteBranches: ["trunk"],
    })).toEqual({ branch: "develop", source: "origin-head" });
  });

  it("adopts master when it is the only well-known local branch", () => {
    expect(selectIntegrationBranch({ localBranches: ["master"] })).toEqual({
      branch: "master",
      source: "well-known-local",
    });
  });

  it("prefers main over master when both are local", () => {
    expect(selectIntegrationBranch({ localBranches: ["master", "main"] })).toEqual({
      branch: "main",
      source: "well-known-local",
    });
  });

  it("uses the current local branch when no well-known local branch exists", () => {
    expect(selectIntegrationBranch({
      localBranches: ["alpha", "develop-topic"],
      currentBranch: "develop-topic",
    })).toEqual({ branch: "develop-topic", source: "current-head" });
  });

  it("uses a sole local branch from detached HEAD", () => {
    expect(selectIntegrationBranch({ localBranches: ["release/1.0"] })).toEqual({
      branch: "release/1.0",
      source: "sole-local",
    });
  });

  it("adopts the sole remote-tracking branch when no local branch is available", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["develop"],
    })).toEqual({ branch: "develop", source: "remote-tracking" });
  });

  it("prefers a well-known remote branch when remote inference has choices", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["topic", "main"],
    })).toEqual({ branch: "main", source: "remote-tracking" });
  });

  it("refuses ambiguous remote-only branch sets", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["alpha", "beta"],
    })).toBeNull();
  });

  it("never lets remote inference override an available local branch", () => {
    expect(selectIntegrationBranch({
      localBranches: ["release/1.0"],
      remoteBranches: ["main"],
    })).toEqual({ branch: "release/1.0", source: "sole-local" });
  });

  it("never infers Fusion sibling branches", () => {
    expect(selectIntegrationBranch({
      localBranches: ["fusion/fn-123"],
      remoteBranches: ["fusion/fn-456"],
    })).toBeNull();
  });

  /*
  FNXC:LandedTruthCensus 2026-11-05-18:50 (RUFU-702):
  The exclusion above was `^fusion/fn-`, so on a `RUFU-`/`SANE-`/`KB-` board a task branch stayed a legal
  INTEGRATION candidate. This resolver is the inference tier of `resolveIntegrationBranch`, which is what
  RUFU-702's landing door asks for its yardstick — so on this very board a door could have measured delivery
  against `fusion/rufu-293` and certified RUFU-294's own refusal as success. These cases pin that the board
  prefix is no longer load-bearing, in every inferred tier, and that a sanctioned intermediate and a human
  branch sharing the `fusion/` prefix keep resolving.
  */
  it.each(["fusion/rufu-293", "fusion/sane-430", "fusion/kb-001", "fusion/rufu-294-stranded"])(
    "never infers a %s task branch as the integration branch on a non-FN board",
    (taskBranch) => {
      expect(selectIntegrationBranch({ localBranches: [taskBranch] })).toBeNull();
      expect(selectIntegrationBranch({ localBranches: [], remoteBranches: [taskBranch] })).toBeNull();
      expect(selectIntegrationBranch({
        localBranches: [taskBranch],
        currentBranch: taskBranch,
      })).toBeNull();
    },
  );

  it("still infers a real integration branch sitting beside a foreign-board task branch", () => {
    // The exclusion must not over-reach: one task branch in the list must not blind inference to `main`.
    expect(selectIntegrationBranch({
      localBranches: ["fusion/rufu-293", "release/1.0"],
    })).toEqual({ branch: "release/1.0", source: "sole-local" });
  });

  it("keeps a sanctioned group branch and a human fusion/-prefixed branch inferable", () => {
    // `fusion/groups/<slug>` is a shared-group intermediate and `fusion/release-1.0` is a human branch that
    // merely shares the prefix; neither is the task-branch shape this guard exists to exclude.
    expect(selectIntegrationBranch({
      localBranches: ["fusion/groups/reliability"],
    })).toEqual({ branch: "fusion/groups/reliability", source: "sole-local" });
    expect(selectIntegrationBranch({
      localBranches: ["fusion/release-1.0"],
    })).toEqual({ branch: "fusion/release-1.0", source: "sole-local" });
  });

  it("treats blank configured and origin-head values as unset", () => {
    expect(selectIntegrationBranch({
      configuredBranch: "  ",
      originHeadBranch: "\t",
      localBranches: [" master "],
    })).toEqual({ branch: "master", source: "well-known-local" });
  });
});
