import { describe, it, expect } from "vitest";
import {
  parseAgentOnboardingResponse,
  createAgentOnboardingSessionPrompt,
} from "../agent-onboarding.js";

describe("agent-onboarding", () => {
  it("parses question responses", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "question",
        data: {
          id: "q1",
          type: "text",
          question: "What should this agent focus on?",
        },
      }),
    );

    expect(parsed.type).toBe("question");
    if (parsed.type === "question") {
      expect(parsed.data.id).toBe("q1");
    }
  });

  it("parses complete summary responses", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "complete",
        data: {
          name: "Docs Reviewer",
          role: "reviewer",
          instructionsText: "Review docs for clarity and accuracy.",
          thinkingLevel: "medium",
          maxTurns: 20,
        },
      }),
    );

    expect(parsed.type).toBe("complete");
    if (parsed.type === "complete") {
      expect(parsed.data.name).toBe("Docs Reviewer");
      expect(parsed.data.maxTurns).toBe(20);
    }
  });

  it("rejects invalid complete summary", () => {
    expect(() =>
      parseAgentOnboardingResponse(
        JSON.stringify({
          type: "complete",
          data: {
            name: "",
            role: "reviewer",
            instructionsText: "",
            thinkingLevel: "medium",
            maxTurns: 0,
          },
        }),
      ),
    ).toThrow(/Invalid summary/);
  });

  it("builds compact onboarding context prompt", () => {
    const prompt = createAgentOnboardingSessionPrompt({
      intent: "Need a reviewer for docs",
      existingAgents: [{ id: "a1", name: "Alpha", role: "reviewer" }],
      templates: [{ id: "t1", label: "Reviewer Template", description: "General reviewer" }],
    });

    expect(prompt).toContain("Need a reviewer for docs");
    expect(prompt).toContain("a1:Alpha(reviewer)");
    expect(prompt).toContain("t1:Reviewer Template");
  });
});
