import { describe, expect, it, beforeEach } from "vitest";
import {
  HOST_RETENTION_ENTRY_OVERHEAD_BYTES,
  hostRetentionRegistrySize,
  listHostRetentionSources,
  registerHostRetentionSource,
  resetHostRetentionRegistryForTests,
} from "../retention-host-sources.js";

/*
FNXC:RetentionCensus 2026-11-06-09:08 (RUFU-871):
The host registry is the only way the engine's retained collections reach `/metrics`, so the behaviour that
matters is that a broken owner can neither crash the scrape nor silently inflate the census.
*/
describe("host retention registry", () => {
  beforeEach(() => {
    resetHostRetentionRegistryForTests();
  });

  it("reports live entry counts and the declared per-entry weight", () => {
    const backing = new Map<string, number>();
    expect(
      registerHostRetentionSource({
        id: "probe_entries",
        kind: "session",
        read: () => backing.size,
        bytesPerEntry: 512,
      }),
    ).toBe(true);

    const [source] = listHostRetentionSources();
    expect(source.entries()).toBe(0);
    backing.set("a", 1);
    backing.set("b", 2);
    expect(source.entries()).toBe(2);
    expect(source.approxBytes()).toBe(1024);
    expect(source.probeFailed()).toBe(false);
  });

  it("falls back to the entry-overhead default", () => {
    registerHostRetentionSource({ id: "probe_default", kind: "registry", read: () => 3 });
    const [source] = listHostRetentionSources();
    expect(source.approxBytes()).toBe(3 * HOST_RETENTION_ENTRY_OVERHEAD_BYTES);
  });

  it("refuses a duplicate id instead of double-counting one metric label", () => {
    expect(registerHostRetentionSource({ id: "dup", kind: "registry", read: () => 1 })).toBe(true);
    expect(registerHostRetentionSource({ id: "dup", kind: "registry", read: () => 99 })).toBe(false);
    expect(hostRetentionRegistrySize()).toBe(1);
    expect(listHostRetentionSources()[0].entries()).toBe(1);
  });

  // A throwing or nonsense owner must degrade to zero with the failure visible, never to a fake number.
  it("degrades a throwing owner to zero and marks the probe failed", () => {
    registerHostRetentionSource({
      id: "boom",
      kind: "counter",
      read: () => {
        throw new Error("host exploded");
      },
    });
    const [source] = listHostRetentionSources();
    expect(source.entries()).toBe(0);
    expect(source.approxBytes()).toBe(0);
    expect(source.probeFailed()).toBe(true);
  });

  it.each([[-1, "negative"], [Number.NaN, "NaN"], [Number.POSITIVE_INFINITY, "infinite"]])(
    "treats a %s reading as unusable rather than as a byte claim",
    (_value, _label) => {
      const value = _value;
      registerHostRetentionSource({ id: "weird", kind: "counter", read: () => value });
      const [source] = listHostRetentionSources();
      expect(source.entries()).toBe(0);
      expect(source.approxBytes()).toBe(0);
      expect(source.probeFailed()).toBe(true);
    },
  );
});
