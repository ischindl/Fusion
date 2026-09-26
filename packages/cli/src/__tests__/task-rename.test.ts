/**
 * FNXC:TaskTitleHygiene 2026-09-26-04:45 (RUFU-295):
 * `fn task rename` is the agent-reachable fix for a mis-titled card. Before it existed, the five live
 * junk titles on the board (`## Pôvodný popis`, `PREMISA (merané…)`, and cards whose "title" was a whole
 * multi-line description) had exactly one remedy — an operator editing the card in the dashboard —
 * because the CLI exposed no title edit and `deleteTask` refuses a card's own creator (measured on RUFU-294).
 *
 * These cases pin both halves of the contract:
 *  - a valid one-line title persists durably and the card's PROMPT.md heading follows it (the store's
 *    title-sync seam, reached because the command writes through `store.updateTask`);
 *  - junk shapes are REFUSED with an actionable message and nothing is written, rather than being
 *    silently repaired by the store write guard into a label the caller never typed.
 *
 * The command resolves its store through `project-context.resolveProject`, a cache separate from the
 * extension store the harness injects, so `resolveProject` is redirected to the harness store exactly as
 * `task-retry.test.ts` does.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  closeProjectStore: closeProjectStoreMock,
  asLocalProjectContext: (store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    resolvedFrom: "cwd-fallback",
    store,
  }),
}));

import { runTaskRename } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("fn task rename (runTaskRename)", () => {
  const h = createPgExtensionHarness("fn-task-rename");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  /**
   * Seed a card with a clean label. The shapes the rename must refuse cannot be seeded here: the
   * create-side write guard (RUFU-295 Step 1) already repairs a heading or multi-line title into a
   * derived label, so a refusal case asserts that the caller's existing label survives the refusal.
   */
  async function seededTask(title: string) {
    const store = h.store();
    return store.createTask({
      title,
      description: "Uvítali by sme možnosť premenovať kartu priamo z agenta.",
      column: "todo",
    });
  }

  it("persists a trimmed one-line title and carries the PROMPT.md heading along", async () => {
    const task = await seededTask("Zalializovať schválenú prácu");
    const desired = "  Authored code-review REVISE must not become a stall deadlock park  ";

    await runTaskRename(task.id, desired);

    const updated = await h.store().getTask(task.id);
    expect(updated.title).toBe(desired.trim());
    // The durable label and the spec heading must not disagree afterwards — `store.updateTask` owns
    // that sync, which is exactly why this command writes through it instead of touching task.json.
    const promptPath = join(h.store().taskDir(task.id), "PROMPT.md");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf8").split("\n")[0]).toContain(desired.trim());
  });

  it("reports the rename on the line the operator reads", async () => {
    const task = await seededTask("Stranded-continuation reclaim");
    const log = vi.mocked(console.log);

    await runTaskRename(task.id, "Stranded-continuation reclaim must sustain-defer, never re-queue");

    const printed = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(printed).toContain(`${task.id}: title → Stranded-continuation reclaim must sustain-defer, never re-queue`);
    expect(printed).toContain("was: Stranded-continuation reclaim");
  });

  it("refuses a markdown heading and writes nothing", async () => {
    const task = await seededTask("Authored code-review REVISE park");

    await expect(runTaskRename(task.id, "## Pôvodný popis")).rejects.toThrow(/markdown heading is not a title/);

    expect((await h.store().getTask(task.id)).title).toBe("Authored code-review REVISE park");
  });

  it("refuses a multi-line title instead of storing a description slice", async () => {
    const task = await seededTask("Merateľná prompt-cache telemetria");

    await expect(
      runTaskRename(task.id, "Merateľná prompt-cache telemetria per lane\nusage + system head hash"),
    ).rejects.toThrow(/single line/);

    expect((await h.store().getTask(task.id)).title).toBe("Merateľná prompt-cache telemetria");
  });

  it("refuses a blank title rather than clearing the card label", async () => {
    const task = await seededTask("Task-id attribution in worktree recovery");

    await expect(runTaskRename(task.id, "   ")).rejects.toThrow(/a title is required/);

    expect((await h.store().getTask(task.id)).title).toBe("Task-id attribution in worktree recovery");
  });

  it("names an unknown task id in the failure the CLI surfaces", async () => {
    await seededTask("Zalializovať schválenú prácu");

    /*
    The store raises its canonical `Task <id> not found` rather than returning nothing, so the command's
    own `Task not found: <id>` guard is the fallback, not the common path. Either phrasing reaches the
    caller through the CLI's top-level `Error: <message>` handler with a non-zero exit; what the operator
    needs from either is that the id they typed is echoed back.
    */
    await expect(runTaskRename("RUFU-999", "Any real title")).rejects.toThrow(/(Task not found: |Task )RUFU-999/);
  });
});
