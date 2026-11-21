/*
 * Store-seam tests for the `## Dependencies` projection (RUFU-750).
 *
 * FNXC:DependencyProjection 2026-11-13-19:11:
 * `parseDependenciesFromPrompt` keeps its name, arity and `Promise<string[]>` return, because 36 test
 * mocks and the durable-write inventory depend on them; what changes is WHICH ids come back. These
 * cases pin the three properties that make the change safe on the real seam: the store returns only
 * the waited-for ids, the call leaves `PROMPT.md` byte-identical (spec-lock canonicalizes the document
 * textually, so a rewriting guard would silently break approval evidence), and a denial is diagnosable
 * exactly once per card instead of on every read.
 *
 * The RUFU-747 bullets are the reported reproduction, typed in directly; `.fusion/tasks/RUFU-747/` is
 * gitignored and is never copied into the repository.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { parseDependenciesFromPromptImpl, shouldWarnPromptParseFailure } = await import("../task-artifacts-ops.js");
const { storeLog } = await import("../../store.js");

/** The harness shape used by `parse-steps-cache.test.ts`: a temp dir behind a faked `store.taskDir`. */
function storeFor(dir: string) {
  return { taskDir: () => dir } as unknown as Parameters<typeof parseDependenciesFromPromptImpl>[0];
}

const RUFU_747_PROMPT = [
  "# Task: RUFU-747 - re-deliver the landed squash",
  "",
  "## Dependencies",
  "",
  "- **Task:** RUFU-293 (parent, `in-review`; source of the commits on its branch). Its Code Review gate",
  "  is already `APPROVE_WITH_NOTES` with a `reviewInputFingerprint`, so this card carries that verdict",
  "  and does not re-resolve any of it.",
  "- **Task:** RUFU-294 - already implemented; its work reaches this card only as commits inside the",
  "  parent range. Not a blocker to start.",
  "- **Task:** RUFU-281 - **not a dependency**, despite the board listing. Same defect class, different",
  "  exemplar; the operator keeps it untouched.",
  "",
  "## Context to Read First",
  "",
  "- Nothing else.",
  "",
].join("\n");

describe("parseDependenciesFromPromptImpl", () => {
  let dir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function withPrompt(content: string | null): Promise<ReturnType<typeof storeFor>> {
    dir = await mkdtemp(join(tmpdir(), "rufu-750-deps-"));
    await mkdir(join(dir, ".fusion", "tasks", "RUFU-747"), { recursive: true });
    const cardDir = join(dir, ".fusion", "tasks", "RUFU-747");
    if (content !== null) await writeFile(join(cardDir, "PROMPT.md"), content, "utf-8");
    return { taskDir: () => cardDir } as unknown as ReturnType<typeof storeFor>;
  }

  it("returns only the waited-for id of the real RUFU-747 section", async () => {
    const store = await withPrompt(RUFU_747_PROMPT);
    vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);

    await expect(parseDependenciesFromPromptImpl(store, "RUFU-747")).resolves.toEqual(["RUFU-293"]);
  });

  it("leaves PROMPT.md byte-identical: the guard decides edges, never the document", async () => {
    const store = await withPrompt(RUFU_747_PROMPT);
    vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);
    const promptPath = join(dir, ".fusion", "tasks", "RUFU-747", "PROMPT.md");
    const before = await readFile(promptPath, "utf-8");

    await parseDependenciesFromPromptImpl(store, "RUFU-747");
    await parseDependenciesFromPromptImpl(store, "RUFU-747");

    expect(await readFile(promptPath, "utf-8")).toBe(before);
  });

  it("warns once per card about the withheld ids, not once per read", async () => {
    const store = await withPrompt(RUFU_747_PROMPT);
    const warn = vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);

    await parseDependenciesFromPromptImpl(store, "RUFU-747");
    await parseDependenciesFromPromptImpl(store, "RUFU-747");
    await parseDependenciesFromPromptImpl(store, "RUFU-747");

    const withheld = warn.mock.calls.filter((call) => String(call[0]).includes("withheld"));
    expect(withheld).toHaveLength(1);
    expect(withheld[0]![0]).toContain("RUFU-294");
    expect(withheld[0]![0]).toContain("RUFU-281");
    // The gate keys on the CARD ID alone, as prompt-parse-warning-gate.test.ts demands of every warn.
    expect(shouldWarnPromptParseFailure(store, "RUFU-747", "another failure")).toBe(false);
    expect(shouldWarnPromptParseFailure(store, "RUFU-999", "a different card")).toBe(true);
  });

  it("returns an empty list for `- **None**` without claiming a denial", async () => {
    const store = await withPrompt("# Task\n\n## Dependencies\n\n- **None**\n\n## Steps\n");
    const warn = vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);

    await expect(parseDependenciesFromPromptImpl(store, "RUFU-747")).resolves.toEqual([]);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("withheld"))).toHaveLength(0);
  });

  it("returns an empty list when PROMPT.md does not exist", async () => {
    const store = await withPrompt(null);
    vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);

    await expect(parseDependenciesFromPromptImpl(store, "RUFU-747")).resolves.toEqual([]);
  });

  it("still projects every id when the section carries no denial at all", async () => {
    const store = await withPrompt([
      "# Task",
      "",
      "## Dependencies",
      "",
      "- **Task:** RUFU-100 (blocked by its landing)",
      "- **Task:** RUFU-101 (prerequisite for the migration slot)",
      "",
      "## Steps",
      "",
    ].join("\n"));
    vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);

    await expect(parseDependenciesFromPromptImpl(store, "RUFU-747")).resolves.toEqual(["RUFU-100", "RUFU-101"]);
  });
});
