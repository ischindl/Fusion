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
  (globalThis as { __promptReads?: number }).__promptReads = 0;
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      (globalThis as { __promptReads?: number }).__promptReads = ((globalThis as { __promptReads?: number })
        .__promptReads ?? 0) + 1;
      return actual.readFile(...args);
    },
  };
});

const readCount = () => (globalThis as { __promptReads?: number }).__promptReads ?? 0;

const { parseStepsFromPromptImpl, shouldWarnPromptParseFailure } = await import(
  "../task-artifacts-ops.js"
);
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
});
