import { describe, expect, it } from "vitest";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import {
  createAssistantStreamProducer,
  queueReproStream,
  REPRO_PREFIX,
  REPRO_RESPONSE,
  REPRO_SUFFIX,
} from "./fixtures/assistant-stream-events.js";

function capture() {
  const text: string[] = []; const thinking: string[] = []; const boundaries: number[] = [];
  return {
    text,
    thinking,
    boundaries,
    seam: createAssistantStreamCapture({
      onText: (value) => text.push(value),
      onThinking: (value) => thinking.push(value),
      onTextBlockBoundary: () => boundaries.push(1),
    }),
  };
}
function update(assistantMessageEvent: Record<string, unknown>) { return { type: "message_update", assistantMessageEvent }; }

function replayTextBlock(
  result: ReturnType<typeof capture>,
  output: { role: "assistant"; content: Array<Record<string, unknown>> },
  deltas: string[],
  aheadAtStart: number,
) {
  const block = { type: "text", text: "" };
  output.content.push(block);
  block.text = deltas.slice(0, aheadAtStart).join("");
  result.seam.handleAgentEvent(update({ type: "text_start", partial: output, contentIndex: output.content.length - 1 }));
  block.text = deltas.join("");
  for (const delta of deltas) {
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: output.content.length - 1, delta }));
  }
  result.seam.handleAgentEvent(update({ type: "text_end", partial: output, contentIndex: output.content.length - 1, content: block.text }));
}

describe("createAssistantStreamCapture", () => {
  it("emits a lock-step text block exactly once", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [{ type: "thinking", thinking: "x" }] as Array<Record<string, unknown>> };
    const deltas = ["Let", " me", " ground", " this", " in", " the", " tree", " before", " answering."];
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, deltas, 0);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("Let me ground this in the tree before answering.");
  });

  it("does not replay an ahead mutable partial when queued deltas drain", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [{ type: "thinking", thinking: "x" }] as Array<Record<string, unknown>> };
    const deltas = ["Let", " me", " ground", " this", " in", " the", " t", "ree", " before", " answering."];
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, deltas, 7);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("Let me ground this in the tree before answering.");
  });

  it("keeps lagging identifier continuations verbatim", () => {
    const result = capture();
    const output = { role: "assistant" as const, content: [] as Array<Record<string, unknown>> };
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    replayTextBlock(result, output, ["the Input/", "Output", " cards; model_v1/v2 and acmeCloud."], 1);
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.text.join("")).toBe("the Input/Output cards; model_v1/v2 and acmeCloud.");
  });

  it("preserves thinking and multiple text block boundaries", () => {
    const result = capture();
    const output = {
      role: "assistant" as const,
      content: [
        { type: "thinking", thinking: "Reason." },
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
      ],
    };
    result.seam.handleAgentEvent({ type: "message_start", message: output });
    result.seam.handleAgentEvent(update({ type: "thinking_delta", partial: output, contentIndex: 0, delta: "Reason." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: 1, delta: "First." }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial: output, contentIndex: 2, delta: "Second." }));
    result.seam.handleAgentEvent({ type: "message_end", message: output });
    expect(result.thinking).toEqual(["Reason."]);
    expect(result.text).toEqual(["First.", "Second."]);
    expect(result.boundaries).toEqual([1]);
  });

  it("flushes terminal-only and partial-delta remainders exactly once", () => {
    const result = capture();
    const partial = { role: "assistant", content: [{ type: "text", text: "Hello world" }, { type: "thinking", thinking: "Think" }] };
    result.seam.handleAgentEvent({ type: "message_start", message: partial });
    result.seam.handleAgentEvent(update({ type: "text_start", partial, contentIndex: 0 }));
    result.seam.handleAgentEvent(update({ type: "text_delta", partial, contentIndex: 0, delta: "Hello" }));
    result.seam.handleAgentEvent(update({ type: "text_end", partial, contentIndex: 0, content: "Hello world" }));
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("Hello world");
    expect(result.thinking.join("")).toBe("Think");
  });

  it("resets messages and ignores malformed or tool-result terminal events", () => {
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
    /*
    FNXC:AssistantTextCapture 2026-09-22-10:10 (#sync-0922 merge resolution, upstream FN-9356):
    Upstream folded the tool-result terminal case into this case; the line is kept here too, so the
    sequence asserts both facts at once — a tool-result terminal after a reset flushes no assistant
    text — while the joined text keeps this line's own populated-block expectation (upstream dropped
    that event and asserted only its "GPT-5.6" prefix; the populated block still reaches the sink).
    */
    result.seam.handleAgentEvent({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output must stay out of assistant text" }] },
    });
    expect(result.text.join("")).toBe("GPT-5.6REPRO MARKER B");
    expect(result.thinking).toEqual([]);
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
  describe("FN-431 shared mutable snapshots", () => {
    it("emits the response once when the start snapshot already carries the first delta", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      const index = queueReproStream(producer);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      expect(result.text.join("")).not.toBe(REPRO_PREFIX + REPRO_RESPONSE);
    });

    it("emits the same text when every event is consumed immediately", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      producer.drain(result.seam.handleAgentEvent);
      const index = producer.startBlock("text");
      producer.drain(result.seam.handleAgentEvent);
      producer.delta("text", index, REPRO_PREFIX);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
    });

    it("emits each burst delta once when the snapshot is several deltas ahead", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.delta("text", index, "alpha ");
      producer.delta("text", index, "beta ");
      producer.delta("text", index, "gamma");
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe("alpha beta gamma");
      producer.delta("text", index, " delta");
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe("alpha beta gamma delta");
    });

    it("produces identical text for copied snapshots without inventing paragraph boundaries", () => {
      const result = capture();
      const producer = createAssistantStreamProducer({ snapshot: "copied" });
      const index = queueReproStream(producer);
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      expect(result.boundaries).toEqual([]);
    });

    it("keeps thinking, tools, and a following block separate", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const thinkingIndex = producer.startBlock("thinking");
      producer.delta("thinking", thinkingIndex, "Considering.");
      const first = producer.startBlock("text");
      producer.delta("text", first, REPRO_PREFIX);
      producer.drain(result.seam.handleAgentEvent);
      producer.delta("text", first, REPRO_SUFFIX);
      producer.endBlock("text", first);
      const second = producer.startBlock("text");
      producer.delta("text", second, "Second block.");
      producer.endBlock("text", second);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.thinking.join("")).toBe("Considering.");
      expect(result.text.join("")).toBe(`${REPRO_RESPONSE}Second block.`);
      expect(result.boundaries).toEqual([1]);
    });

    it("keeps intentional repetition and distinct identical messages", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.delta("text", index, REPRO_PREFIX);
      producer.delta("text", index, REPRO_PREFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX + REPRO_PREFIX);

      const next = createAssistantStreamProducer();
      const nextIndex = queueReproStream(next);
      next.endBlock("text", nextIndex);
      next.messageEnd();
      next.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_PREFIX + REPRO_PREFIX + REPRO_PREFIX);
    });

    it("preserves markdown, links, spacing, and surrogate pairs split across deltas", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      const chunks = ["See [docs](https://example.com/a_b?x=1&y=2)", "\n\n- item\n- item\n", "emoji \u{1F680}".slice(0, 7), "\u{1F680}".slice(1), " done"];
      for (const chunk of chunks) producer.delta("text", index, chunk);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(chunks.join(""));
    });

    it("does not reuse cursors from a previous capture instance", () => {
      const first = capture();
      const firstProducer = createAssistantStreamProducer();
      const firstIndex = queueReproStream(firstProducer);
      firstProducer.endBlock("text", firstIndex);
      firstProducer.messageEnd();
      firstProducer.drain(first.seam.handleAgentEvent);
      expect(first.text.join("")).toBe(REPRO_PREFIX);

      const second = capture();
      const secondProducer = createAssistantStreamProducer();
      const secondIndex = queueReproStream(secondProducer);
      secondProducer.endBlock("text", secondIndex);
      secondProducer.messageEnd();
      secondProducer.drain(second.seam.handleAgentEvent);
      expect(second.text.join("")).toBe(REPRO_PREFIX);
    });

    it("restores a block that never receives a delta and ignores replayed terminals", () => {
      const result = capture();
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.message.content[index]!.text = REPRO_RESPONSE;
      producer.endBlock("text", index);
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(result.seam.handleAgentEvent);
      expect(result.text.join("")).toBe(REPRO_RESPONSE);
    });
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
