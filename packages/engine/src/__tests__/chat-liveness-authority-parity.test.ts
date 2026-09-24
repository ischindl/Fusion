import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInFlightGenerationState, ChatSession, ChatStore, TaskStore } from "@fusion/core";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS } from "@fusion/core";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS as ENGINE_REEXPORT } from "../healing/self-healing-constants.js";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS as SWEEP_IMPORT, SelfHealingManager } from "../self-healing.js";

/*
FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220, I-1):
Authority parity between the engine reclaim sweep and the dashboard sidebar tag. This lives on the
ENGINE side because `@fusion/core` cannot import `@fusion/engine`: core's own test can state the
value of the constant, but only a test on this side of the boundary can prove the sweep actually
reads that declaration. Both halves are pinned here:

1. The engine constant is a RE-EXPORT of core's declaration, not a second literal. The Step 4 grep
   gate (the constant's declaration resolving to exactly one line, in core) proves the textual
   half; this proves the runtime half, including the pre-existing `../self-healing.js` path the
   sweep's own test imports.
2. The sweep resolves a claim's age through core's reference resolver, so the age the tag prints
   is the age the sweeper acted on — asserted through the real sweep boundary rather than a
   copied expectation, which is the only way a future re-fork of the two bodies fails loudly.
*/

const FLOOR = CHAT_IN_FLIGHT_GENERATION_STALE_MS;

function inFlight(startedAt: string | undefined): ChatInFlightGenerationState {
  return {
    status: "generating",
    streamingText: "partial",
    streamingThinking: "",
    toolCalls: [],
    replayFromEventId: 0,
    updatedAt: startedAt ?? "2026-09-24T12:00:00.000Z",
    ...(startedAt ? { startedAt } : {}),
  };
}

function sessionAt(startedAt: string | undefined): ChatSession {
  return {
    id: "chat-parity",
    projectScope: "default",
    title: "parity",
    messages: [],
    updatedAt: startedAt ?? "2026-09-24T12:00:00.000Z",
    inFlightGeneration: inFlight(startedAt),
  } as unknown as ChatSession;
}

/*
FNXC:ChatInFlightRecovery 2026-09-04-04:43 (ThreatCrush CWE-377): a predictable OS temp-directory
name trips the scanner, so the sweep fixture takes an mkdtemp path and removes it after the run.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "rufu-220-parity-"));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function sweepFor(startedAt: string | undefined): { manager: SelfHealingManager; chatStore: ChatStore } {
  const chatStore = {
    listSessions: vi.fn(async () => [sessionAt(startedAt)]),
    setInFlightGeneration: vi.fn(async () => {}),
    addMessage: vi.fn(async () => ({ id: "msg-recovered" })),
  } as unknown as ChatStore;
  const manager = new SelfHealingManager(
    { recordRunAuditEvent: vi.fn(async () => {}) } as unknown as TaskStore,
    { rootDir: TEST_ROOT, chatStore },
  );
  return { manager, chatStore };
}

describe("RUFU-220 I-1: one liveness authority across the package boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("re-exports the core floor at every existing engine import path instead of restating it", () => {
    expect(ENGINE_REEXPORT).toBe(FLOOR);
    expect(SWEEP_IMPORT).toBe(FLOOR);
    // A second literal declaration in the engine would satisfy these value checks, so the textual
    // half stays pinned by the Step 4 grep gate over both packages' sources.
  });

  it("resolves the claim's staleness reference through core's resolver, not a private body", () => {
    // This private method is the sweep's only age input, so delegating it is exactly what makes
    // the sidebar label and the reclaim decision one computation.
    const manager = sweepFor(undefined).manager;
    const resolve = (claim: ChatInFlightGenerationState, updatedAt: string) =>
      (manager as unknown as {
        chatInFlightGenerationReferenceMs: (c: ChatInFlightGenerationState, u: string) => number | null;
      }).chatInFlightGenerationReferenceMs(claim, updatedAt);

    const startedAt = "2026-09-24T10:00:00.000Z";
    expect(resolve(inFlight(startedAt), "2026-09-24T11:00:00.000Z")).toBe(Date.parse(startedAt));
    expect(resolve(inFlight(undefined), "2026-09-24T11:00:00.000Z")).toBe(Date.parse("2026-09-24T11:00:00.000Z"));
    expect(resolve(inFlight("not-a-date"), "also-not-a-date")).toBeNull();
  });

  it("holds a floor-exact claim and reclaims one millisecond later — the boundary the tag prints", async () => {
    // Drivable because the classifier and the sweep are both wall-clock (RN220-D): the repo's
    // `toFake: ["Date"]` idiom controls Date.now, which is what both read.
    vi.useFakeTimers({ toFake: ["Date"] });
    const BASE = Date.parse("2026-09-24T12:00:00.000Z");
    vi.setSystemTime(BASE);

    const held = sweepFor(new Date(BASE - FLOOR).toISOString());
    expect(await held.manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(held.chatStore.setInFlightGeneration).not.toHaveBeenCalled();

    const reclaimed = sweepFor(new Date(BASE - FLOOR - 1).toISOString());
    expect(await reclaimed.manager.reconcileStaleInFlightChatGenerations()).toBe(1);
    expect(reclaimed.chatStore.setInFlightGeneration).toHaveBeenCalledWith("chat-parity", null);
  });
});
