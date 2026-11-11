/**
 * FNXC:ListReadPromptParseCache 2026-11-09-12:05 (RUFU-495):
 * The memo in `parseStepsFromPromptImpl` is the only thing standing between a board mount and one
 * `readFile` + one parse per card per read, per poll. Unit cover (`task-store/__tests__/parse-steps-cache.test.ts`)
 * proves the cache in isolation; THIS file proves the two things only a real backend read can show:
 *
 *  1. the shipped read surfaces (`listTasks` slim sync, `searchTasks` sync) actually ENTER the funnel
 *     on every read and still get ZERO additional `PROMPT.md` reads, so the saving lives below the
 *     read path and is not a read-path skip (the RUFU-627 field-declaration slice owns the skip, and
 *     an undeclared-`steps` read must perform zero funnel calls — pinned here too, unchanged);
 *  2. a card whose `PROMPT.md` cannot be parsed emits ONE warning per card per process across EVERY
 *     read surface — the ~1.7 warning lines/s the profile measured were the same card warned once
 *     per read per surface, and the text an operator greps had to stay byte-identical.
 *
 * Freshness is file-derived (mtime+size), never TTL-derived, so a rewrite re-parses and a deleted
 * `PROMPT.md` stops showing steps instead of serving the last good plan.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { storeLog } from "../../store.js";
import {
  __resetPromptStepsCacheForTests,
  getPromptStepsCacheStats,
  isPromptStepsCacheEntryLive,
} from "../../task-store/task-artifacts-ops.js";

const pgTest = pgDescribe;

/*
FNXC:ListReadPromptParseCache 2026-11-09-12:05 (RUFU-495):
The test authority for "the file was read from disk" is a `readFile` shim, not the cache counters —
counters that agreed with themselves would have passed while the file was still being read. The shim
is a module factory rather than `vi.spyOn(fsPromises, "readFile")` because the store takes a NAMED
import (`import { readFile } from "node:fs/promises"`), which a namespace spy cannot rebind; this is
the same shim shape `parse-steps-cache.test.ts` already uses. Only `PROMPT.md` reads are counted, so
`task.json`, agent-log, and harness reads never inflate the figure, and every call still hits the
real implementation.
*/
(globalThis as { __promptMdReadCount?: number }).__promptMdReadCount ??= 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const counter = globalThis as { __promptMdReadCount?: number };
  return {
    ...actual,
    readFile: (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith("PROMPT.md")) {
        counter.__promptMdReadCount = (counter.__promptMdReadCount ?? 0) + 1;
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

function promptReads(): number {
  return (globalThis as { __promptMdReadCount?: number }).__promptMdReadCount ?? 0;
}

/** A plan the current parser accepts: two authored headings under `## Steps`. */
function promptWithStepCount(taskId: string, count: number): string {
  const steps = Array.from(
    { length: count },
    (_, i) => `### Step ${i + 1}: ${taskId} step ${i + 1}\n\nBody ${i + 1}.\n`,
  ).join("\n");
  return `# ${taskId}\n\n## Original Description\n\nRUFU-495 memo probe ${taskId}\n\n## Steps\n\n${steps}`;
}

/**
 * FNXC:ListReadPromptParseCache 2026-11-09-12:05 (RUFU-495):
 * The rejection this fixture provokes is the FN-9435 dependency-validation rejection — a
 * `### Step 2 (depends: 0 (zero)):` heading whose parenthetical is not a task id. It is the shape
 * the shipped failure cache already remembers, and it must stay malformed for the whole test.
 */
const MALFORMED_PROMPT = `# Z495-90

## Original Description

RUFU-495 memo probe Z495-90

## Steps

### Step 0: Preflight

Body.

### Step 2 (depends: 0 (zero)): Write the answer

Body.
`;

pgTest("list read prompt-steps memo (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_prompt_steps_memo",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    // The shared harness keeps one store across cases and reuses card ids after its truncate, so a
    // case must never inherit another case's remembered plan.
    __resetPromptStepsCacheForTests(h.store());
    (globalThis as { __promptMdReadCount?: number }).__promptMdReadCount = 0;
  });
  afterEach(async () => {
    await h.afterEach();
  });

  /** Creates a card whose PERSISTED `steps` is empty, so any resolved plan came from `PROMPT.md`. */
  async function seedPromptCard(taskId: string, prompt: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `RUFU-495 memo probe ${taskId}`, column: "todo" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    const dir = store.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROMPT.md"), prompt, "utf-8");
  }

  /** Counts entries into the single funnel by wrapping the public method the read paths call. */
  function instrumentFunnel(store: ReturnType<SharedPgTaskStoreHarness["store"]>) {
    const funnel = { entries: 0 };
    const original = store.parseStepsFromPrompt.bind(store);
    store.parseStepsFromPrompt = async (taskId: string) => {
      funnel.entries += 1;
      return original(taskId);
    };
    return funnel;
  }

  /** The board's own read shape, minus the startup memo — the memo would answer the 2nd read itself. */
  const BOARD_READ = {
    slim: true,
    includeArchived: false,
    startupMemo: false,
  } as const;

  it("reads each card's plan once per process, not once per board read", async () => {
    const store = h.store();
    const ids = Array.from({ length: 10 }, (_, i) => `Z495-${String(i + 1).padStart(2, "0")}`);
    for (const [i, id] of ids.entries()) {
      await seedPromptCard(id, promptWithStepCount(id, (i % 3) + 2));
    }
    const funnel = instrumentFunnel(store);

    const beforeStats = getPromptStepsCacheStats(store);
    const firstReadsBefore = promptReads();
    const first = await store.listTasks({ ...BOARD_READ });
    expect(first).toHaveLength(10);

    // Control: the funnel really ran for all ten cards and the plan is the card's OWN authored plan.
    expect(funnel.entries).toBe(10);
    const readsFirst = promptReads() - firstReadsBefore;
    expect(readsFirst).toBe(10);
    expect(getPromptStepsCacheStats(store).misses - beforeStats.misses).toBe(10);
    for (const [i, id] of ids.entries()) {
      const row = first.find((task) => task.id === id)!;
      expect(row.steps.map((step) => step.name)).toEqual(
        Array.from({ length: (i % 3) + 2 }, (_, n) => `${id} step ${n + 1}`),
      );
    }

    // The invariant: a second read performs the same sync and costs zero file reads.
    funnel.entries = 0;
    const secondReadsBefore = promptReads();
    const second = await store.listTasks({ ...BOARD_READ });
    expect(funnel.entries, "the read path still runs the sync on the second read").toBe(10);
    expect(promptReads() - secondReadsBefore, "no card's PROMPT.md was read twice").toBe(0);
    expect(getPromptStepsCacheStats(store).hits - beforeStats.hits).toBe(10);
    expect(second.map((task) => task.steps)).toEqual(first.map((task) => task.steps));

    // The search surface shares the memo: warmed by the board reads, it too reads nothing.
    funnel.entries = 0;
    const searchReadsBefore = promptReads();
    const searched = await store.searchTasks("memo", { slim: true, includeArchived: false });
    expect(searched).toHaveLength(10);
    expect(funnel.entries).toBe(10);
    expect(promptReads() - searchReadsBefore).toBe(0);
    expect(searched.map((task) => task.steps).sort()).toEqual(
      first.map((task) => task.steps).sort(),
    );
  });

  it("coalesces concurrent reads of one card into a single read and hands out copies", async () => {
    const store = h.store();
    await seedPromptCard("Z495-70", promptWithStepCount("Z495-70", 3));
    const statsBefore = getPromptStepsCacheStats(store);
    const readsBefore = promptReads();

    const plans = await Promise.all(
      Array.from({ length: 10 }, () => store.parseStepsFromPrompt("Z495-70")),
    );

    expect(promptReads() - readsBefore).toBe(1);
    const stats = getPromptStepsCacheStats(store);
    expect(stats.misses - statsBefore.misses).toBe(1);
    expect(stats.coalescedJoins - statsBefore.coalescedJoins).toBe(9);
    for (const plan of plans.slice(1)) {
      expect(plan).toEqual(plans[0]);
    }
    // Defensive copies survive the funnel even when ten callers joined one read.
    plans[0]![0]!.name = "mutated by one caller";
    expect(plans[1]![0]!.name).not.toBe("mutated by one caller");
  });

  it("re-reads after a rewrite and stops showing steps after a delete", async () => {
    const store = h.store();
    await seedPromptCard("Z495-71", promptWithStepCount("Z495-71", 2));
    expect((await store.parseStepsFromPrompt("Z495-71")).map((step) => step.name)).toEqual([
      "Z495-71 step 1",
      "Z495-71 step 2",
    ]);

    // A different byte length is a different stamp, so freshness does not depend on clock resolution.
    writeFileSync(
      join(store.taskDir("Z495-71"), "PROMPT.md"),
      promptWithStepCount("Z495-71", 4),
      "utf-8",
    );
    const readsBefore = promptReads();
    expect(await store.parseStepsFromPrompt("Z495-71")).toHaveLength(4);
    expect(promptReads() - readsBefore).toBe(1);

    // A deleted PROMPT.md is not a reason to keep showing last time's plan, and degrades silently.
    const warnSpy = vi.spyOn(storeLog, "warn").mockImplementation(() => {});
    rmSync(join(store.taskDir("Z495-71"), "PROMPT.md"));
    expect(await store.parseStepsFromPrompt("Z495-71")).toEqual([]);
    expect(isPromptStepsCacheEntryLive(store, "Z495-71")).toBe(false);
    expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes("PROMPT.md"))).toEqual([]);
    warnSpy.mockRestore();
  });

  it("performs zero funnel calls for a read that declares its fields without steps", async () => {
    const store = h.store();
    await seedPromptCard("Z495-72", promptWithStepCount("Z495-72", 2));
    await seedPromptCard("Z495-73", promptWithStepCount("Z495-73", 3));
    const funnel = instrumentFunnel(store);

    const control = await store.listTasks({ ...BOARD_READ });
    expect(funnel.entries).toBe(2);
    expect(control.every((task) => task.steps.length > 0)).toBe(true);

    // RUFU-627's declaration skip stays intact: no funnel entry, and the persisted (empty) steps.
    funnel.entries = 0;
    const declared = await store.listTasks({
      ...BOARD_READ,
      fields: ["id", "column"],
    });
    expect(funnel.entries).toBe(0);
    expect(declared.every((task) => task.steps.length === 0)).toBe(true);
  });

  it("warns once per card per process across every read surface, with unchanged text", async () => {
    const store = h.store();
    await seedPromptCard("Z495-90", MALFORMED_PROMPT);
    await seedPromptCard("Z495-91", promptWithStepCount("Z495-91", 2));
    // Precondition: the card really is malformed through the shipped funnel, so a missing warning
    // can only be explained by the gate and not by a parse that quietly succeeded.
    await expect(store.parseStepsFromPrompt("Z495-90")).rejects.toThrow();
    __resetPromptStepsCacheForTests(store);

    const warnSpy = vi.spyOn(storeLog, "warn").mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 3; pass += 1) await store.listTasks({ ...BOARD_READ });
      for (let pass = 0; pass < 2; pass += 1) {
        await store.searchTasks("memo", { slim: true, includeArchived: false });
      }
      // A surface OUTSIDE the list reads reaches the same one slot for the same card.
      await expect(store.updateStep("Z495-90", 0, "in-progress")).rejects.toThrow();

      const warned = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("failed to sync steps from PROMPT.md for Z495-90"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("during listTasks:");
      expect(
        warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes("failed to auto-init steps from PROMPT.md for Z495-90"),
        ),
      ).toEqual([]);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("for Z495-91")),
        "a readable card emits no warning at all",
      ).toBe(false);
      expect(getPromptStepsCacheStats(store).liveWarnedKeys).toBe(1);
      // The row still degrades to its persisted steps rather than failing the read.
      const rows = await store.listTasks({ ...BOARD_READ });
      expect(rows.find((task) => task.id === "Z495-90")!.steps).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
