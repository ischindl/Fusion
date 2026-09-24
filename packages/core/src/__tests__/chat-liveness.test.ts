import { describe, expect, it } from "vitest";
import {
  CHAT_IN_FLIGHT_GENERATION_STALE_MS,
  chatInFlightReferenceMs,
  classifyChatInFlightLiveness,
} from "../index.js";
import type { ChatInFlightGenerationState } from "../index.js";

/*
FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
Pure precedence table for the classifier both the engine reclaim sweep and the dashboard sidebar
tag read. No fakes and no timers: every case passes its own `nowMs`, which is the seam the DOM
tests reuse. The cases are the contract RN220-A and RN220-D argued into existence — age decides
whenever it is provable, the client `isGenerating` flag decides only when it is not, and an age
that cannot be proven is never allowed to accuse a claim.
*/

const FLOOR = CHAT_IN_FLIGHT_GENERATION_STALE_MS;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function claimAt(startedAt: string | undefined, overrides: Partial<ChatInFlightGenerationState> = {}): ChatInFlightGenerationState {
  return {
    status: "generating",
    streamingText: "partial answer",
    streamingThinking: "",
    toolCalls: [],
    replayFromEventId: 0,
    updatedAt: new Date(NOW).toISOString(),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...overrides,
  };
}

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("chat in-flight liveness floor", () => {
  it("is the 30-minute reclaim floor the RUFU-144 sweep uses", () => {
    // The sidebar tag and the sweeper share this one number; re-declaring it in either is the
    // drift this task exists to prevent. Engine-side re-export parity is pinned by
    // packages/engine/src/__tests__/chat-liveness-authority-parity.test.ts (core cannot import
    // engine, so the identity assertion lives on that side of the boundary).
    expect(FLOOR).toBe(30 * 60_000);
  });
});

describe("classifyChatInFlightLiveness: the snapshot gate comes first", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-object payload", "generating"],
    ["an array payload", []],
  ])("renders nothing for a claim that is %s, even when the client flag says live", (_label, claim) => {
    expect(
      classifyChatInFlightLiveness(
        { inFlightGeneration: claim as never, isGenerating: true },
        NOW,
      ),
    ).toBeNull();
  });

  it("renders nothing for a claim whose status is no longer generating", () => {
    // `status` is the literal "generating" in the type, so a stored row that says otherwise can
    // only arrive through a widened read — exactly why the gate checks the payload, not the flag.
    const settled = { ...claimAt(isoAgo(60_000)), status: "completed" } as unknown as ChatInFlightGenerationState;
    expect(
      classifyChatInFlightLiveness({ inFlightGeneration: settled, isGenerating: true }, NOW),
    ).toBeNull();
  });

  it("labels a live generation on the REST path, which never sets isGenerating", () => {
    // async-chat-store's rowToSession surfaces inFlightGeneration and updatedAt but no isGenerating:
    // a flag-first classifier would render nothing for a genuinely live generation here.
    const result = classifyChatInFlightLiveness(
      { inFlightGeneration: claimAt(isoAgo(60_000)) },
      NOW,
    );
    expect(result?.kind).toBe("generating");
    expect(result?.ageMs).toBe(60_000);
  });
});

describe("classifyChatInFlightLiveness: age decides whenever it is provable", () => {
  it("holds the floor boundary inclusive: exactly the floor old is still generating", () => {
    // The sweep skips a claim whose age is `<= floor`, so the tag must not accuse it either.
    expect(
      classifyChatInFlightLiveness({ inFlightGeneration: claimAt(isoAgo(FLOOR)) }, NOW)?.kind,
    ).toBe("generating");
  });

  it("flips one millisecond past the floor", () => {
    expect(
      classifyChatInFlightLiveness({ inFlightGeneration: claimAt(isoAgo(FLOOR + 1)) }, NOW)?.kind,
    ).toBe("stale-pending-reclaim");
  });

  it("separates 29 minutes from 31 minutes (the original-description boundary pair)", () => {
    expect(classifyChatInFlightLiveness({ inFlightGeneration: claimAt(isoAgo(29 * 60_000)) }, NOW)?.kind).toBe("generating");
    expect(classifyChatInFlightLiveness({ inFlightGeneration: claimAt(isoAgo(31 * 60_000)) }, NOW)?.kind).toBe("stale-pending-reclaim");
  });

  it("lets age outrank a live client flag past the floor (RN220-A)", () => {
    // The exact SSE payload enrichChatSessionEventPayload re-broadcasts for a dead-owner row:
    // isGenerating derived from the same stale snapshot, startedAt an hour old.
    const result = classifyChatInFlightLiveness(
      {
        inFlightGeneration: claimAt(isoAgo(60 * 60_000)),
        isGenerating: true,
        sessionUpdatedAt: isoAgo(60 * 60_000),
      },
      NOW,
    );
    expect(result?.kind).toBe("stale-pending-reclaim");
    expect(result?.ageMs).toBe(60 * 60_000);
  });

  it("reports a future-dated claim as generating, never stale (clock skew)", () => {
    // Negative age satisfies the sweep's floor skip, so the sweeper would not act and the tag
    // must not accuse. The negative age is still reported so the evidence stays visible.
    const result = classifyChatInFlightLiveness(
      { inFlightGeneration: claimAt(new Date(NOW + 60 * 60_000).toISOString()) },
      NOW,
    );
    expect(result?.kind).toBe("generating");
    expect(result?.ageMs).toBe(-60 * 60_000);
  });

  it("offers no custom floor: the shared constant is the only wait", () => {
    // The classifier takes a clock but no threshold, so the tag can never be tuned ahead of the
    // sweeper. Pinned so a future "make it configurable" change has to be deliberate.
    expect(classifyChatInFlightLiveness.length).toBe(1);
    expect(classifyChatInFlightLiveness({ inFlightGeneration: claimAt(isoAgo(FLOOR - 1)) }, NOW)?.kind).toBe("generating");
  });
});

describe("classifyChatInFlightLiveness: the flag speaks only when the age cannot be proven", () => {
  it("uses the session updatedAt when the claim carries no startedAt (legacy rows)", () => {
    expect(
      classifyChatInFlightLiveness(
        { inFlightGeneration: claimAt(undefined), sessionUpdatedAt: isoAgo(60_000) },
        NOW,
      ),
    ).toEqual({ kind: "generating", referenceMs: NOW - 60_000, ageMs: 60_000 });

    expect(
      classifyChatInFlightLiveness(
        { inFlightGeneration: claimAt(undefined), sessionUpdatedAt: isoAgo(FLOOR + 1) },
        NOW,
      )?.kind,
    ).toBe("stale-pending-reclaim");
  });

  it("prefers startedAt over updatedAt so a later write cannot hide the claim's age", () => {
    // Same precedence as the sweep: startedAt wins, otherwise the sweep would reset its own clock
    // on every streamed `updatedAt` bump and never reclaim.
    const result = classifyChatInFlightLiveness(
      { inFlightGeneration: claimAt(isoAgo(FLOOR + 60_000)), sessionUpdatedAt: isoAgo(1_000) },
      NOW,
    );
    expect(result?.kind).toBe("stale-pending-reclaim");
    expect(result?.referenceMs).toBe(NOW - FLOOR - 60_000);
  });

  it("falls back to the flag as generating when no timestamp parses", () => {
    const result = classifyChatInFlightLiveness(
      {
        inFlightGeneration: claimAt("not-a-date", { updatedAt: "also-not-a-date" }),
        isGenerating: true,
        sessionUpdatedAt: "nope",
      },
      NOW,
    );
    expect(result).toEqual({ kind: "generating", referenceMs: null, ageMs: null });
  });

  it("renders nothing when no timestamp parses and the flag is absent (never stale on a guess)", () => {
    expect(
      classifyChatInFlightLiveness(
        { inFlightGeneration: claimAt("not-a-date"), sessionUpdatedAt: "nope" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("chatInFlightReferenceMs: the shared reference chain", () => {
  it("resolves startedAt, then updatedAt, then unknown — never a guessed zero", () => {
    expect(chatInFlightReferenceMs(claimAt(isoAgo(5_000)), isoAgo(900_000))).toBe(NOW - 5_000);
    expect(chatInFlightReferenceMs(claimAt(undefined), isoAgo(5_000))).toBe(NOW - 5_000);
    expect(chatInFlightReferenceMs(claimAt("bad"), "also-bad")).toBeNull();
    expect(chatInFlightReferenceMs(null, null)).toBeNull();
    expect(chatInFlightReferenceMs(undefined, undefined)).toBeNull();
  });

  it("treats an empty startedAt as absent rather than as epoch zero", () => {
    // Date.parse("") is NaN, but a falsy-check gap would make a live row 56 years old.
    expect(chatInFlightReferenceMs(claimAt(""), isoAgo(2_000))).toBe(NOW - 2_000);
  });
});
