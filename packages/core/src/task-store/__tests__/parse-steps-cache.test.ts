/*
FNXC:ListReadPromptParseCache 2026-10-02-12:02 (RUFU-495):
`parseStepsFromPrompt` runs on the list-read tail for every task whose persisted `steps` is empty, so the
production board re-read, re-parsed and re-threw the same 9 malformed `PROMPT.md` files ~1.7 times a second
(572 warnings in 331 s) while `/api/health` answered in 2.9-5.6 s — cost landing on the event loop.

The cache must therefore be *invisible* to correctness, so these cases pin freshness rather than speed: an
unchanged file is read once, a rewritten file is re-read, a deleted file never serves remembered steps, a
parse failure still throws on every call (and is warned once), and two stores never share a cache.
*/
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const probe = { reads: 0, gate: null as Promise<void> | null };
  (globalThis as { __promptReadProbe?: typeof probe }).__promptReadProbe = probe;
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      probe.reads += 1;
      // Read the bytes as they are NOW, then park. That order is what lets a case hold a parse in flight
      // across a rewrite of the same file — the real race — instead of quietly reading the newer file.
      const bytes = await actual.readFile(...args);
      if (probe.gate) await probe.gate;
      return bytes;
    },
  };
});

const readCount = () =>
  (globalThis as { __promptReadProbe?: { reads: number } }).__promptReadProbe?.reads ?? 0;

const setReadGate = (gate: Promise<void> | null) => {
  const probe = (globalThis as { __promptReadProbe?: { reads: number; gate: Promise<void> | null } })
    .__promptReadProbe;
  if (probe) probe.gate = gate;
};

/** Bounded 1 ms poll for an in-process hand-off (a read entered the gated shim). No fixed sleeps. */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const {
  parseStepsFromPromptImpl,
  shouldWarnPromptParseFailure,
  getPromptStepsCacheStats,
  isPromptStepsCacheEntryLive,
  __resetPromptStepsCacheForTests,
  __setPromptStepsCacheBoundForTesting,
} = await import("../task-artifacts-ops.js");
const { registerBuiltinStepParsers } = await import("../../tasks/step-parsers.js");
registerBuiltinStepParsers();

const VALID_PROMPT = `## Steps

### Step 1: Read the failing test
### Step 2 (depends: 1): Fix the invariant
`;

const REWRITTEN_PROMPT = `## Steps

### Step 1: Read the failing test
### Step 2 (depends: 1): Fix the invariant across every surface
### Step 3 (depends: 2): Pin it with a regression test
`;

// The shape that produced the production warning: a dependency annotation the parser refuses.
const MALFORMED_PROMPT = `## Steps

### Step 1: Read
### Step 2 (depends: 0 (zero)): Write
`;

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "fusion-prompt-cache-"));
  const dir = join(root, "TASK-1");
  await mkdir(dir, { recursive: true });
  // parseStepsFromPromptImpl needs only taskDir(); a narrow fake keeps this test off the database.
  const store = { taskDir: () => dir } as unknown as Parameters<typeof parseStepsFromPromptImpl>[0];
  return { store, dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** One root, one fake store, N card directories — the shape the retention cases need. */
async function makeMultiStore(cardIds: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "fusion-prompt-cache-multi-"));
  for (const id of cardIds) await mkdir(join(root, id), { recursive: true });
  const store = {
    taskDir: (id: string) => join(root, id),
  } as unknown as Parameters<typeof parseStepsFromPromptImpl>[0];
  return {
    store,
    promptPath: (id: string) => join(root, id, "PROMPT.md"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("parseStepsFromPrompt cache", () => {
  it("reads an unchanged PROMPT.md once, not once per list pass", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");

      const before = readCount();
      const first = await parseStepsFromPromptImpl(store, "TASK-1");
      const afterFirst = readCount();
      const second = await parseStepsFromPromptImpl(store, "TASK-1");
      const third = await parseStepsFromPromptImpl(store, "TASK-1");

      expect(first.map((s) => s.name)).toEqual(["Read the failing test", "Fix the invariant"]);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(afterFirst - before).toBe(1);
      expect(readCount()).toBe(afterFirst);
    } finally {
      await cleanup();
    }
  });

  it("serves concurrent readers of a cold card from a single parse", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      const before = readCount();
      const all = await Promise.all([
        parseStepsFromPromptImpl(store, "TASK-1"),
        parseStepsFromPromptImpl(store, "TASK-1"),
        parseStepsFromPromptImpl(store, "TASK-1"),
      ]);
      expect(readCount() - before).toBe(1);
      expect(all[0]).toEqual(all[1]);
      expect(all[2]).toEqual(all[0]);
    } finally {
      await cleanup();
    }
  });

  it("re-reads when the file is rewritten", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      expect((await parseStepsFromPromptImpl(store, "TASK-1")).length).toBe(2);

      await writeFile(join(dir, "PROMPT.md"), REWRITTEN_PROMPT, "utf-8");
      const afterRewrite = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(afterRewrite.map((s) => s.name)).toEqual([
        "Read the failing test",
        "Fix the invariant across every surface",
        "Pin it with a regression test",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("drops remembered steps when the file is deleted", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      expect((await parseStepsFromPromptImpl(store, "TASK-1")).length).toBe(2);

      await rm(join(dir, "PROMPT.md"));
      // Serving the cached steps here would be the dangerous failure: a card whose plan was withdrawn
      // would keep showing progress it does not have.
      expect(await parseStepsFromPromptImpl(store, "TASK-1")).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("keeps throwing a malformed prompt on every call and warns about it once", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), MALFORMED_PROMPT, "utf-8");

      let firstError = "";
      await expect(parseStepsFromPromptImpl(store, "TASK-1")).rejects.toThrow(/./);
      try {
        await parseStepsFromPromptImpl(store, "TASK-1");
      } catch (err) {
        firstError = err instanceof Error ? err.message : String(err);
      }
      expect(firstError).not.toBe("");

      // The failure is cached but never swallowed: every caller still sees the throw, so the degrade-to-
      // persisted-steps behaviour at the call sites cannot change.
      let secondError = "";
      try {
        await parseStepsFromPromptImpl(store, "TASK-1");
      } catch (err) {
        secondError = err instanceof Error ? err.message : String(err);
      }
      expect(secondError).toBe(firstError);

      expect(shouldWarnPromptParseFailure(store, "TASK-1", firstError)).toBe(true);
      expect(shouldWarnPromptParseFailure(store, "TASK-1", firstError)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("hands every caller its own copy so no caller can mutate cache state", async () => {
    /*
    FNXC:ListReadPromptParseCache 2026-11-09-11:15 (RUFU-495 residual pass):
    The hazard this pins is real, not theoretical: `updateStep` (`merge-queue-ops.ts`) assigns the parse
    result straight onto `task.steps` and then writes `task.steps[stepIndex].status = status`. Handed the
    cached array by reference, that one write would have re-labelled a step for EVERY later read of that
    card in this process — a memory-corruption bug with no disk evidence, invisible to the `mtimeMs`+`size`
    freshness check because the file never changed.
    */
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");

      const first = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(first.length).toBe(2);

      // Mutate everything a caller could plausibly mutate: an element's status, a dependency array, and
      // the array's own shape.
      first[0].status = "done";
      first[1].dependsOn?.push(99);
      first.push({ name: "injected by a careless caller", status: "done" });

      const second = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(second.map((s) => s.status)).toEqual(["pending", "pending"]);
      expect(second.map((s) => s.name)).toEqual(["Read the failing test", "Fix the invariant"]);

      // A third read, so a one-shot guard cannot pass this in place of a real copy.
      const third = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(third.map((s) => s.status)).toEqual(["pending", "pending"]);
      expect(third.length).toBe(2);

      // And the copies are independent of each other, not just of the cache.
      expect(second).not.toBe(third);
      expect(second[0]).not.toBe(first[0]);
      const dependencySnapshot = [...(third[1].dependsOn ?? [])];
      expect(dependencySnapshot.length).toBeGreaterThan(0);
      second[1].dependsOn?.push(42);
      expect(third[1].dependsOn).toEqual(dependencySnapshot);
    } finally {
      await cleanup();
    }
  });

  it("copies coalesced joiners too, not just cache hits", async () => {
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      const all = await Promise.all([
        parseStepsFromPromptImpl(store, "TASK-1"),
        parseStepsFromPromptImpl(store, "TASK-1"),
        parseStepsFromPromptImpl(store, "TASK-1"),
      ]);
      all[0][0].status = "skipped";
      const after = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(after[0].status).toBe("pending");
      expect(all[1]).not.toBe(all[2]);
    } finally {
      await cleanup();
    }
  });

  it("does not share a cache between stores", async () => {
    // Two store objects over the same directory: a module-level cache would let one project's read answer
    // another's, and a test store could inherit a production card's plan.
    const { dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      const storeA = { taskDir: () => dir } as unknown as Parameters<typeof parseStepsFromPromptImpl>[0];
      const storeB = { taskDir: () => dir } as unknown as Parameters<typeof parseStepsFromPromptImpl>[0];
      const before = readCount();
      await parseStepsFromPromptImpl(storeA, "TASK-1");
      await parseStepsFromPromptImpl(storeB, "TASK-1");
      expect(readCount() - before).toBe(2);
    } finally {
      await cleanup();
    }
  });

  /*
  FNXC:ListReadPromptParseCache 2026-11-09-11:28 (RUFU-495 residual pass):
  Retention rules the shipped slice stated but did not enforce on the failure path. These cases drive the
  bound down through `__setPromptStepsCacheBoundForTesting` so eviction is proven in milliseconds — writing
  4097 cards to reach the named cap would be a slow test that proves the same thing.
  */
  it("bounds BOTH collections under one cap and evicts the oldest, never the whole set", async () => {
    const cards = ["ZBOUND-A", "ZBOUND-B", "ZBOUND-C", "ZBOUND-D"] as const;
    const { store, promptPath, cleanup } = await makeMultiStore(cards);
    try {
      __resetPromptStepsCacheForTests(store);
      __setPromptStepsCacheBoundForTesting(3);
      expect(getPromptStepsCacheStats(store).bound).toBe(3);

      for (const id of cards.slice(0, 3)) {
        await writeFile(promptPath(id), VALID_PROMPT, "utf-8");
        await parseStepsFromPromptImpl(store, id);
      }
      let stats = getPromptStepsCacheStats(store);
      expect(stats.liveEntries).toBe(3);
      expect(stats.evictions).toBe(0);

      // A fourth distinct card crosses the bound: the OLDEST key goes, the newest stays, size never exceeds.
      await writeFile(promptPath("ZBOUND-D"), VALID_PROMPT, "utf-8");
      await parseStepsFromPromptImpl(store, "ZBOUND-D");
      stats = getPromptStepsCacheStats(store);
      expect(stats.liveEntries).toBe(3);
      expect(stats.evictions).toBe(1);
      expect(isPromptStepsCacheEntryLive(store, "ZBOUND-A")).toBe(false);
      expect(isPromptStepsCacheEntryLive(store, "ZBOUND-D")).toBe(true);

      // A repeat write for a key that is already live needs no room: it grows nothing, evicts nothing, and
      // the stale value cannot survive it — the read returns the NEW plan, not the remembered one.
      await writeFile(promptPath("ZBOUND-C"), REWRITTEN_PROMPT, "utf-8");
      const rewritten = await parseStepsFromPromptImpl(store, "ZBOUND-C");
      expect(rewritten.length).toBe(3);
      stats = getPromptStepsCacheStats(store);
      expect(stats.liveEntries).toBe(3);
      expect(stats.evictions).toBe(1);
      expect(isPromptStepsCacheEntryLive(store, "ZBOUND-C")).toBe(true);

      // The warned-key set obeys the same rule. Clearing the whole set at the cap used to re-arm every
      // card the process had already explained, which is the spam this cache exists to prevent.
      expect(shouldWarnPromptParseFailure(store, "ZBOUND-W1", "boom")).toBe(true);
      expect(shouldWarnPromptParseFailure(store, "ZBOUND-W2", "boom")).toBe(true);
      expect(shouldWarnPromptParseFailure(store, "ZBOUND-W3", "boom")).toBe(true);
      expect(shouldWarnPromptParseFailure(store, "ZBOUND-W4", "boom")).toBe(true);
      expect(shouldWarnPromptParseFailure(store, "ZBOUND-W4", "boom")).toBe(false);
      stats = getPromptStepsCacheStats(store);
      expect(stats.liveWarnedKeys).toBe(3);
      expect(stats.evictions).toBe(2);

      // The reset hook drops everything the store remembered, counters included.
      __resetPromptStepsCacheForTests(store);
      stats = getPromptStepsCacheStats(store);
      expect(stats).toMatchObject({ liveEntries: 0, liveWarnedKeys: 0, hits: 0, misses: 0, evictions: 0 });
      expect(isPromptStepsCacheEntryLive(store, "ZBOUND-D")).toBe(false);
    } finally {
      __setPromptStepsCacheBoundForTesting(null);
      await cleanup();
    }
  });

  it("reports cache hits, misses, coalesced joins and invalidations as countable state", async () => {
    const { store, promptPath, cleanup } = await makeMultiStore(["ZCNT-1", "ZCNT-2"]);
    try {
      __resetPromptStepsCacheForTests(store);
      await writeFile(promptPath("ZCNT-1"), VALID_PROMPT, "utf-8");
      await parseStepsFromPromptImpl(store, "ZCNT-1");
      await parseStepsFromPromptImpl(store, "ZCNT-1");
      expect(getPromptStepsCacheStats(store)).toMatchObject({ misses: 1, hits: 1, coalescedJoins: 0 });

      await writeFile(promptPath("ZCNT-2"), VALID_PROMPT, "utf-8");
      await Promise.all([
        parseStepsFromPromptImpl(store, "ZCNT-2"),
        parseStepsFromPromptImpl(store, "ZCNT-2"),
        parseStepsFromPromptImpl(store, "ZCNT-2"),
      ]);
      expect(getPromptStepsCacheStats(store)).toMatchObject({ misses: 2, coalescedJoins: 2 });

      // A withdrawn plan invalidates the entry it removes — and nothing else.
      await rm(promptPath("ZCNT-1"));
      expect(await parseStepsFromPromptImpl(store, "ZCNT-1")).toEqual([]);
      expect(getPromptStepsCacheStats(store)).toMatchObject({ invalidations: 1, liveEntries: 1 });

      expect(shouldWarnPromptParseFailure(store, "ZCNT-1", "boom")).toBe(true);
      expect(getPromptStepsCacheStats(store).warnedCards).toBe(1);
    } finally {
      __resetPromptStepsCacheForTests(store);
      await cleanup();
    }
  });

  it("never serves a coalesced parse that the joining read judged stale", async () => {
    /*
    FNXC:ListReadPromptParseCache 2026-11-09-11:28 (RUFU-495 residual pass):
    The race this pins: read A stats `PROMPT.md`, starts parsing, and is still in flight when the file is
    rewritten. Read B then stats the NEWER file, and with an id-only in-flight key it would join A and be
    handed the older plan — a stale-step answer that passes B's own freshness check. The in-flight key now
    carries the validated stamp, so B parses for its own stamp: exactly two disk reads for two stamps.
    */
    const { store, dir, cleanup } = await makeStore();
    try {
      await writeFile(join(dir, "PROMPT.md"), VALID_PROMPT, "utf-8");
      const before = readCount();
      let releaseGate: () => void = () => {};
      setReadGate(new Promise<void>((resolve) => { releaseGate = resolve; }));

      const staleStampRead = parseStepsFromPromptImpl(store, "TASK-1");
      await waitUntil(() => readCount() === before + 1, "the first parse to enter its gated read");

      await writeFile(join(dir, "PROMPT.md"), REWRITTEN_PROMPT, "utf-8");
      const freshStampRead = parseStepsFromPromptImpl(store, "TASK-1");
      await waitUntil(() => readCount() === before + 2, "the joining read to start its own parse");
      expect(getPromptStepsCacheStats(store).coalescedJoins).toBe(0);

      releaseGate();
      setReadGate(null);
      const [older, newer] = await Promise.all([staleStampRead, freshStampRead]);
      expect(older.map((s) => s.name)).toEqual(["Read the failing test", "Fix the invariant"]);
      expect(newer.length).toBe(3);
      expect(newer[2].name).toBe("Pin it with a regression test");

      // Whatever order the two parses finished in, the next read answers the CURRENT file: the losing
      // entry's stamp no longer matches the stat, so it is simply re-parsed rather than trusted.
      const settled = await parseStepsFromPromptImpl(store, "TASK-1");
      expect(settled.length).toBe(3);
      expect(readCount() - before).toBeGreaterThanOrEqual(2);
    } finally {
      setReadGate(null);
      __resetPromptStepsCacheForTests(store);
      await cleanup();
    }
  });
});
