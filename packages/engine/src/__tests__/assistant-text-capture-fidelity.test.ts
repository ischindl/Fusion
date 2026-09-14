import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";

/*
FNXC:AssistantTextCapture 2026-09-13-22:55:
RUFU-234 stream-fidelity contract. Every string handed to the text/thinking sink for ONE assistant block,
concatenated, must equal that block's final authoritative text with whitespace insertion by
normalizeStreamingDelta the ONLY permitted difference — nothing dropped, nothing duplicated. These replays
encode the operator-reported corruption (scattered 1-4 char drops, lost inter-word spaces, "notes"→"otes")
as deterministic pi event-shape fixtures so the fix cannot trade loss for duplication or vice versa. Each
fixture is RED on the pre-fix seam (see the task `diagnosis` document) and GREEN after deriving the emitted
span from the authoritative block text instead of trusting update.delta.
*/

type Block = { type: string; text?: string; thinking?: string };

function mk() {
  const text: string[] = [];
  const thinking: string[] = [];
  const boundaries: number[] = [];
  const seam = createAssistantStreamCapture({
    onText: (value) => text.push(value),
    onThinking: (value) => thinking.push(value),
    onTextBlockBoundary: () => boundaries.push(1),
  });
  return { text, thinking, boundaries, seam };
}
const upd = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });

// Models the openai-completions producer (pi-ai) that mutates the SHARED block.text ahead of async delivery.
// `lead` = how many chunks the producer has appended before the current delta is delivered (the mutation race).
function mutateAhead(block: Block, chunks: string[], upto: number, key: "text" | "thinking") {
  block[key] = chunks.slice(0, upto).join("");
}

describe("createAssistantStreamCapture stream fidelity (RUFU-234)", () => {
  it("keeps an inter-word space that the producer appended but never delivered as its own delta", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "healthy" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flush emits "healthy"
    partial.content[0].text = "healthy in-review"; // producer coalesced " in-review" into the block
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "in-review" }));
    expect(result.text.join("")).toBe("healthy in-review");
  });

  it("keeps the final character when the block is mutated fully ahead of per-character deltas", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    const chunks = ["n", "o", "t", "e", "s"];
    // producer finished the whole block before any delta was delivered (mutation-ahead lead = all)
    mutateAhead(partial.content[0], chunks, chunks.length, "text");
    for (const delta of chunks) result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta }));
    expect(result.text.join("")).toBe("notes");
  });

  it("reconstructs the operator's sample-2 string byte-for-byte from a lead-2 mutated producer", () => {
    const result = mk();
    const chunks = ["Model", " ", "č", "o", " ", "č", "e", " vlastné", "udy", " ", "sa", " ", "degrad", "oval"];
    const expected = chunks.join("");
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    const LEAD = 2;
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + LEAD), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    expect(result.text.join("")).toBe(expected);
  });

  it("diacritics survive across delta boundaries (Reštartuj, not Reštuj)", () => {
    const result = mk();
    const chunks = ["Reš", "tar", "tuj", " použit", "ý"];
    const expected = chunks.join("");
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[0] }));
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + 2), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    expect(result.text.join("")).toBe(expected);
  });

  it("does not slice a block's leading characters when the same partial object is reused across messages", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "X" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flush "X"
    // Second assistant turn reuses the SAME partial object with a new block text and no message_start.
    partial.content[0].text = "notes";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("Xnotes"); // must not become "Xotes"
  });

  it("emits a lagging-authoritative block exactly once (no letter-on-letter duplication)", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    // Producer pushes the delta BEFORE the block catches up (block lags the delta).
    for (const delta of ["Hello", " world"]) {
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta }));
      partial.content[0].text += delta;
    }
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: partial.content[0].text }));
    expect(result.text.join("")).toBe("Hello world"); // must not become "Hello world world"
  });

  it("streams multiple correctly-indexed blocks losslessly with interleaved thinking", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block, { type: "thinking", thinking: "" } as Block, { type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    // block 0 streamed with mutation-ahead
    mutateAhead(partial.content[0], ["first", " ", "block"], 3, "text");
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "first" }));
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: " block" }));
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: "first block" }));
    // thinking block
    partial.content[1].thinking = "reasoning";
    result.seam.handleAgentEvent(upd({ type: "thinking_delta", partial, contentIndex: 1, delta: "reasoning" }));
    // block 2
    mutateAhead(partial.content[2], ["notes/origin/using-39"], 1, "text");
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 2, delta: "notes/origin/using-39" }));
    expect(result.text.join("")).toBe("first blocknotes/origin/using-39");
    expect(result.thinking.join("")).toBe("reasoning");
  });

  it("preserves verbatim terminal message-end blocks without re-slicing", () => {
    const result = mk();
    const message = { role: "assistant", content: [{ type: "text", text: "notes" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent({ type: "message_end", message });
    expect(result.text.join("")).toBe("notes");
  });

  // Deterministic bounded randomized fidelity across a fixed seed range.
  it("preserves exact text across a seeded randomized split of short deltas", () => {
    const sentence = "The quick brown fox jumps over the lazy dog while Reštartuj použitý daemon runs.";
    for (let seed = 1; seed <= 60; seed++) {
      // Deterministic LCG: no Math.random, no timers.
      let state = seed;
      const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
      const chunks: string[] = [];
      let i = 0;
      while (i < sentence.length) { const size = 1 + Math.floor(rand() * 4); chunks.push(sentence.slice(i, i + size)); i += size; }
      const lead = 1 + Math.floor(rand() * 3);
      const result = mk();
      const partial = { content: [{ type: "text", text: "" } as Block] };
      result.seam.handleAgentEvent({ type: "message_start" });
      result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
      for (let c = 0; c < chunks.length; c++) {
        mutateAhead(partial.content[0], chunks, Math.min(chunks.length, c + lead), "text");
        result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[c] }));
      }
      result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: sentence }));
      expect({ seed, got: result.text.join("") }).toEqual({ seed, got: sentence });
    }
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "partialfree-face-suppresses-repeated-deltas" (severity high).
  When no block resolves for (partial, contentIndex, kind) — the mock runtime's `partial: <delta string>` shape
  (providers/mock-provider.ts emitText) and the plugin/cross-runtime CLI bridge that emits
  `{ type: "text_delta", contentIndex, delta }` with no `partial` at all — there is NO shared mutable block, so
  nothing can redeliver a chunk and the whole delta-dedup lane is pure downside. Suppressing there collapses two
  adjacent identical deltas into one ("\n"+"\n" -> "\n", "a"+"a"+"a" -> "a", " "+" " -> " ") and those lanes emit
  no `text_end`/`message_end`, so the span is lost permanently. HEAD's guard began with `full &&`, so an empty
  block short-circuited it and every delta went out verbatim; the loss must not return through the dedup.
  */
  it("delivers every repeated delta verbatim on the mock runtime face (partial is the delta string)", () => {
    const result = mk();
    const emit = (delta: string) => result.seam.handleAgentEvent(upd({ type: "text_delta", partial: delta, contentIndex: 0, delta }));
    emit("\n"); emit("\n");
    expect(result.text.join("")).toBe("\n\n"); // paragraph breaks must survive
    emit("a"); emit("a"); emit("a");
    expect(result.text.join("")).toBe("\n\naaa");
  });

  it("delivers every repeated delta verbatim when the runtime carries no partial at all (CLI bridge lane)", () => {
    const result = mk();
    const emit = (delta: string) => result.seam.handleAgentEvent(upd({ type: "text_delta", contentIndex: 0, delta }));
    emit("healthy"); emit(" "); emit(" "); emit("in-review");
    // The operator's exact signature: the lone-space delta must not be swallowed into "healthyin-review".
    expect(result.text.join("")).toBe("healthy  in-review");
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "stale-ledger-hole-shorter-replacement" (severity medium).
  The reuse case is symmetric: a `partial` object reused across messages with no `message_start` can carry
  replacement text SHORTER than the stale ledger span ("notes/origin/using-39" -> "OK"). A length-gated reset
  lets that shape fall through every branch, so the replacement reaches no sink at all — total loss, worse than
  the head-slice this branch was written to fix. The replacement must be delivered whole and exactly once.
  */
  it("delivers a replacement SHORTER than the stale ledger span when the same partial is reused", () => {
    const result = mk();
    const partial: { role: string; content: Block[] } = { role: "assistant", content: [{ type: "text", text: "notes/origin/using-39" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flushes the long block
    expect(result.text.join("")).toBe("notes/origin/using-39");
    // Same partial object, replacement text SHORTER than the delivered span, and no message_start to reset.
    partial.content[0].text = "OK";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39OK");
    // The terminal flush of that same message must not hand "OK" out a second time.
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("notes/origin/using-39OK");
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "absent-content-index-untested" (severity medium).
  `indexOf()` maps an ABSENT contentIndex onto block 0 and the seam's losslessness depends on it: real pi
  streams mix absent and explicit `0` for the same first block, so an absent start followed by an indexed
  delta on an already-populated block must emit that block's text exactly ONCE. Separating the two keys would
  re-emit the first block on all four consumer lanes, so this data state is pinned here rather than left as an
  unasserted load-bearing claim (the contradictory-index refusal beside it already is pinned).
  */
  it("folds an absent contentIndex onto block 0 so a mixed stream emits the first block exactly once", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "notes/origin/using-39" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial })); // no contentIndex at all
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "notes/origin/using-39" }));
    expect(result.text.join("")).toBe("notes/origin/using-39"); // once, not twice
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-21:15:
  RUFU-234 wiring ratchet (a code-structure guard, not a text assertion): pi.ts feeds this seam from TWO
  subscribers — the initial session's event listener and the fallback-swapped session in wireFallbackHooks.
  A refactor that wires only one lane leaves fallback-routed replies with no capture at all, silently
  emptying chat/log/verdict sinks for exactly the runs that took the fallback path. Both sites must keep
  constructing the capture from the caller's sinks and piping every event into it.
  */
  it("keeps every pi.ts session subscriber wired to a capture of the caller's sinks", () => {
    const source = readFileSync(fileURLToPath(new URL("../pi.ts", import.meta.url)), "utf8");
    const wiredSites = source.match(
      /const capture = createAssistantStreamCapture\(\{ onText: options\.onText, onThinking: options\.onThinking, onTextBlockBoundary: options\.onTextBlockBoundary \}\);\s*\n\s*\w+\.subscribe\(\(event\) => \{\s*\n\s*capture\.handleAgentEvent\(event\);/g,
    ) ?? [];
    expect(wiredSites).toHaveLength(2);
  });
});
