import { describe, expect, it } from "vitest";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";

function capture() {
  const text: string[] = []; const thinking: string[] = []; const boundaries: number[] = [];
  return { text, thinking, boundaries, seam: createAssistantStreamCapture({ onText: (value) => text.push(value), onThinking: (value) => thinking.push(value), onTextBlockBoundary: () => boundaries.push(1) }) };
}
function update(assistantMessageEvent: Record<string, unknown>) { return { type: "message_update", assistantMessageEvent }; }

describe("createAssistantStreamCapture", () => {
  it("captures delta, start, terminal, and message-end text exactly once", () => {
    const result = capture(); const partial = { content: [{ type: "text", text: "Hello" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Hello" }));
    result.seam.handleAgentEvent(update({ type: "text_end", partial, contentIndex: 0, content: "Hello world" }));
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("Hello world");
  });
  it("flushes populated starts, partial terminal remainders, and message-end-only blocks", () => {
    const result = capture(); const partial = { content: [{ type: "text", text: "Opening sentence." }] };
    result.seam.handleAgentEvent(update({ type: "text_start", partial, contentIndex: 0 }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Next" }));
    expect(result.text).toEqual(["Opening sentence.", " Next"]);
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Message-end text" }] } });
    expect(result.text.at(-1)).toBe("Message-end text");
  });
  it("resets message identity, preserves mock deltas, and ignores malformed blocks", () => {
    const result = capture();
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "GPT-5." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: "mock", contentIndex: 0, delta: "6" }));
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: { content: [{ type: "text", text: "REPRO MARKER B" }] }, contentIndex: 0, delta: "REPRO MARKER B" }));
    /*
    FNXC:AssistantTextCapture 2026-09-13-21:15:
    RUFU-234 states the decision this case pins: a CONTRADICTORY contentIndex (NaN/negative/non-integer) names no
    resolvable block, so its delta is deliberately refused rather than guessed onto a block it may not belong to
    (pi never emits one; an absent index is different and still defaults to block 0). The refusal is asserted here
    on purpose so a later losslessness sweep has to change this case consciously, not silently re-enable the drop.
    */
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: undefined, contentIndex: Number.NaN, delta: "ignored" }));
    expect(result.text.join("")).toBe("GPT-5.6REPRO MARKER B");
  });
  it("orders message-end text blocks and signals only text boundaries", () => {
    const result = capture(); const message = { role: "assistant", content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "T" }, { type: "toolCall" }, { type: "text", text: "B" }] };
    result.seam.handleAgentEvent({ type: "message_end", message });
    expect(result.text).toEqual(["A", "B"]); expect(result.thinking).toEqual(["T"]); expect(result.boundaries).toEqual([1]);
  });
  it("does not repair first deltas of a new block or message", () => {
    const result = capture(); const first = { content: [{ type: "text", text: "Before." }] }; const second = { content: [{ type: "text", text: "REPRO MARKER B" }] };
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: first, contentIndex: 0, delta: "Before." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: first, contentIndex: 1, delta: "REPRO MARKER B" }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: second, contentIndex: 0, delta: "REPRO MARKER B" }));
    expect(result.text.slice(-2)).toEqual(["REPRO MARKER B", "REPRO MARKER B"]);
  });
  it("does not flush tool-result text from production-shaped terminal events", () => {
    const result = capture();
    result.seam.handleAgentEvent({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output must stay out of assistant text" }] },
    });
    expect(result.text).toEqual([]);
    expect(result.thinking).toEqual([]);
  });

  /*
  FNXC:AssistantTextCapture 2026-09-12-14:10:
  RUFU-230 symptom regression. The openai-completions producer (pi-ai 0.84.4) pushes `text_start` and
  then mutates the SHARED `partial` (`block.text += delta`) before pushing `text_delta`, and pi-agent-core
  re-delivers both events asynchronously with that live reference. By the time this seam handles
  `text_start`, the block text already contains the first chunk, so the start flush emits it; the following
  `text_delta` redelivers the same chunk. Concatenating both doubles the first chunk — the operator's
  literal "The operatorThe operator approved both actions." symptom. The joined capture text must equal
  the real reply exactly once, with no block-boundary signal for the skipped redelivery. The thinking
  branch follows the identical producer shape, so it is asserted as a non-vacuous control on the same
  invariant.
  */
  it("emits the first streamed chunk exactly once when the producer mutates partial before async delivery", () => {
    const result = capture();
    const partial = { content: [{ type: "text", text: "The operator" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    // text_start arrives with the block ALREADY mutated to the first chunk (producer race).
    result.seam.handleAgentEvent(update({ type: "text_start", partial, contentIndex: 0 }));
    // text_delta redelivers the same first chunk on the same live partial.
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "The operator" }));
    // Second chunk grows the block text, then its delta is delivered.
    partial.content[0].text = "The operator approved both actions.";
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: " approved both actions." }));
    expect(result.text.join("")).toBe("The operator approved both actions.");
    expect(result.boundaries).toEqual([]);

    // Control: thinking_start/thinking_delta from the same producer shape must not double-emit either.
    const thinkPartial = { content: [{ type: "thinking", thinking: "Let me" }] };
    result.seam.handleAgentEvent(update({ type: "thinking_start", partial: thinkPartial, contentIndex: 0 }));
    result.seam.handleAgentEvent(update({ type: "thinking_delta", partial: thinkPartial, contentIndex: 0, delta: "Let me" }));
    thinkPartial.content[0].thinking = "Let me verify";
    result.seam.handleAgentEvent(update({ type: "thinking_delta", partial: thinkPartial, contentIndex: 0, delta: " verify" }));
    expect(result.thinking.join("")).toBe("Let me verify");
  });
});
