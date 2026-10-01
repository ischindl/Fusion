/*
FNXC:ChatRemoteGenerationMirror 2026-09-17-18:57:
The chat store emits raw store rows; `isGenerating` is a route-level derivation. Without
enrichment at the SSE bus boundary, clients checking `isGenerating` on `chat:session:updated`
never see an externally-started generation. This pins the derivation itself.
*/

import { describe, expect, it } from "vitest";
import { enrichChatSessionEventPayload } from "../sse.js";

describe("enrichChatSessionEventPayload", () => {
  it("derives isGenerating from an in-flight generating payload", () => {
    const out = enrichChatSessionEventPayload({
      id: "chat-1",
      inFlightGeneration: { status: "generating", streamingText: "x" },
    }) as { isGenerating?: boolean };
    expect(out.isGenerating).toBe(true);
  });

  it("derives false when no generation is in flight", () => {
    const out = enrichChatSessionEventPayload({ id: "chat-1", inFlightGeneration: null }) as { isGenerating?: boolean };
    expect(out.isGenerating).toBe(false);
  });

  it("never overwrites a payload that already carries isGenerating", () => {
    const enriched = enrichChatSessionEventPayload({ id: "chat-1", inFlightGeneration: { status: "generating" }, isGenerating: "sentinel" });
    expect(enriched).toEqual({ id: "chat-1", inFlightGeneration: { status: "generating" }, isGenerating: "sentinel" });
  });

  it("passes non-object payloads through untouched", () => {
    expect(enrichChatSessionEventPayload(null)).toBe(null);
    expect(enrichChatSessionEventPayload("x")).toBe("x");
  });
});
