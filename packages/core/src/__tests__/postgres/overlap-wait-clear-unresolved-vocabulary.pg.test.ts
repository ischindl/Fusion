/*
FNXC:OverlapWaitRelease 2026-10-18-18:12 (RUFU-341 — a released overlap wait left the victim frozen forever):

RUFU-254 carried `overlapBlockedBy=RUFU-257` with `column=todo`, `status=queued` and an empty History after
the release line `Overlap wait released behind RUFU-257` — a frozen row while the predecessor sat `done` and
merged. Reading the two seams side by side shows why the release and the clear disagree:

  * `completeTaskOverlapWait` records the release and moves the EPISODE. It never touches the victim row.
  * `reconcileTaskOverlapWaits` owns the marker/status clear, and its only reason for a live predecessor is
    `overlapPredecessorRelease` returning `"complete"` — which is `completeColumns.has(blocker.column)`.

`completeColumns` was built from `resolveTaskLifecycleColumns(...)?.complete` with NO fallback:

    completeById.set(id, new Set(lanes?.complete ? [lanes.complete] : []))

`resolveTaskLifecycleColumns` returns `undefined` for a column-less (v1) IR or a failed read, and returns a
struct whose `complete` is `undefined` for the SYNTHESIZED face `workflow-lifecycle-traits.ts` documents — a
v1 graph upgraded to v2 whose columns carry `traits: []` ("placement only"). Either way the set is EMPTY, so
`"complete"` can never be returned: no reason, no cancel, no clear. Silently, and on every pass, forever.

Meanwhile the SCHEDULER asks the same question through the other authority, `isCompleteColumnRole(flags, id)`
/ `isTerminalColumnRole`, which keeps an explicit legacy floor: `flags ? flags.complete === true : id === "done"`.
With unresolved flags it answers TRUE for a card resting in `done`. So the scheduler refuses to dispatch the
victim because the predecessor's lane is terminal, while the reconciler refuses to release it because it
cannot tell that the predecessor's lane is terminal. Two authorities, one row, permanent disagreement — and
both frozen fields are admission gates (`scheduler.ts`: `if (task.overlapBlockedBy) this.overlapBlockedTaskIds
.add(task.id)`, and the wake requires `!task.status`), so the card is not merely mislabelled, it is unclaimable.

The cases are DIFFERENTIAL on purpose: the same release against a vocabulary that resolves (`builtin:coding`)
and one that does not (`traits: []`), plus a renamed complete lane so a surviving `"done"` literal cannot pass
by luck, plus the fail-closed pairing (a predecessor still mid-flight must keep holding the marker).
*/

import { sql } from "drizzle-orm";
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";
import { isCompleteColumnRole } from "../../column-roles.js";
import { reconcileReleasedOverlapWaits } from "../../../../engine/src/self-healing/released-overlap-waits.js";

pgDescribe("overlap wait released behind a predecessor whose lifecycle vocabulary does not resolve", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ow_unresolved_voc",
    projectId: "project-ow-unresolved-vocabulary",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  type MutableIr = {
    id: string;
    nodes: { id: string; column?: string }[];
    columns?: { id: string; traits?: unknown[] }[];
  };

  /** Deep-clone the builtin coding board and rewrite only what a case needs. */
  function cloneBuiltinIr(id: string): MutableIr {
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as MutableIr;
    ir.id = id;
    return ir;
  }

  /**
   * The predecessor's board declares its columns for PLACEMENT but carries no lifecycle trait at all —
   * byte-identical to what `synthesizeDefaultColumns` emits when a v1 graph is upgraded to v2
   * ("placement only"), the face `workflow-lifecycle-traits.ts` warns callers about.
   */
  async function seedTraitlessWorkflow(): Promise<string> {
    const ir = cloneBuiltinIr("custom:ow-traitless-vocabulary");
    for (const column of ir.columns ?? []) {
      expect((column.traits ?? []).length).toBeGreaterThan(0); // prove the builtin really does declare traits
      column.traits = [];
    }
    const created = await h.store().createWorkflowDefinition({
      name: "Traitless vocabulary (overlap wait)",
      kind: "workflow",
      ir: ir as never,
    } as never);
    return (created as { id: string }).id;
  }

  /*
  FNXC:OverlapWaitRelease 2026-10-18-18:51 (RUFU-341 code review — first-match vs membership):
  A board may declare MORE THAN ONE complete lane (the owned green face `MULTI_LEASE_IR` in
  `store-overlap-repair-lanes-resolved.test.ts` pins exactly that for the overlap-REPAIR seam). This board
  reproduces the face for the release decision, built from the builtin so every OTHER role still resolves:
  `done` stays the FIRST complete column and `shipped-secondary` is the second one.

  That ordering is the whole case. A release test built from `resolveLifecycleColumns(ir).complete` — which is
  first-match-per-role — answers `{ done }` here, so a predecessor resting in `shipped-secondary` is never
  terminal and the waiter keeps `overlapBlockedBy` + `status="queued"` forever. Only a membership answer
  (`columnsWithFlag(ir, "complete")`) sees the card as finished.
  */
  async function seedTwoCompleteLanesWorkflow(): Promise<string> {
    const ir = cloneBuiltinIr("custom:ow-two-complete-lanes");
    ir.columns!.push({ id: "shipped-secondary", name: "Shipped secondary", traits: [{ trait: "complete" }] });
    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids.indexOf("done")).toBeLessThan(ids.indexOf("shipped-secondary")); // prove first-match would pick `done`
    const created = await h.store().createWorkflowDefinition({
      name: "Two complete lanes (overlap wait)",
      kind: "workflow",
      ir: ir as never,
    } as never);
    return (created as { id: string }).id;
  }

  /** The builtin board with every column id renamed, so no legacy literal can pass by luck. */
  async function seedRenamedCompleteWorkflow(): Promise<string> {
    const rename: Record<string, string> = {
      triage: "intake",
      todo: "backlog",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
    };
    const ir = cloneBuiltinIr("custom:ow-renamed-complete");
    for (const node of ir.nodes ?? []) {
      if (node.column) node.column = rename[node.column] ?? node.column;
    }
    for (const column of ir.columns ?? []) column.id = rename[column.id] ?? column.id;
    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("shipped");
    expect(ids).not.toContain("done");
    const created = await h.store().createWorkflowDefinition({
      name: "Renamed complete lane (overlap wait)",
      kind: "workflow",
      ir: ir as never,
    } as never);
    return (created as { id: string }).id;
  }

  /**
   * Seed the exemplar shape through the real seams: the scheduler's queued-episode writer parks the victim
   * behind the predecessor, the predecessor then reaches its terminal lane, and the executor's overlap gate
   * releases the wait — the state RUFU-254 was frozen in. `blockerColumn` defaults to the terminal lane;
   * pass a mid-flight lane for the fail-closed pairing.
   */
  async function seedReleasedExemplar(options: { blockerWorkflowId?: string; blockerColumn?: string } = {}) {
    const store = h.store();
    const blocker = await store.createTask({ description: "predecessor owning the scope" });
    const victim = await store.createTask({ description: "victim parked behind it" });
    if (options.blockerWorkflowId) {
      await store.writeTaskWorkflowSelection(blocker.id, options.blockerWorkflowId, []);
    }
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='todo' WHERE id=${victim.id}`);

    // The scheduler's own writer: creates the episode and stamps overlapBlockedBy + status="queued".
    await store.transitionQueuedEpisode(victim.id, {
      signature: `file-scope:${blocker.id}`,
      blockedBy: null,
      overlapBlockedBy: blocker.id,
      action: `File-scope overlap: queued behind ${blocker.id}`,
    });

    // The predecessor finishes (terminal lane, landed evidence, worktree released).
    await store.updateTask(blocker.id, {
      mergeDetails: { commitSha: "aaaa1111", landedFiles: ["packages/core/src/a.ts"], mergeTargetBranch: "main" },
      worktree: null,
    });
    await h.layer().db.execute(
      sql`UPDATE project.tasks SET "column"=${options.blockerColumn ?? "done"} WHERE id=${blocker.id}`,
    );

    // The executor's overlap gate releases the wait — the log line the exemplar froze right after.
    const episode = (await store.listTaskOverlapWaits(victim.id))[0];
    expect(episode).toBeTruthy();
    const claim = await store.claimTaskOverlapWait({
      taskId: victim.id, episodeId: episode!.episodeId, expectedRevision: episode!.revision, owner: "exec-1",
    } as never);
    expect(claim).toBeTruthy();
    const completed = await store.completeTaskOverlapWait({
      taskId: victim.id,
      episodeId: episode!.episodeId,
      expectedRevision: claim!.revision,
      owner: "exec-1",
      phase: "ready",
      receipt: {
        decision: "resume", freshness: "not-required", commonFiles: [], deliveryProofs: [],
        decisionFingerprint: "fp-rufu-341", decidedAt: new Date().toISOString(),
      },
    } as never);
    expect(completed).toBeTruthy();

    return { blocker, victim };
  }

  /** The frozen exemplar, BEFORE any repair: both admission gates still closed on the victim. */
  async function expectFrozenVictim(taskId: string, blockerId: string) {
    const before = await readVictim(taskId);
    expect(before.overlapBlockedBy).toBe(blockerId);
    expect(before.status).toBe("queued");
    return before;
  }

  async function readVictim(taskId: string) {
    const task = await h.store().getTask(taskId);
    return {
      overlapBlockedBy: task.overlapBlockedBy ?? null,
      blockedBy: task.blockedBy ?? null,
      status: task.status ?? null,
      column: task.column,
      log: task.log ?? [],
    };
  }

  it("controls on the resolved builtin vocabulary: marker and queued status both clear", async () => {
    const { blocker, victim } = await seedReleasedExemplar();

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);

    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    expect(after.status).toBeNull();
    // The clear must be visible on the card: a silent no-op is what kept the freeze invisible.
    expect(after.log.some((entry) => entry.action.includes("Cleared obsolete overlap/dependency indicators"))).toBe(true);
  });

  it("clears when the predecessor's board resolves to NO lifecycle vocabulary (v1 / synthesized traits:[] face)", async () => {
    const workflowId = await seedTraitlessWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId });

    // The scheduler's authority already calls this predecessor terminal; the reconciler must agree.
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);

    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    // Admission, not just marker-freedom: the scheduler's wake gate requires `!task.status`.
    expect(after.status).toBeNull();
    expect(after.log.some((entry) => entry.action.includes("Cleared obsolete overlap/dependency indicators"))).toBe(true);
  });

  it("clears automatically through the self-healing sweep — no operator repair of the frozen row", async () => {
    const workflowId = await seedTraitlessWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId });
    await h.store().updateSettings({ autoMerge: true, globalPause: false, enginePaused: false });

    expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBeGreaterThan(0);

    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    expect(after.status).toBeNull();
    expect(after.column).toBe("todo");
  });

  it("still clears on a RENAMED complete lane — the legacy floor must not replace a resolved answer", async () => {
    const workflowId = await seedRenamedCompleteWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId, blockerColumn: "shipped" });

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);
    expect((await readVictim(victim.id)).overlapBlockedBy).toBeNull();
  });

  it("clears both fields for a RESET predecessor on a board whose vocabulary does not resolve", async () => {
    // The other half of the acceptance contract: a release reason that does NOT depend on the complete lane
    // must still clear the marker AND the queued status on a board that cannot be resolved. Pinned so a
    // future "always fall back to done" shortcut cannot quietly replace the reset/deleted dispositions.
    const workflowId = await seedTraitlessWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId });
    await h.store().resetTaskPublication(blocker.id, "todo");

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);
    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    expect(after.status).toBeNull();
  });

  it("clears when the predecessor rests in a SECOND complete lane — membership, not the first complete column", async () => {
    const workflowId = await seedTwoCompleteLanesWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId, blockerColumn: "shipped-secondary" });
    await expectFrozenVictim(victim.id, blocker.id);

    // The board's own terminal authority already calls this lane terminal; the release decision must agree.
    expect(isCompleteColumnRole({ complete: true }, "shipped-secondary")).toBe(true);

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);

    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    expect(after.status).toBeNull();
  });

  it("clears a SOFT-DELETED predecessor whose board cannot resolve — the non-complete dispositions do not need the lane", async () => {
    const workflowId = await seedTraitlessWorkflow();
    const { blocker, victim } = await seedReleasedExemplar({ blockerWorkflowId: workflowId });
    await h.store().deleteTask(blocker.id);

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).toContain(blocker.id);
    const after = await readVictim(victim.id);
    expect(after.overlapBlockedBy).toBeNull();
    expect(after.status).toBeNull();
  });

  it("fails closed: an unresolved vocabulary must not release a predecessor that is still mid-flight", async () => {
    const workflowId = await seedTraitlessWorkflow();
    // The traitless board keeps the builtin ids, so the predecessor's mid-flight lane is `in-progress`.
    const { blocker, victim } = await seedReleasedExemplar({
      blockerWorkflowId: workflowId,
      blockerColumn: "in-progress",
    });

    const result = await h.store().reconcileTaskOverlapWaits(victim.id);
    expect(result.clearedBlockerIds).not.toContain(blocker.id);
    expect((await readVictim(victim.id)).overlapBlockedBy).toBe(blocker.id);
  });
});
