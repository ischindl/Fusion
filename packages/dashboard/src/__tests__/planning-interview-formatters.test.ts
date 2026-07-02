import { describe, expect, it } from "vitest";
import type { PlanningQuestion } from "@fusion/core";
import { formatInterviewQA, formatResponseForAgent } from "../planning";

const singleSelectQuestion: PlanningQuestion = {
  id: "scope",
  type: "single_select",
  question: "What scope should we plan?",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full launch" },
  ],
};

const multiSelectQuestion: PlanningQuestion = {
  id: "priorities",
  type: "multi_select",
  question: "Which priorities matter?",
  options: [
    { id: "speed", label: "Speed" },
    { id: "quality", label: "Quality" },
  ],
};

const confirmQuestion: PlanningQuestion = {
  id: "proceed",
  type: "confirm",
  question: "Proceed with this plan?",
};

describe("planning interview formatter Other answers", () => {
  it("formats Other-only single-select answers for the planning agent and Q&A history", () => {
    const response = { _other: "Run discovery first" };

    expect(formatResponseForAgent(singleSelectQuestion, response)).toContain(
      "Selected: Run discovery first (user's own answer)",
    );
    expect(formatInterviewQA([{ question: singleSelectQuestion, response }])).toContain(
      "A: Run discovery first (user's own answer)",
    );
  });

  it("appends Other text to multi-select option labels for the planning agent and Q&A history", () => {
    const response = { priorities: ["speed"], _other: "Keep humans in review" };

    expect(formatResponseForAgent(multiSelectQuestion, response)).toContain(
      "Selected: Speed, Keep humans in review (user's own answer)",
    );
    expect(formatInterviewQA([{ question: multiSelectQuestion, response }])).toContain(
      "A: Speed, Keep humans in review (user's own answer)",
    );
  });

  it("formats confirm Yes and No answers without changing boolean semantics", () => {
    expect(formatResponseForAgent(confirmQuestion, { proceed: true })).toContain("Answer: Yes");
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: true } }])).toContain("A: Yes");

    expect(formatResponseForAgent(confirmQuestion, { proceed: false })).toContain("Answer: No");
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: false } }])).toContain("A: No");
  });

  it("formats confirm Other answers and comments as first-class custom answers", () => {
    const response = { _other: "Ask a different scoping question", _comment: "Need product input" };

    expect(formatResponseForAgent(confirmQuestion, response)).toContain(
      "Answer: Ask a different scoping question (user's own answer)",
    );
    expect(formatResponseForAgent(confirmQuestion, response)).toContain("Additional context: Need product input");
    expect(formatInterviewQA([{ question: confirmQuestion, response }])).toContain(
      "A: Ask a different scoping question (user's own answer)",
    );
    expect(formatInterviewQA([{ question: confirmQuestion, response }])).toContain("Comment: Need product input");
  });
});
