import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __peekCachedStoreForTesting,
  __resolveProjectRootForTesting,
  __setExtensionStoreBootFactoryForTesting,
  clearHostTaskStores,
  closeCachedStores,
} from "../extension.js";

/*
FNXC:TaskStoreBootDeadline 2026-09-23-06:20:
STAS-251. The extension boot ceiling used to be a race: the waiter gave up at 30s, the boot
kept running, nothing recorded which phase cost the time or why it failed, and every later
caller paid the same 30s again against the same stalled attempt. These tests pin the
replacement contract — one bounded attempt, an immediate attributed failure for callers that
arrive inside the backoff window, and a terminal record that says how long the boot took.
*/

/** getStore keys every record by the resolved project root, not the raw cwd it was handed. */
const PROJECT_ROOT = __resolveProjectRootForTesting(process.cwd());
const BOOT_BUDGET_MS = 250;
/** A caller that arrives behind a reported failure must not wait on the stalled boot again. */
const IMMEDIATE_MS = 50;

type BootFactoryArg = Parameters<typeof __setExtensionStoreBootFactoryForTesting>[0];

function bootFactory(factory: () => Promise<unknown>): BootFactoryArg {
  return factory as unknown as BootFactoryArg;
}

function makeStore(label: string): TaskStore {
  return { __label: label } as unknown as TaskStore;
}

function bootedStore(label: string) {
  return { taskStore: makeStore(label), shutdown: async () => {} };
}

function stalledForever(): Promise<never> {
  return new Promise<never>(() => {});
}

function settledAfter<T>(value: () => T, delayMs: number): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value()), delayMs);
  });
}

async function rejectsWithin(promise: Promise<unknown>): Promise<number> {
  const started = Date.now();
  await promise.catch(() => {});
  return Date.now() - started;
}

afterEach(async () => {
  await closeCachedStores();
  __clearExtensionStoreBootStateForTesting();
  clearHostTaskStores();
  vi.restoreAllMocks();
});

describe("extension TaskStore boot is one bounded attempt (STAS-251)", () => {
  it("coalesces concurrent cold-cache callers onto a single boot", async () => {
    let boots = 0;
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(async () => {
        boots += 1;
        return bootedStore("shared");
      }),
    );

    const stores = await Promise.all(
      Array.from({ length: 8 }, () => __getStoreForTesting(PROJECT_ROOT, 5_000)),
    );

    expect(boots).toBe(1);
    expect(new Set(stores).size).toBe(1);
  });

  it("rejects the waiter at the deadline without caching an unverified store", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stalledForever));

    await expect(__getStoreForTesting(PROJECT_ROOT, 40)).rejects.toThrow(/timed out after 40ms/);
    expect(__peekCachedStoreForTesting(PROJECT_ROOT)).toBeUndefined();
  });

  it("fails later callers immediately with the recorded reason instead of re-paying the whole budget", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stalledForever));

    const firstElapsed = await rejectsWithin(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS));
    expect(firstElapsed).toBeGreaterThanOrEqual(BOOT_BUDGET_MS - 50);

    const secondElapsed = await rejectsWithin(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS));
    expect(secondElapsed).toBeLessThan(IMMEDIATE_MS);
  });

  it("records the terminal duration when an orphaned boot lands after its deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(() => settledAfter(() => bootedStore("orphan"), 60)),
    );

    await expect(__getStoreForTesting(PROJECT_ROOT, 20)).rejects.toThrow(/timed out after 20ms/);
    await vi.waitFor(() => {
      expect(__peekCachedStoreForTesting(PROJECT_ROOT)).toBeDefined();
    });

    const records = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("taskstore-boot"));
    const all = records.join("\n");
    expect(all).toContain('"outcome":"deadline"');
    expect(all).toContain('"outcome":"late-success"');
    expect(all).toMatch(/"durationMs":\s*\d+/);
    expect(all).toContain(PROJECT_ROOT);
  });

  it("keeps the boot failure reason on the attributed rejection", async () => {
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(async () => {
        throw new Error("canceling statement due to lock timeout");
      }),
    );

    await expect(__getStoreForTesting(PROJECT_ROOT, 500)).rejects.toThrow(/lock timeout/);
    expect(__peekCachedStoreForTesting(PROJECT_ROOT)).toBeUndefined();
  });
});
