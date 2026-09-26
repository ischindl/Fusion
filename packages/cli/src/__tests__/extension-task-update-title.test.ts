/**
 * FNXC:TaskTitleHygiene 2026-09-26-05:25 (RUFU-295):
 * The pi extension's `fn_task_update` is the rename edge a fixer session actually has — RUFU-294's author
 * could see its own `## Pôvodný popis` title, knew the fix, and had no tool to apply it: the CLI rename
 * lives in another process and `fn_task_delete` refuses a card's own creator.
 *
 * Two contracts meet here and both must survive:
 *  - a junk-shaped title (markdown heading, multi-line paste, over budget) is REFUSED with nothing
 *    persisted, so the board never accumulates a section heading as a task name;
 *  - an explicitly blank title still CLEARS the title, which is this tool's long-standing pre-existing
 *    behavior — clearing is the operator saying "no explicit title, derive it", not a shape violation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createMockApi,
  createPgExtensionHarness,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const pgTest = pgDescribe;

pgTest("extension fn_task_update title hygiene", () => {
  const h = createPgExtensionHarness("fn-ext-task-update-title");
  let api: ReturnType<typeof createMockApi>;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    api = createMockApi();
    registerExtension(api);
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const ctx = () => ({ cwd: h.rootDir() } as any);

  it("renames the card through a one-line title and reports it", async () => {
    const created = await h.store().createTask({ title: "Authored REVISE park", description: "Desc" });
    const tool = requireTool(api, "fn_task_update");

    const result = await tool.execute("call", { id: created.id, title: "  Authored code-review REVISE must not become a stall deadlock park  " }, undefined, undefined, ctx());

    expect(result.isError).not.toBe(true);
    const stored = await h.store().getTask(created.id);
    expect(stored?.title).toBe("Authored code-review REVISE must not become a stall deadlock park");
    expect((result.content[0] as { text: string }).text).toContain("title");
  });

  it("refuses a markdown-heading title and leaves the stored title untouched", async () => {
    const created = await h.store().createTask({ title: "Heading junk card", description: "Desc" });
    const tool = requireTool(api, "fn_task_update");

    const result = await tool.execute("call", { id: created.id, title: "## Pôvodný popis" }, undefined, undefined, ctx());

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/title rejected .*markdown heading is not a title/);
    const stored = await h.store().getTask(created.id);
    expect(stored?.title).toBe("Heading junk card");
  });

  it("refuses a multi-line paste rather than storing a description slice", async () => {
    const created = await h.store().createTask({ title: "Telemetria card", description: "Desc" });
    const tool = requireTool(api, "fn_task_update");

    const result = await tool.execute("call", { id: created.id, title: "Merateľná prompt-cache telemetria per lane\nusage + system head hash" }, undefined, undefined, ctx());

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/single line/);
    expect((await h.store().getTask(created.id))?.title).toBe("Telemetria card");
  });

  it("still clears a title when the caller passes a blank one", async () => {
    const created = await h.store().createTask({ title: "Explicit title to drop", description: "Desc" });
    const tool = requireTool(api, "fn_task_update");

    const result = await tool.execute("call", { id: created.id, title: "   " }, undefined, undefined, ctx());

    expect(result.isError).not.toBe(true);
    // A cleared title persists as absent (NULL), not as an empty string the UI would render.
    expect((await h.store().getTask(created.id))?.title ?? "").toBe("");
  });
});
