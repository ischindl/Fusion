import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { evaluateScopeAutoWiden } from "../merge/merger-scope-auto-widen.js";

/*
FNXC:CommitAttribution 2026-11-19-02:48 (RUFU-669):
The other half of the SANE-489 defect. This gate — the Layer-2.5/3 auto-widen — decided `null` for a
commit whose subject names the card mid-string, refused the card's own file `foreign-commit`, and left it
out of the effective declared File Scope. `merger.ts` then resolves every still-out-of-scope conflict with
`--ours`, i.e. MAIN'S BYTES, so the card merged away its own work. These cases pin the whole decision
table of one candidate file, because the refusal vocabulary is unchanged and only the classification moved.
*/
const TASK_ID = "SANE-489";
const FILE = "packages/dashboard/app/components/TaskDetailModal.css";

function record(sha: string, subject: string, body = ""): string {
  return `${sha}\x00${subject}\x00${body}\x1e`;
}

function makeExec(log: string) {
  return vi.fn(async (command: string) => {
    if (command.startsWith("git check-ignore")) {
      throw Object.assign(new Error("not ignored"), { code: 1 });
    }
    if (command.startsWith("git log")) {
      return { stdout: log, stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

function evaluate(log: string, candidateFiles: string[] = [FILE]) {
  const store = {
    parseFileScopeFromPrompt: async () => [],
    listTasks: async () => [],
  } as unknown as Pick<TaskStore, "parseFileScopeFromPrompt"> & Partial<Pick<TaskStore, "listTasks">>;

  return evaluateScopeAutoWiden({
    store,
    task: { id: TASK_ID } as Task,
    taskId: TASK_ID,
    rootDir: "/tmp/repo",
    branch: `fusion/${TASK_ID.toLowerCase()}`,
    baseRef: "main",
    candidateFiles,
    execAsyncImpl: makeExec(log) as never,
  });
}

describe("RUFU-669 scope auto-widen attribution gate", () => {
  it("widens a file whose commit names the executing card mid-subject", async () => {
    const result = await evaluate(
      record("d2447193ebf", "test(ui): gardy legacy tvarov na výstupe mapovania (SANE-489 AC1-AC4, krok 6)"),
    );

    expect(result.refused).toEqual([]);
    expect(result.widened).toHaveLength(1);
    expect(result.widened[0]).toMatchObject({ file: FILE, attribution: "own-mention", commits: ["d2447193ebf"] });
  });

  // The id is canonical (`[A-Z][A-Z0-9]*-\d+`), because that is what makes the commit positively
  // attributable to another card. The briefing's shorthand `feat(FN-OTHER): x` names no card under that
  // grammar — its own case is asserted below, where the honest refusal is `no-attribution`.
  it("still refuses a commit positively attributed to another card", async () => {
    const result = await evaluate(record("a1b2c3d", "feat(FN-1000): x"));

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: FILE, reason: "foreign-commit" }]);
  });

  it("refuses a commit that names no card as no-attribution, never as foreign", async () => {
    const result = await evaluate(record("a1b2c3d", "chore: vendored dependency bump"));

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: FILE, reason: "no-attribution" }]);
  });

  it("refuses a subject that only LOOKS like an id (non-numeric scope) as no-attribution", async () => {
    const result = await evaluate(record("a1b2c3d", "feat(FN-OTHER): x"));

    // Same effective outcome the pre-RUFU-669 gate produced (the file stays out of scope, so main's
    // bytes still win); only the reported reason became honest.
    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: FILE, reason: "no-attribution" }]);
  });

  it("refuses a mixed own + foreign range as foreign-commit", async () => {
    const result = await evaluate(
      [
        record("own1", `fix(${TASK_ID}): own fix`),
        record("for1", "feat(FN-1000): x"),
      ].join(""),
    );

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: FILE, reason: "foreign-commit" }]);
  });

  it("refuses a zero-commit range as no-attribution", async () => {
    const result = await evaluate("");

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: FILE, reason: "no-attribution" }]);
  });

  it("reports an observed attribution when a range's sources disagree", async () => {
    const result = await evaluate(
      [
        record("own1", `fix(${TASK_ID}): own fix`),
        record("own2", "chore: refactor shared styles", `Fusion-Task-Id: ${TASK_ID}`),
      ].join(""),
    );

    expect(result.refused).toEqual([]);
    expect(result.widened[0]?.attribution).toBe("trailer");
    expect(result.widened[0]?.commits).toEqual(["own1", "own2"]);
  });

  it("reports the observed own-mention when it is the only source present", async () => {
    const result = await evaluate(
      [
        record("own1", `chore(ui): tidy tokens (${TASK_ID}, krok 1)`),
        record("own2", `chore(ui): tidy rules (${TASK_ID}, krok 2)`),
      ].join(""),
    );

    expect(result.refused).toEqual([]);
    // The pre-RUFU-669 collapse fabricated "trailer" whenever sources disagreed; a uniform
    // own-mention range must still report the source it actually saw.
    expect(result.widened[0]?.attribution).toBe("own-mention");
  });

  it("keeps refusing the .fusion path family without touching git log", async () => {
    const execAsyncImpl = makeExec("");
    const store = {
      parseFileScopeFromPrompt: async () => [],
      listTasks: async () => [],
    } as unknown as Pick<TaskStore, "parseFileScopeFromPrompt"> & Partial<Pick<TaskStore, "listTasks">>;

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: TASK_ID } as Task,
      taskId: TASK_ID,
      rootDir: "/tmp/repo",
      branch: `fusion/${TASK_ID.toLowerCase()}`,
      baseRef: "main",
      candidateFiles: [".fusion/memory/MEMORY.md"],
      execAsyncImpl: execAsyncImpl as never,
    });

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: ".fusion/memory/MEMORY.md", reason: "ignored-path" }]);
    expect(execAsyncImpl.mock.calls.some(([command]) => String(command).startsWith("git log"))).toBe(false);
  });
});
