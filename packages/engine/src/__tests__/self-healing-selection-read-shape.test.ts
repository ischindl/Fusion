/*
FNXC:SelfHealingReadShape 2026-09-25-13:27 (RUFU-312 step 2):
Structural ratchet for the selection-read shape in `self-healing.ts`.

The behavioural fix (threading a sweep-scoped `WorkflowSelectionCache` into the role resolvers) is
invisible to a behaviour test on any single card: one card costs one read either way. The cost only
appears at sweep size, and production measured it 2026-09-25 as 82-131 concurrent identical
`task_workflow_selection` SELECTs with 0 tasks executing. A refactor that drops the selection cache
while keeping the IR cache would therefore be green in every per-card test and simply re-create the
fan-out in production.

So this test guards the CALL SHAPE directly. It is a code-construct guard (assertions on structure,
never on prose or comments — comments are stripped before matching), in the same family as
`legacy-tombstones.test.ts`. Reintroducing a selection-blind resolver call inside a sweep loop fails
here with the exact call to fix.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Removes block and line comments so the scan can only ever match executable code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = stripComments(
  readFileSync(new URL("../self-healing.ts", import.meta.url).pathname, "utf8"),
);

describe("self-healing role resolvers never read a selection per card", () => {
  it("the four role resolvers forward a selection cache to the IR resolver", () => {
    // A 3-argument call inside these helpers reads `task_workflow_selection` once per card.
    expect(source).not.toContain("resolveWorkflowIrForTask(this.store, taskId, cache)");
    expect(source).toContain("resolveWorkflowIrForTask(this.store, taskId, cache, selectionCache)");
  });

  it("every sweep loop that re-resolves roles passes the sweep's selection cache", () => {
    // Each of these sits inside a per-card loop; the 2-argument form is the N+1 shape.
    expect(source).not.toContain("this.resolvePreWipColumns(live.id, preWipCache)");
    expect(source).not.toContain("this.resolvePreWipColumns(task.id, reaperCache)");
    expect(source).not.toContain("this.resolvePauseAbortColumnsFor(t.id, columnCache)");
    expect(source).not.toContain("this.resolvePauseAbortColumnsFor(fresh.id, columnCache)");

    expect(source).toContain("this.resolvePreWipColumns(live.id, preWipCache, preWipSelection)");
    expect(source).toContain("this.resolvePreWipColumns(task.id, reaperCache, reaperSelection)");
    expect(source).toContain("this.resolvePauseAbortColumnsFor(t.id, columnCache, pauseAbortSelection)");
    expect(source).toContain("this.resolvePauseAbortColumnsFor(fresh.id, columnCache, pauseAbortSelection)");
  });

  it("hydrates the sweep cache through the batched prefetch, not per-card reads", () => {
    // The single place a sweep cache is built; it must go through the batched reader.
    expect(source).toContain("await prefetchWorkflowSelections(this.store, taskIds, cache)");
    // `filterByPreWipRole` runs over the whole board, so it must own a cache when the caller has none.
    expect(source).toContain("selectionCache ?? await this.newSelectionCache(tasks.map((task) => task.id))");
  });
});
