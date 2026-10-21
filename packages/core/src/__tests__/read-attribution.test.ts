/*
FNXC:ReadAttribution 2026-10-21-00:36 (RUFU-756):
These tests are the contract for telemetry that exists because two profilers could not answer "who is
reading this table 615 times a second" — the async boundary erases the stack they would have shown. So
the property that matters is not "a counter incremented" but: the caller IS recoverable, the cost of
recovering it is bounded, the row stays ids/counts-only, a hostile sink cannot break the read, and an
idle seam says nothing.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  READ_ATTRIBUTION_SAMPLE_EVERY,
  flushReadAttribution,
  recordReadCall,
  resetReadAttributionForTests,
  setReadAttributionCapForTests,
  snapshotReadAttribution,
} from "../task-store/read-attribution.js";
import type { TaskStore } from "../store.js";

function fakeStore() {
  const events: Array<{ mutationType: string; target: string; metadata: Record<string, unknown> }> = [];
  const store = {
    recordRunAuditEvent: vi.fn(async (event: typeof events[number]) => { events.push(event); }),
  } as unknown as TaskStore;
  return { store, events };
}

describe("read attribution", () => {
  beforeEach(() => resetReadAttributionForTests());

  it("counts every call but captures a stack only once per sample interval", () => {
    const { store } = fakeStore();
    for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY * 3; i += 1) {
      recordReadCall(store, "listTasks");
    }

    const window = snapshotReadAttribution().listTasks;
    expect(window.calls).toBe(READ_ATTRIBUTION_SAMPLE_EVERY * 3);
    expect(window.stackSamples).toBe(3);
  });

  /*
  The whole point of the module. If this ever regresses to `(unknown)`, the audit row degrades to a
  call counter that looks like data while answering nothing.
  */
  it("names a caller outside the task store instead of its own frame", () => {
    const { store } = fakeStore();
    function hotSweepCallSite() {
      for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY; i += 1) recordReadCall(store, "workflowSelection");
    }
    hotSweepCallSite();

    const top = snapshotReadAttribution().workflowSelection.top[0];
    expect(top).toBeDefined();
    expect(top.signature).toContain("hotSweepCallSite");
    expect(top.signature).toContain("read-attribution.test.ts");
    expect(top.signature).not.toContain("recordReadCall");
  });

  it("emits one ids/counts row per busy seam and never the caller string", async () => {
    const { store, events } = fakeStore();
    for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY * 2; i += 1) recordReadCall(store, "listTasks");

    await flushReadAttribution(store);

    expect(events).toHaveLength(1);
    expect(events[0].mutationType).toBe("store:read-attribution-window");
    expect(events[0].target).toBe("listTasks");
    expect(Object.keys(events[0].metadata).sort()).toEqual([
      "distinctCallers", "overflowCalls", "seam", "stackSamples",
      "topCallerCount", "topCallerHash", "topSharePct", "windowCalls",
    ]);
    expect(events[0].metadata.topCallerHash).toMatch(/^[0-9a-f]{8}$/);
    const serialized = JSON.stringify(events[0].metadata);
    expect(serialized).not.toContain("read-attribution.test.ts");
    expect(serialized).not.toContain("hotSweepCallSite");
  });

  it("stays silent for a seam that did no reads", async () => {
    const { store, events } = fakeStore();
    for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY; i += 1) recordReadCall(store, "listTasks");

    await flushReadAttribution(store);

    expect(events.map((e) => e.target)).toEqual(["listTasks"]);
  });

  it("bounds its own memory: signatures past the cap become overflow, not unbounded state", () => {
    const { store } = fakeStore();
    setReadAttributionCapForTests(2);
    const calls = READ_ATTRIBUTION_SAMPLE_EVERY;

    function siteAlpha() { for (let i = 0; i < calls; i += 1) recordReadCall(store, "workflowSelection"); }
    function siteBravo() { for (let i = 0; i < calls; i += 1) recordReadCall(store, "workflowSelection"); }
    function siteCharlie() { for (let i = 0; i < calls; i += 1) recordReadCall(store, "workflowSelection"); }
    siteAlpha();
    siteBravo();
    siteCharlie();

    const window = snapshotReadAttribution().workflowSelection;
    expect(window.distinctCallers).toBe(2);
    const topSignatures = window.top.map((row) => row.signature);
    expect(topSignatures.filter((sig) => /siteAlpha|siteBravo/.test(sig))).toHaveLength(2);
    expect(topSignatures.some((sig) => /siteCharlie/.test(sig))).toBe(false);
    expect(window.overflowCalls).toBeGreaterThan(0);
  });

  it("cannot break the read when the audit sink throws or is missing", async () => {
    const throwing = { recordRunAuditEvent: vi.fn(async () => { throw new Error("sink down"); }) } as unknown as TaskStore;
    const absent = {} as unknown as TaskStore;

    for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY; i += 1) {
      expect(() => recordReadCall(throwing, "listTasks")).not.toThrow();
      expect(() => recordReadCall(absent, "workflowSelection")).not.toThrow();
    }
    await expect(flushReadAttribution(throwing)).resolves.toBeUndefined();
    await expect(flushReadAttribution(absent)).resolves.toBeUndefined();
  });

  it("starts a fresh window after a flush so the row describes a window, not a total", async () => {
    const { store } = fakeStore();
    for (let i = 0; i < READ_ATTRIBUTION_SAMPLE_EVERY; i += 1) recordReadCall(store, "listTasks");
    await flushReadAttribution(store);

    expect(snapshotReadAttribution().listTasks.calls).toBe(0);
  });
});
