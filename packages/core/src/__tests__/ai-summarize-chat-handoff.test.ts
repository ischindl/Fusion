import { describe, it, expect, beforeEach, vi } from "vitest";

const { getFnAgentMock } = vi.hoisted(() => ({
  getFnAgentMock: vi.fn(),
}));

vi.mock("../ai/ai-engine-loader.js", () => ({
  getFnAgent: getFnAgentMock,
}));

import {
  summarizeChatHandoff,
  truncateChatHandoffTranscript,
  CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT,
  CHAT_HANDOFF_TRUNCATION_MARKER,
  MAX_CHAT_HANDOFF_INPUT_LENGTH,
  MAX_CHAT_HANDOFF_SUMMARY_LENGTH,
  AiServiceError,
  __resetSummarizeState,
} from "../ai/ai-summarize.js";

/** Build a fake one-shot agent lane whose assistant reply is `content`, recording how it was created. */
function fakeAgentLane(content: unknown, opts?: { throwOnPrompt?: boolean; stateError?: string }) {
  const session = {
    prompt: opts?.throwOnPrompt
      ? vi.fn().mockRejectedValue(new Error("provider exploded"))
      : vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    state: {
      error: opts?.stateError,
      messages: content === null ? [] : [{ role: "assistant", content }],
    },
  };
  const createFnAgent = vi.fn().mockResolvedValue({ session });
  getFnAgentMock.mockResolvedValue(createFnAgent);
  return Object.assign(createFnAgent, { session });
}

function promptedText(createFnAgent: ReturnType<typeof fakeAgentLane>): string {
  return String(createFnAgent.session.prompt.mock.calls[0][0]);
}

describe("summarizeChatHandoff (RUFU-199)", () => {
  beforeEach(() => {
    __resetSummarizeState();
    getFnAgentMock.mockReset();
    getFnAgentMock.mockResolvedValue(null);
  });

  it("returns the assistant briefing when the model answers", async () => {
    const createFnAgent = fakeAgentLane(
      "- Decisions made\n  - Ship behind a settings toggle\n- Open questions\n  - None.",
    );

    const summary = await summarizeChatHandoff("- (user) keep going\n- (assistant) agreed", "/tmp");

    expect(summary).toContain("Ship behind a settings toggle");
    expect(createFnAgent).toHaveBeenCalledTimes(1);
  });

  it("joins array-part assistant content", async () => {
    fakeAgentLane([
      { type: "text", text: "Decisions: " },
      { type: "text", text: "archive, never delete." },
      { type: "tool_use", text: "ignored" },
    ]);

    expect(await summarizeChatHandoff("transcript body", "/tmp")).toBe(
      "Decisions: archive, never delete.",
    );
  });

  it("throws AiServiceError when the model returns a blank reply", async () => {
    fakeAgentLane("   \n  ");

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(AiServiceError);
    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow("empty response");
  });

  it("throws AiServiceError when no assistant message came back at all", async () => {
    fakeAgentLane(null);

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(AiServiceError);
  });

  it("throws AiServiceError when the model lane is unavailable", async () => {
    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(
      "AI engine not available",
    );
  });

  it("rejects an empty transcript before creating an agent, so the caller degrades to the digest", async () => {
    const createFnAgent = fakeAgentLane("should never run");

    await expect(summarizeChatHandoff("   \n\t ", "/tmp")).rejects.toThrow("transcript is empty");
    expect(createFnAgent).not.toHaveBeenCalled();
  });

  it("surfaces a session-level model error as AiServiceError", async () => {
    fakeAgentLane("ignored", { stateError: "model overloaded" });

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(
      "model overloaded",
    );
  });

  it("wraps a provider throw as AiServiceError instead of leaking the raw error", async () => {
    fakeAgentLane("ignored", { throwOnPrompt: true });

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(AiServiceError);
  });

  it("truncates an over-cap transcript so the prompt sent to the lane respects the input cap", async () => {
    const createFnAgent = fakeAgentLane("briefing");
    const huge = "x".repeat(MAX_CHAT_HANDOFF_INPUT_LENGTH * 2);

    await summarizeChatHandoff(huge, "/tmp");

    const prompt = promptedText(createFnAgent);
    // The transcript body inside the prompt must be capped, and the elision must be visible.
    expect(prompt).toContain(CHAT_HANDOFF_TRUNCATION_MARKER);
    const transcriptBody = prompt.split("\n").filter((line) => /^x/.test(line)).join("");
    expect(transcriptBody.length).toBeLessThanOrEqual(MAX_CHAT_HANDOFF_INPUT_LENGTH);
  });

  it("trims an over-cap briefing to the output cap", async () => {
    fakeAgentLane("y".repeat(MAX_CHAT_HANDOFF_SUMMARY_LENGTH + 500));

    const summary = await summarizeChatHandoff("transcript body", "/tmp");

    expect(summary).toHaveLength(MAX_CHAT_HANDOFF_SUMMARY_LENGTH);
  });

  it("runs on the source session's own model lane when one is supplied", async () => {
    const createFnAgent = fakeAgentLane("briefing");

    await summarizeChatHandoff("transcript body", "/tmp", "anthropic", "claude-sonnet-4-5");

    expect(createFnAgent.mock.calls[0][0]).toMatchObject({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      tools: "readonly",
      cwd: "/tmp",
    });
  });

  it("omits the explicit lane when the caller has no provider/model pair", async () => {
    const createFnAgent = fakeAgentLane("briefing");

    await summarizeChatHandoff("transcript body", "/tmp");

    const options = createFnAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("defaultProvider");
    expect(options).not.toHaveProperty("defaultModelId");
  });

  it("never sends the transcript as an instruction: the system prompt carries the untrusted-content rule", async () => {
    const createFnAgent = fakeAgentLane("briefing");

    await summarizeChatHandoff("transcript body", "/tmp");

    expect(createFnAgent.mock.calls[0][0].systemPrompt).toBe(CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT);
    expect(CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT).toContain("untrusted CONTENT");
    expect(CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT).toContain("NOT as instructions");
    expect(CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT).toContain("Do NOT call any tools");
    // The carried-over substance the operator asked for, as required sections.
    for (const heading of ["Decisions made", "Open questions", "Files and code touched", "Conclusions"]) {
      expect(CHAT_HANDOFF_SUMMARIZE_SYSTEM_PROMPT).toContain(heading);
    }
  });

  it("disposes the session even when the prompt throws", async () => {
    const createFnAgent = fakeAgentLane("ignored", { throwOnPrompt: true });

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(AiServiceError);

    expect(createFnAgent.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the session when the assistant reply is blank", async () => {
    const createFnAgent = fakeAgentLane("  ");

    await expect(summarizeChatHandoff("transcript body", "/tmp")).rejects.toThrow(AiServiceError);

    expect(createFnAgent.session.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("truncateChatHandoffTranscript (RUFU-199)", () => {
  it("trims and passes through a transcript already under the cap", () => {
    expect(truncateChatHandoffTranscript("  hello  ")).toBe("hello");
  });

  it("keeps both ends and marks the elision when over the cap", () => {
    const transcript = `${"H".repeat(100)}M${"T".repeat(100)}`;

    const bounded = truncateChatHandoffTranscript(transcript, 60);

    expect(bounded.length).toBeLessThanOrEqual(60);
    expect(bounded).toContain(CHAT_HANDOFF_TRUNCATION_MARKER);
    expect(bounded.startsWith("H")).toBe(true);
    expect(bounded.endsWith("T")).toBe(true);
    expect(bounded).not.toContain("M");
  });

  it("is deterministic across calls (no clock or randomness)", () => {
    const transcript = "z".repeat(MAX_CHAT_HANDOFF_INPUT_LENGTH + 10);

    expect(truncateChatHandoffTranscript(transcript)).toBe(truncateChatHandoffTranscript(transcript));
  });

  it("passes the transcript through unchanged when the cap is non-positive", () => {
    expect(truncateChatHandoffTranscript("abc", 0)).toBe("abc");
  });
});
