import { describe, expect, it, beforeEach } from "vitest";
import { HOST_RETENTION_ENTRY_OVERHEAD_BYTES, listHostRetentionSources, registerHostRetentionSource, resetHostRetentionRegistryForTests } from "@fusion/core";

function listHostRetentionSourcesForCapTest(): number {
  return listHostRetentionSources().length;
}
import { MAX_REGISTERED_SOURCES, MAP_ENTRY_OVERHEAD_BYTES, retentionCensus, retentionCensusSnapshot, resetRetentionCensusForTests } from "../../lib/retention-census.js";
import { createRetentionSampler } from "../retention-sampler.js";

/*
FNXC:RetentionCensus 2026-11-06-09:08 (RUFU-871):
Engine-owned collections must arrive in the SAME census as the dashboard's own caches, because the number that
decides whether this instrument is working is one ratio over one process: `fusion_retention_coverage_ratio`.
A parallel family set would render engine bytes without ever moving the residual, and the operator would read a
healthy census over a leaking heap.
*/
describe("host sources folded into the dashboard census", () => {
  beforeEach(() => {
    resetRetentionCensusForTests();
    resetHostRetentionRegistryForTests();
  });

  it("keeps one overhead constant across the two packages", () => {
    expect(HOST_RETENTION_ENTRY_OVERHEAD_BYTES).toBe(MAP_ENTRY_OVERHEAD_BYTES);
  });

  it("appears in the sampler snapshot and in trackedBytes", () => {
    const backing = new Map<string, string>();
    registerHostRetentionSource({ id: "bridge_probe", kind: "session", read: () => backing.size });
    backing.set("task-1", "x");
    backing.set("task-2", "y");

    const sampler = createRetentionSampler();
    const snapshot = sampler.sample();
    const row = snapshot.sources.find((source) => source.id === "bridge_probe");
    expect(row?.entries).toBe(2);
    expect(row?.approxBytes).toBe(2 * MAP_ENTRY_OVERHEAD_BYTES);
    expect(snapshot.trackedBytes).toBeGreaterThanOrEqual(2 * MAP_ENTRY_OVERHEAD_BYTES);
  });

  it("re-mirrors a host only once across samples", () => {
    let calls = 0;
    registerHostRetentionSource({
      id: "bridge_counting",
      kind: "registry",
      read: () => {
        calls += 1;
        return 1;
      },
    });
    const sampler = createRetentionSampler();
    sampler.sample();
    const afterFirst = calls;
    sampler.sample();
    const rows = retentionCensusSnapshot().sources.filter((source) => source.id === "bridge_counting");
    // One row, not two: the bridge mirrors by id and never re-registers, and only the census drives probes.
    expect(rows).toHaveLength(1);
    expect(rows[0].entries).toBe(1);
    expect(afterFirst).toBeGreaterThan(0);
    // The rejection log must stay empty across ticks. It used to grow per attempt, which turned a polling
    // bridge into unbounded retention inside the process the census is diagnosing.
    expect(retentionCensus().registrationRejections()).toEqual([]);
  });

  // Absent-vs-refused has to be distinguishable, or a truncated census reads as a complete one.
  it("surfaces refused registrations instead of letting the census look whole", () => {
    const census = retentionCensus();
    expect(census.hasSource("bridge_probe")).toBe(false);
    registerHostRetentionSource({ id: "bridge_missing_probe_shape", kind: "cache", read: () => 1 });
    // A host mirrored twice must not be recorded as two failures.
    census.register({ id: "dup_once", kind: "cache", keys: "load", probe: () => ({ entries: 1, approxBytes: 8, expiredEntries: 0 }) });
    expect(census.register({ id: "dup_once", kind: "cache", keys: "load", probe: () => ({ entries: 1, approxBytes: 8, expiredEntries: 0 }) })).toBe(false);
    expect(census.register({ id: "dup_once", kind: "cache", keys: "load", probe: () => ({ entries: 1, approxBytes: 8, expiredEntries: 0 }) })).toBe(false);
    expect(census.registrationRejections().filter((r) => r === "dup_once")).toHaveLength(1);
    expect(census.hasSource("dup_once")).toBe(true);

    const families = createRetentionSampler().buildSnapshot();
    const refused = families.find((f) => f.name === "fusion_retention_sources_refused");
    expect(refused).toBeDefined();
    expect(refused?.samples[0]?.value ?? 0).toBeGreaterThan(0);
  });

  // The engine registers 27 executor collections plus five step-output sources; the ceiling must not swallow them.
  it("fits the engine host sources alongside the dashboard cache sources", async () => {
    const { MAX_REGISTERED_SOURCES } = await import("../../lib/retention-census.js");
    const hostIds = listHostRetentionSourcesForCapTest();
    expect(MAX_REGISTERED_SOURCES).toBeGreaterThanOrEqual(hostIds + 40);
  });

  it("still renders the census when a host registry entry is hostile", () => {
    registerHostRetentionSource({
      id: "bridge_boom",
      kind: "counter",
      read: () => {
        throw new Error("host gone");
      },
    });
    const snapshot = retentionCensusSnapshot();
    expect(snapshot.sources.map((s) => s.id)).not.toContain("bridge_boom");
    expect(() => createRetentionSampler().sample()).not.toThrow();
  });
});
