import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_TRANSCRIPT_COLLECTORS,
  measureSessionTranscriptBytes,
  measureSessionTranscriptMessages,
  measureTranscriptBytes,
  measureTranscriptMessages,
  registerTranscriptCollector,
  registeredTranscriptBytes,
  registeredTranscriptMessages,
  resetTranscriptCollectorsForTests,
  transcriptCollectorsRefusedCount,
  transcriptScanWasTruncated,
  TRANSCRIPT_SCAN_MAX_MESSAGES,
} from "../executor/session-transcript-retention.js";

/*
FNXC:SessionTranscriptMetering 2026-11-06-22:58 (RUFU-871):
The census priced every registered collection at a flat 96 B/entry, so two live executor sessions reported
192 bytes however much conversation they held — which is why the census claimed 3.4 kB of a 5.9 GiB heap and
could not answer the operator's question ("do we hold the whole LLM history in RAM although agent_runs and
agent-log.jsonl already persist it?"). These tests pin the replacement measure: real content bytes, capped
scan, no throw, and an aggregate across executor instances rather than the first instance's maps.
*/

describe("session transcript metering (RUFU-871)", () => {
  beforeEach(() => {
    resetTranscriptCollectorsForTests();
  });

  it("measures a string content payload", () => {
    const session = { state: { messages: [{ role: "assistant", content: "x".repeat(500) }] } };
    expect(measureSessionTranscriptBytes(session)).toBeGreaterThanOrEqual(500);
    expect(measureSessionTranscriptMessages(session)).toBe(1);
  });

  it("measures block-array content and nested tool results", () => {
    const session = {
      state: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "a".repeat(120) }, { type: "text", text: "b".repeat(80) }] },
          { role: "tool", content: { output: "c".repeat(300) } },
        ],
      },
    };
    expect(measureSessionTranscriptBytes(session)).toBeGreaterThanOrEqual(500);
  });

  it("bounds the scan and admits it was capped instead of reporting an unmeasured total", () => {
    const many = Array.from({ length: TRANSCRIPT_SCAN_MAX_MESSAGES + 500 }, () => ({
      role: "user",
      content: "y".repeat(1000),
    }));
    const bytes = measureSessionTranscriptBytes({ state: { messages: many } });
    // The cap is what keeps the sampler from walking a 24-day loop's whole history inside the diagnosed
    // process; a capped figure must be smaller than the true total and must announce itself.
    expect(bytes).toBeLessThan(many.length * 1000);
    expect(transcriptScanWasTruncated()).toBe(true);
  });

  it("survives shapes that are not sessions", () => {
    for (const junk of [undefined, null, {}, { messages: "no" }, { state: {} }, 42]) {
      expect(() => measureSessionTranscriptBytes(junk)).not.toThrow();
      expect(measureSessionTranscriptBytes(junk)).toBe(0);
    }
  });

  it("reads the flat `messages` field too, because runtimes differ", () => {
    expect(measureSessionTranscriptBytes({ messages: [{ role: "user", content: "z".repeat(40) }] }))
      .toBeGreaterThanOrEqual(40);
  });

  it("unwraps an executor entry that wraps the session", () => {
    const entries = [{ session: { state: { messages: [{ role: "user", content: "q".repeat(70) }] } } }];
    expect(measureTranscriptBytes(() => entries.values())).toBeGreaterThanOrEqual(70);
  });

  it("aggregates across instances, so a second project's sessions are not invisible", () => {
    registerTranscriptCollector(() => ({ bytes: 1000, messages: 3 }));
    registerTranscriptCollector(() => ({ bytes: 250_000, messages: 61 }));

    expect(registeredTranscriptBytes()).toBe(251_000);
    expect(registeredTranscriptMessages()).toBe(64);
  });

  it("bounds its own registry and counts refusals rather than growing without limit", () => {
    for (let i = 0; i < MAX_TRANSCRIPT_COLLECTORS + 3; i += 1) {
      registerTranscriptCollector(() => ({ bytes: 1, messages: 1 }));
    }
    expect(transcriptCollectorsRefusedCount()).toBe(3);
    expect(registeredTranscriptBytes()).toBe(MAX_TRANSCRIPT_COLLECTORS);
  });

  it("reports zero when a collector throws, because the census cannot break an executor", () => {
    registerTranscriptCollector(() => {
      throw new Error("hostile session");
    });
    registerTranscriptCollector(() => ({ bytes: 5, messages: 1 }));
    expect(registeredTranscriptBytes()).toBe(5);
  });
});
