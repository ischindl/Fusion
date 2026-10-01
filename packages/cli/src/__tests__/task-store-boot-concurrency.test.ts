import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __peekCachedStoreForTesting,
  __resolveProjectRootForTesting,
  __setCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  clearHostTaskStores,
  closeCachedStores,
  setHostTaskStore,
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

/*
FNXC:TaskStoreLightBoot 2026-09-26-19:31 (RUFU-275):
The transient agent-tool boot must be LIGHT (no archive reintegration, no forced patchnode
reconcile — the saneca >30 s store-open bytes) and must never dual-boot when the host already
owns a store (FN-7956). These pin the two halves of that contract at the registry seam itself.
*/
describe("extension TaskStore boot is light and host-shared (RUFU-275)", () => {
  it("passes both backlog-skip flags to the boot factory (light boot for transient tool opens)", async () => {
    const bootOptions: Array<Record<string, unknown>> = [];
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(async (options: Record<string, unknown>) => {
        bootOptions.push(options ?? {});
        return bootedStore("light");
      }),
    );

    await __getStoreForTesting(PROJECT_ROOT, 5_000);

    expect(bootOptions).toHaveLength(1);
    expect(bootOptions[0]).toMatchObject({
      rootDir: PROJECT_ROOT,
      skipArchiveReintegrationOnInit: true,
      skipPatchnodeReconcileOnInit: true,
    });
  });

  it("serves a host-injected store without issuing any factory boot", async () => {
    let boots = 0;
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(async () => {
        boots += 1;
        return bootedStore("factory");
      }),
    );
    const host = makeStore("host");
    setHostTaskStore(PROJECT_ROOT, host);

    const served = await __getStoreForTesting(PROJECT_ROOT, 5_000);

    expect(served).toBe(host);
    expect(boots).toBe(0);
  });
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

/*
FNXC:TaskStoreBootDeadline 2026-09-28-04:22:
RUFU-377 investigated a renewed `fn_agent_show … TaskStore boot timed out after 30000ms`
sighting and had to answer it from measurement, because boot attribution lives on the console
only. Two facts were not pinned by any test, and both are what separates "the boot was really
slow" from "the budget burned while a store was already ready":
1) an orphaned boot that lands after its deadline must actually SERVE later callers — otherwise
   a slow-but-successful boot leaves every subsequent tool call paying the budget again, which
   looks identical to a permanently broken boot;
2) the two failure sentences are different instruments. The bare
   `… boot timed out after Nms` can only come from the wall-clock race, i.e. a caller that found
   neither a cached store nor a cooldown entry. Every DB-side contention path in core is bounded
   server-side at ~20s and reports a NAMED cause (measured on an isolated board-DB copy:
   `Timed out after 20000ms waiting for the fusion:schema-applier advisory lock`), so contention
   never produces the bare sentence. A caller that arrives inside the backoff window instead reads
   `… recently failed (cooldown 5000ms): <cause>`, where <cause> is either the real underlying
   error or the deadline detail. These are the operator-visible fingerprints of the branch.
*/
describe("extension TaskStore boot deadline vs ready-store discrimination (RUFU-377)", () => {
  it("serves a later caller from the cache with no second boot once an orphaned boot lands", async () => {
    let boots = 0;
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(() => {
        boots += 1;
        return settledAfter(() => bootedStore("slow-but-fine"), 200);
      }),
    );

    await expect(__getStoreForTesting(PROJECT_ROOT, 20)).rejects.toThrow(/timed out after 20ms/);
    expect(__peekCachedStoreForTesting(PROJECT_ROOT)).toBeUndefined();

    await vi.waitFor(() => {
      expect(__peekCachedStoreForTesting(PROJECT_ROOT)).toBeDefined();
    });

    const served = await __getStoreForTesting(PROJECT_ROOT, 5_000);
    expect(served).toBeDefined();
    expect(boots).toBe(1);
  });

  it("reports the bare budget sentence (no cause) only to a caller that paid the budget", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stalledForever));

    await expect(__getStoreForTesting(PROJECT_ROOT, 30)).rejects.toThrow(
      /^fn extension TaskStore boot timed out after 30ms$/,
    );
  });

  it("attributes a named underlying cause to a caller arriving inside the cooldown window", async () => {
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(async () => {
        throw new Error("Timed out after 20000ms waiting for the fusion:schema-applier advisory lock");
      }),
    );

    await expect(__getStoreForTesting(PROJECT_ROOT, 500)).rejects.toThrow(/schema-applier advisory lock/);

    const elapsed = await rejectsWithin(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS));
    expect(elapsed).toBeLessThan(IMMEDIATE_MS);
    await expect(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS)).rejects.toThrow(
      /fn extension TaskStore boot recently failed \(cooldown 5000ms\): .*schema-applier advisory lock/,
    );
  });

  it("attributes a reported deadline to later cooldown callers instead of re-running the bare race", async () => {
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(() => settledAfter(() => bootedStore("orphan"), 500)),
    );

    await expect(__getStoreForTesting(PROJECT_ROOT, 25)).rejects.toThrow(
      /^fn extension TaskStore boot timed out after 25ms$/,
    );

    const elapsed = await rejectsWithin(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS));
    expect(elapsed).toBeLessThan(IMMEDIATE_MS);
    await expect(__getStoreForTesting(PROJECT_ROOT, BOOT_BUDGET_MS)).rejects.toThrow(
      /fn extension TaskStore boot recently failed \(cooldown 5000ms\): abandoned after \d+ms \(budget 25ms\)/,
    );
  });

  it("never races an already-ready store against the boot budget", async () => {
    // The B2 arm of the discrimination: with a store already in hand, the budget cannot fire and
    // cannot be reported. If a future change ever put a cached/host store behind the race, a warm
    // process would start producing "timed out after Nms" sightings like this one.
    let boots = 0;
    __setExtensionStoreBootFactoryForTesting(
      bootFactory(() => {
        boots += 1;
        return stalledForever();
      }),
    );
    const ready = makeStore("ready-before-the-budget");
    __setCachedStoreForTesting(PROJECT_ROOT, ready);

    const started = Date.now();
    await expect(__getStoreForTesting(PROJECT_ROOT, 20)).resolves.toBe(ready);
    expect(Date.now() - started).toBeLessThan(IMMEDIATE_MS);
    expect(boots).toBe(0);
  });
});
