/*
FNXC:OverlapWaitRelease 2026-11-04-10:40 (RUFU-469 — the released face must be an invariant, not the repro):

`overlapPredecessorRelease` decides whether a file-scope wait is still owed anything, and its ONE live face for
a non-terminal predecessor used to be `completeColumns.has(blocker.column)`. That single lane test froze 46
cards behind a holder whose work had landed on `main` and whose checkout was already gone — it stayed parked in
a review lane because a required pre-merge gate carried zero result rows, and the waiters only drained 11.14
days later when its COLUMN changed. `overlap-wait-release-delivered.pg.test.ts` pins that reproduction; this
file pins the invariant behind it, because a face proven only on its reported reproduction is how this class
came back three times before (RUFU-341's unresolved vocabulary, RUFU-330's retained claim, RUFU-373's wrapped
acquisition failure).

Enumerated surfaces, each driven through a PRODUCTION entry point — the scheduler's own queued-episode writer,
the store's reconciliation seam, and the self-healing sweep — never a private helper:

  * releases wherever the holder rests once its work has delivered and its checkout is gone (review lane AND
    hold lane), through the store seam AND the automatic sweep;
  * refuses while a checkout survives in EITHER form — singular `worktree` or a `workspaceWorktrees` entry,
    whose singular field is cleared by design for workspace cards;
  * refuses while the holder stands in a WIP lane, even with delivery and no checkout, because
    `acquireTaskCheckout` moves a card into WIP before its checkout row materializes;
  * refuses with no concrete delivery at all (the lane alone is not a release);
  * re-sticks: a holder that regains its checkout holds any NEW marker, so the release is not sticky;
  * follows the board's DECLARED lanes, never a literal — a renamed WIP lane still refuses, a renamed non-WIP
    lane still releases, several WIP lanes are all honoured, and a board with no lifecycle vocabulary keeps the
    legacy floor;
  * leaves the `reset` declared-dependency carve-out unwidened, keeps `dependencies` intact, and retains the
    delivery itself for the Git freshness gate.
*/

import { sql } from "drizzle-orm";
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";
import { reconcileReleasedOverlapWaits } from "../../../../engine/src/self-healing/released-overlap-waits.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_ow_delivered_faces",
  projectId: "project-ow-delivered-faces",
});

beforeAll(h.beforeAll);
beforeEach(h.beforeEach);
afterEach(h.afterEach);
afterAll(h.afterAll);

type MutableIr = {
  id: string;
  nodes: { id: string; column?: string }[];
  columns?: { id: string; name?: string; traits?: unknown[] }[];
};

function cloneBuiltinIr(id: string): MutableIr {
  const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as MutableIr;
  ir.id = id;
  return ir;
}

async function seedWorkflow(mutate: (ir: MutableIr) => void, name: string): Promise<string> {
  const ir = cloneBuiltinIr(`custom:${name}`);
  mutate(ir);
  const created = await h.store().createWorkflowDefinition({ name, kind: "workflow", ir: ir as never } as never);
  return (created as { id: string }).id;
}

pgDescribe("the delivered release face as a general invariant (RUFU-469)", () => {
  /**
   * One holder plus one waiter, parked by the scheduler's own writer, with the holder's delivery, checkout and
   * lane chosen by the case. Returns the ids so each case reads the victim back through the store.
   */
  async function seed(options: {
    holderColumn?: string;
    holderWorkflowId?: string;
    delivery?: "concrete" | "none";
    worktree?: string | null;
    workspaceWorktrees?: Record<string, { worktreePath: string }> | null;
    declaredDependency?: boolean;
  } = {}) {
    const store = h.store();
    const holder = await store.createTask({ description: "predecessor owning the scope" });
    const waiter = await store.createTask({ description: "dependent parked behind the lease" });
    if (options.holderWorkflowId) await store.writeTaskWorkflowSelection(holder.id, options.holderWorkflowId, []);
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='todo' WHERE id=${waiter.id}`);

    // The scheduler's writer: one write that stamps BOTH admission gates (marker + status="queued").
    await store.transitionQueuedEpisode(waiter.id, {
      signature: `file-scope:${holder.id}`,
      blockedBy: null,
      overlapBlockedBy: holder.id,
      action: `File-scope overlap: waiting for lease held by ${holder.id}`,
    });
    if (options.declaredDependency) {
      await store.updateTask(waiter.id, { dependencies: [holder.id], blockedBy: holder.id });
    }

    const delivery = options.delivery ?? "concrete";
    await store.updateTask(holder.id, {
      mergedAt: "2026-10-01T10:32:06.893Z",
      mergeDetails: delivery === "none" ? null : {
        mergeConfirmed: true,
        commitSha: "a1b2c3d4e5f60718",
        landedFiles: ["packages/core/src/tasks/overlap-wait-release.ts"],
        mergeTargetBranch: "main",
      },
      worktree: options.worktree === undefined ? null : options.worktree,
      ...(options.workspaceWorktrees === undefined ? {} : { workspaceWorktrees: options.workspaceWorktrees }),
    } as never);
    if (options.holderColumn) {
      await h.layer().db.execute(sql`UPDATE project.tasks SET "column"=${options.holderColumn} WHERE id=${holder.id}`);
    }
    await store.updateSettings({ autoMerge: true, globalPause: false, enginePaused: false });
    return { holder, waiter };
  }

  async function readVictim(taskId: string) {
    const task = await h.store().getTask(taskId);
    return {
      overlapBlockedBy: task.overlapBlockedBy ?? null,
      blockedBy: task.blockedBy ?? null,
      status: task.status ?? null,
      dependencies: task.dependencies ?? [],
      column: task.column,
    };
  }

  const RELEASED = { overlapBlockedBy: null, status: null };
  const HELD = (holderId: string) => ({ overlapBlockedBy: holderId, status: "queued" });

  it.each(["in-review", "todo", "triage"])("releases through the store seam wherever a delivered holder rests (%s lane)", async (holderColumn) => {
    const { holder, waiter } = await seed({ holderColumn });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));

    expect((await h.store().reconcileTaskOverlapWaits(waiter.id)).clearedBlockerIds).toContain(holder.id);
    expect(await readVictim(waiter.id)).toMatchObject({ ...RELEASED, column: "todo" });
  });

  it("releases automatically through the self-healing sweep — no operator repair per card", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-review" });

    expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBeGreaterThan(0);
    expect(await readVictim(waiter.id)).toMatchObject({ ...RELEASED, column: "todo" });
  });

  it.each([
    { label: "singular worktree", options: { worktree: "/checkouts/rufu-286" } },
    { label: "workspace entry", options: { workspaceWorktrees: { "packages/engine": { worktreePath: "/checkouts/rufu-286/packages/engine" } } } },
  ])("fails closed while the delivered holder retains a checkout in the $label form", async ({ options }) => {
    // A workspace card's singular `worktree` is cleared by design, so the workspace branch is the only proof.
    const { holder, waiter } = await seed({ holderColumn: "in-review", ...options });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("fails closed in a WIP lane even with a delivery and no checkout", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-progress" });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("fails closed in every WIP lane a board declares, not just the first", async () => {
    // A second wip-trait lane must refuse too: a membership answer is what RUFU-341's code review forced on
    // the complete face, and the delivered face refuses on the same membership.
    const workflowId = await seedWorkflow((ir) => {
      ir.columns!.push({
        id: "building-secondary",
        name: "Building secondary",
        traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }],
      });
    }, "Two WIP lanes (delivered release)");
    const { holder, waiter } = await seed({ holderColumn: "building-secondary", holderWorkflowId: workflowId });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("fails closed with no concrete delivery — the lane alone is not a release", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-review", delivery: "none" });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("releases on a landed-paths delivery with no sha — the snapshot authority's own concreteness", async () => {
    // The face reuses `hasConcreteOverlapDelivery` rather than inventing a second landedness reading, so
    // landed files without a commit sha release exactly as a sha does. Requiring a sha here would be a
    // stricter test than the authority this face is built on.
    const { holder, waiter } = await seed({ holderColumn: "in-review" });
    await h.layer().db.execute(
      sql`UPDATE project.tasks SET merge_details=${JSON.stringify({
        mergeConfirmed: true, landedFiles: ["packages/core/src/tasks/overlap-wait-release.ts"], mergeTargetBranch: "main",
      })}::jsonb WHERE id=${holder.id}`,
    );

    expect((await h.store().reconcileTaskOverlapWaits(waiter.id)).clearedBlockerIds).toContain(holder.id);
    expect(await readVictim(waiter.id)).toMatchObject(RELEASED);
  });

  it("re-sticks: a holder that regains its checkout holds a NEW marker", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-review" });
    expect((await h.store().reconcileTaskOverlapWaits(waiter.id)).clearedBlockerIds).toContain(holder.id);

    // The delivery stays, the lane stays; only the checkout comes back. The next lease must hold again.
    await h.store().updateTask(holder.id, { worktree: "/checkouts/rufu-286" } as never);
    await h.store().transitionQueuedEpisode(waiter.id, {
      signature: `file-scope:${holder.id}:rearmed`,
      blockedBy: null,
      overlapBlockedBy: holder.id,
      action: `File-scope overlap: waiting for lease held by ${holder.id}`,
    });

    expect(await h.store().reconcileTaskOverlapWaits(waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(waiter.id)).toMatchObject(HELD(holder.id));
  });

  it("follows the board's declared lanes — a renamed WIP lane still refuses", async () => {
    const rename: Record<string, string> = { triage: "intake", todo: "backlog", "in-progress": "building", "in-review": "checking", done: "shipped" };
    const workflowId = await seedWorkflow((ir) => {
      for (const node of ir.nodes ?? []) if (node.column) node.column = rename[node.column] ?? node.column;
      for (const column of ir.columns ?? []) column.id = rename[column.id] ?? column.id;
      expect((ir.columns ?? []).map((column) => column.id)).not.toContain("in-progress");
    }, "Renamed lanes (delivered release)");

    const refused = await seed({ holderColumn: "building", holderWorkflowId: workflowId });
    expect(await h.store().reconcileTaskOverlapWaits(refused.waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(refused.waiter.id)).toMatchObject(HELD(refused.holder.id));
  });

  it("follows the board's declared lanes — a renamed non-WIP lane still releases", async () => {
    const rename: Record<string, string> = { triage: "intake", todo: "backlog", "in-progress": "building", "in-review": "checking", done: "shipped" };
    const workflowId = await seedWorkflow((ir) => {
      for (const node of ir.nodes ?? []) if (node.column) node.column = rename[node.column] ?? node.column;
      for (const column of ir.columns ?? []) column.id = rename[column.id] ?? column.id;
    }, "Renamed lanes releasing (delivered release)");

    const released = await seed({ holderColumn: "checking", holderWorkflowId: workflowId });
    expect((await h.store().reconcileTaskOverlapWaits(released.waiter.id)).clearedBlockerIds).toContain(released.holder.id);
    expect(await readVictim(released.waiter.id)).toMatchObject(RELEASED);
  });

  it("keeps the legacy WIP floor when the board declares no lifecycle vocabulary at all", async () => {
    // traits: [] is what a v1 graph upgraded to v2 synthesizes. The floor must refuse, not guess a release.
    const workflowId = await seedWorkflow((ir) => {
      for (const column of ir.columns ?? []) column.traits = [];
    }, "Traitless vocabulary (delivered release)");

    const wipHolder = await seed({ holderColumn: "in-progress", holderWorkflowId: workflowId });
    expect(await h.store().reconcileTaskOverlapWaits(wipHolder.waiter.id)).toMatchObject({ clearedBlockerIds: [] });
    expect(await readVictim(wipHolder.waiter.id)).toMatchObject(HELD(wipHolder.holder.id));

    const reviewHolder = await seed({ holderColumn: "in-review", holderWorkflowId: workflowId });
    expect((await h.store().reconcileTaskOverlapWaits(reviewHolder.waiter.id)).clearedBlockerIds).toContain(reviewHolder.holder.id);
    expect(await readVictim(reviewHolder.waiter.id)).toMatchObject(RELEASED);
  });

  it("keeps the reset declared-dependency carve-out unwidened and leaves dependencies intact", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-review", declaredDependency: true });
    // Declaring a dependency is a planning act, so the card already sits `needs-replan` rather than the
    // scheduler's `queued` stamp by the time this pass runs.
    expect(await readVictim(waiter.id)).toMatchObject({ overlapBlockedBy: holder.id, blockedBy: holder.id, status: "needs-replan" });

    expect((await h.store().reconcileTaskOverlapWaits(waiter.id)).clearedBlockerIds).toContain(holder.id);
    // The file-scope lease is spent, so BOTH scheduling indicators drain — the reset carve-out does not widen
    // to a delivered predecessor. But the operator's declared dependency is intent, never a lease, and the
    // status this pass does not own (only `status === "queued"` is its write) stays exactly where it was.
    expect(await readVictim(waiter.id)).toMatchObject({
      overlapBlockedBy: null, blockedBy: null, status: "needs-replan", dependencies: [holder.id],
    });
  });

  it("retains the delivery itself for the Git freshness gate", async () => {
    const { holder, waiter } = await seed({ holderColumn: "in-review" });

    expect((await h.store().reconcileTaskOverlapWaits(waiter.id)).clearedBlockerIds).toContain(holder.id);
    const [episode] = await h.store().listTaskOverlapWaits(waiter.id);
    expect(episode?.observation?.deliveries?.[0]).toMatchObject({ landedSha: "a1b2c3d4e5f60718" });
    expect(episode?.phase).not.toBe("cancelled");
  });
});
