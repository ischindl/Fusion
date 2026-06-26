import { describe, it, expect, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import {
  resolveLlmReviewMode,
  parseLlmReviewResponse,
  evaluateLlmReviewGate,
  runLlmReviewVerification,
  runLlmReviewGate,
  type LlmReviewAgentDeps,
  type LlmReviewVerdict,
} from "../llm-review-verification.js";

/**
 * FNXC:Verification 2026-06-25-00:00:
 * Unit coverage for the OPT-IN LLM diff-review verification. The agent is mocked
 * via the `deps` seam (createFnAgent/promptWithFallback substitutes) so no real
 * AI call is made. Invariants under test:
 * - advisory mode NEVER fails verification,
 * - blocking mode fails ONLY on a passed:false + high-severity verdict,
 * - any infra/LLM error → advisory-unavailable (non-blocking) in EVERY mode,
 * - off mode → the reviewer agent is NOT invoked.
 */

// ── Mock agent (createFnAgent + promptWithFallback substitutes) ──────────

interface MockAgentOpts {
  response?: string;
  throwOnCreate?: Error;
  throwOnPrompt?: Error;
  sessionError?: string;
}

function makeAgentDeps(opts: MockAgentOpts): { deps: LlmReviewAgentDeps; createSpy: ReturnType<typeof vi.fn>; promptSpy: ReturnType<typeof vi.fn> } {
  let onTextCb: ((delta: string) => void) | undefined;
  const session = {
    state: opts.sessionError ? { errorMessage: opts.sessionError } : undefined,
    dispose: vi.fn(),
  };
  const createSpy = vi.fn(async (agentOpts: { onText?: (d: string) => void }) => {
    if (opts.throwOnCreate) throw opts.throwOnCreate;
    onTextCb = agentOpts.onText;
    return { session };
  });
  const promptSpy = vi.fn(async () => {
    if (opts.throwOnPrompt) throw opts.throwOnPrompt;
    if (opts.response && onTextCb) onTextCb(opts.response);
  });
  return {
    deps: { createAgent: createSpy as unknown as LlmReviewAgentDeps["createAgent"], prompt: promptSpy as unknown as LlmReviewAgentDeps["prompt"] },
    createSpy,
    promptSpy,
  };
}

function makeStore(): TaskStore {
  return {
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

const PASS_RESPONSE = JSON.stringify({ passed: true, summary: "looks good", findings: [] });
const HIGH_FAIL_RESPONSE = JSON.stringify({
  passed: false,
  summary: "introduces a regression",
  findings: [{ severity: "high", file: "src/foo.ts", summary: "null deref" }],
});
const MEDIUM_FAIL_RESPONSE = JSON.stringify({
  passed: false,
  summary: "minor concern",
  findings: [{ severity: "medium", file: "src/foo.ts", summary: "missing edge case" }],
});

// ── resolveLlmReviewMode ─────────────────────────────────────────────────

describe("resolveLlmReviewMode", () => {
  it("defaults to off when unset or unknown", () => {
    expect(resolveLlmReviewMode(undefined)).toBe("off");
    expect(resolveLlmReviewMode({} as Settings)).toBe("off");
    expect(resolveLlmReviewMode({ verificationLlmReview: "bogus" } as unknown as Settings)).toBe("off");
    expect(resolveLlmReviewMode({ verificationLlmReview: "off" } as Settings)).toBe("off");
  });
  it("returns the opt-in modes verbatim", () => {
    expect(resolveLlmReviewMode({ verificationLlmReview: "advisory" } as Settings)).toBe("advisory");
    expect(resolveLlmReviewMode({ verificationLlmReview: "blocking" } as Settings)).toBe("blocking");
  });
});

// ── parseLlmReviewResponse ───────────────────────────────────────────────

describe("parseLlmReviewResponse", () => {
  it("parses a clean JSON verdict", () => {
    const v = parseLlmReviewResponse(HIGH_FAIL_RESPONSE);
    expect(v.passed).toBe(false);
    expect(v.advisoryUnavailable).toBe(false);
    expect(v.findings).toEqual([{ severity: "high", file: "src/foo.ts", summary: "null deref" }]);
  });
  it("strips markdown fences", () => {
    const v = parseLlmReviewResponse("```json\n" + PASS_RESPONSE + "\n```");
    expect(v.passed).toBe(true);
  });
  it("normalizes severity aliases and missing files", () => {
    const v = parseLlmReviewResponse(JSON.stringify({ passed: false, findings: [{ severity: "critical", summary: "x" }] }));
    expect(v.findings[0]).toEqual({ severity: "high", file: "(unknown)", summary: "x" });
  });
  it("throws on invalid JSON", () => {
    expect(() => parseLlmReviewResponse("not json at all")).toThrow();
  });
  it("throws when 'passed' is missing", () => {
    expect(() => parseLlmReviewResponse(JSON.stringify({ summary: "x", findings: [] }))).toThrow();
  });
});

// ── evaluateLlmReviewGate ────────────────────────────────────────────────

const verdict = (over: Partial<LlmReviewVerdict>): LlmReviewVerdict => ({
  passed: true,
  findings: [],
  summary: "",
  advisoryUnavailable: false,
  ...over,
});

describe("evaluateLlmReviewGate", () => {
  it("advisory mode never blocks, even on a high-severity failure", () => {
    expect(evaluateLlmReviewGate("advisory", verdict({ passed: false, findings: [{ severity: "high", file: "a", summary: "b" }] })).blocks).toBe(false);
  });
  it("off mode never blocks", () => {
    expect(evaluateLlmReviewGate("off", verdict({ passed: false, findings: [{ severity: "high", file: "a", summary: "b" }] })).blocks).toBe(false);
  });
  it("blocking mode blocks on passed:false + high severity", () => {
    const res = evaluateLlmReviewGate("blocking", verdict({ passed: false, findings: [{ severity: "high", file: "a", summary: "b" }] }));
    expect(res.blocks).toBe(true);
    expect(res.reason).toContain("high-severity");
  });
  it("blocking mode does NOT block when passed:true", () => {
    expect(evaluateLlmReviewGate("blocking", verdict({ passed: true, findings: [{ severity: "high", file: "a", summary: "b" }] })).blocks).toBe(false);
  });
  it("blocking mode does NOT block on medium-only findings", () => {
    expect(evaluateLlmReviewGate("blocking", verdict({ passed: false, findings: [{ severity: "medium", file: "a", summary: "b" }] })).blocks).toBe(false);
  });
  it("advisory-unavailable never blocks, even in blocking mode", () => {
    expect(evaluateLlmReviewGate("blocking", verdict({ passed: false, advisoryUnavailable: true, findings: [{ severity: "high", file: "a", summary: "b" }] })).blocks).toBe(false);
  });
});

// ── runLlmReviewVerification (mocked agent) ──────────────────────────────

describe("runLlmReviewVerification", () => {
  it("returns the parsed verdict from the model", async () => {
    const { deps } = makeAgentDeps({ response: HIGH_FAIL_RESPONSE });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "diff --git a b", deps });
    expect(v.passed).toBe(false);
    expect(v.advisoryUnavailable).toBe(false);
    expect(v.findings[0].severity).toBe("high");
  });

  it("treats an empty diff as a clean pass without invoking the agent", async () => {
    const { deps, createSpy } = makeAgentDeps({ response: PASS_RESPONSE });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "   ", deps });
    expect(v.passed).toBe(true);
    expect(v.advisoryUnavailable).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("returns advisory-unavailable (non-blocking) when agent creation fails", async () => {
    const { deps } = makeAgentDeps({ throwOnCreate: new Error("provider down") });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "diff", deps });
    expect(v.advisoryUnavailable).toBe(true);
    expect(v.passed).toBe(true);
  });

  it("returns advisory-unavailable when the prompt call throws", async () => {
    const { deps } = makeAgentDeps({ throwOnPrompt: new Error("rate limited") });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "diff", deps });
    expect(v.advisoryUnavailable).toBe(true);
  });

  it("returns advisory-unavailable when the session reports an error state", async () => {
    const { deps } = makeAgentDeps({ sessionError: "usage limit reached" });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "diff", deps });
    expect(v.advisoryUnavailable).toBe(true);
  });

  it("returns advisory-unavailable on malformed (non-JSON) output", async () => {
    const { deps } = makeAgentDeps({ response: "I think it's fine, ship it!" });
    const v = await runLlmReviewVerification({ rootDir: "/x", diff: "diff", deps });
    expect(v.advisoryUnavailable).toBe(true);
  });
});

// ── runLlmReviewGate (mode wiring) ───────────────────────────────────────

const fixedDiff = async () => "diff --git a/x b/x";

describe("runLlmReviewGate", () => {
  it("off mode: does NOT invoke the reviewer and never blocks", async () => {
    const { deps, createSpy } = makeAgentDeps({ response: HIGH_FAIL_RESPONSE });
    const gate = await runLlmReviewGate({
      store: makeStore(),
      rootDir: "/x",
      taskId: "FN-1",
      settings: { verificationLlmReview: "off" } as Settings,
      deps,
      captureDiff: fixedDiff,
    });
    expect(gate.ran).toBe(false);
    expect(gate.verdict).toBeNull();
    expect(gate.blocked).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("advisory mode: runs, never blocks on a high-severity failure", async () => {
    const { deps } = makeAgentDeps({ response: HIGH_FAIL_RESPONSE });
    const gate = await runLlmReviewGate({
      store: makeStore(),
      rootDir: "/x",
      taskId: "FN-1",
      settings: { verificationLlmReview: "advisory" } as Settings,
      deps,
      captureDiff: fixedDiff,
    });
    expect(gate.ran).toBe(true);
    expect(gate.verdict?.passed).toBe(false);
    expect(gate.blocked).toBe(false);
  });

  it("blocking mode: blocks on a passed:false + high-severity verdict", async () => {
    const { deps } = makeAgentDeps({ response: HIGH_FAIL_RESPONSE });
    const gate = await runLlmReviewGate({
      store: makeStore(),
      rootDir: "/x",
      taskId: "FN-1",
      settings: { verificationLlmReview: "blocking" } as Settings,
      deps,
      captureDiff: fixedDiff,
    });
    expect(gate.blocked).toBe(true);
  });

  it("blocking mode: does NOT block on medium-only findings", async () => {
    const { deps } = makeAgentDeps({ response: MEDIUM_FAIL_RESPONSE });
    const gate = await runLlmReviewGate({
      store: makeStore(),
      rootDir: "/x",
      taskId: "FN-1",
      settings: { verificationLlmReview: "blocking" } as Settings,
      deps,
      captureDiff: fixedDiff,
    });
    expect(gate.blocked).toBe(false);
  });

  it("blocking mode: an LLM/infra error degrades to advisory-unavailable (non-blocking)", async () => {
    const { deps } = makeAgentDeps({ throwOnPrompt: new Error("outage") });
    const gate = await runLlmReviewGate({
      store: makeStore(),
      rootDir: "/x",
      taskId: "FN-1",
      settings: { verificationLlmReview: "blocking" } as Settings,
      deps,
      captureDiff: fixedDiff,
    });
    expect(gate.verdict?.advisoryUnavailable).toBe(true);
    expect(gate.blocked).toBe(false);
  });
});
