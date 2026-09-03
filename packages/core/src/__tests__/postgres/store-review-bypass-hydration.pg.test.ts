/**
 * FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179):
 * Read-site parity proof for the bypass CAPABILITY. The invariant this module exists to hold is
 * "the menu offers it" == "the store accepts it"; the menu reads what these four feeds ship
 * (getTask · listTasks({slim}) · listTasksModifiedSince · searchTasks), so all four must report
 * the IDENTICAL ReviewBypassTarget for one seeded fixture — computed by the same
 * `deriveReviewBypassTarget` + `resolveReviewBypassLanes` + `resolveRequiredPreMergeStepIds` the
 * store's `bypassFailedPreMergeReviewStep` applies to itself.
 *
 * Each site wires hydration through different plumbing (per-row async, the synchronous
 * modified-since row map fed from prelude Maps, search-local column maps) — exactly where a lane
 * or cache could drift, and where RUFU-174 records a history of missed derived-field hydration.
 * The slim variant is deliberate: `GET /api/tasks` serves the board with `slim: true` and the
 * context menu renders from that row, so the slim projection may not lose the capability.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { ReviewBypassTarget } from "../../merge/review-bypass-target.js";
import type { TaskStore } from "../../store.js";

const pgTest = pgDescribe;

const EPOCH = "1970-01-01T00:00:00.000Z";

interface SiteValues {
  detail?: ReviewBypassTarget;
  slim?: ReviewBypassTarget;
  modified?: ReviewBypassTarget;
  searched?: ReviewBypassTarget;
}

/** Read every hydrated site that must agree, keyed by `id` (search matches by `query`). */
async function readAllSites(store: TaskStore, id: string, query: string): Promise<SiteValues> {
  const detail = await store.getTask(id);
  const slim = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
  const modified = (await store.listTasksModifiedSince(EPOCH)).tasks.find((entry) => entry.id === id);
  const searched = (await store.searchTasks(query, { slim: true })).find((entry) => entry.id === id);
  return {
    detail: detail.reviewBypass,
    slim: slim?.reviewBypass,
    modified: modified?.reviewBypass,
    searched: searched?.reviewBypass,
  };
}

/** All four sites must agree with the detail read — target verbatim, INCLUDING its absence. */
function expectSitesAgree(sites: SiteValues, expected: ReviewBypassTarget | undefined): void {
  expect(sites.detail, 'site "detail"').toEqual(expected);
  for (const key of ["slim", "modified", "searched"] as const) {
    expect(sites[key], `site "${key}" diverged from getTask`).toEqual(sites.detail);
  }
}

pgTest("TaskStore reviewBypass hydration parity (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_review_bypass",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedTask(
    id: string,
    opts: {
      column: string;
      description: string;
      set?: Record<string, unknown>;
    },
  ) {
    const store = h.store();
    const now = Date.now();
    const updatedAt = new Date(now - 60_000).toISOString();
    await store.createTaskWithReservedId(
      { description: opts.description, column: opts.column },
      { taskId: id, createdAt: updatedAt, updatedAt, applyDefaultWorkflowSteps: false },
    );
    if (opts.set) {
      await h
        .adminDb()
        .update(schema.project.tasks)
        .set({ ...opts.set, updatedAt })
        .where(eq(schema.project.tasks.id, id));
      store.taskCache.delete(id);
    }
  }

  const gateResult = (workflowStepId: string, status: "passed" | "failed", workflowStepName: string) => ({
    workflowStepId,
    workflowStepName,
    status,
    phase: "pre-merge",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    completedAt: new Date(Date.now() - 60_000).toISOString(),
    output: "",
    notes: "",
  });

  it("offers the unrun-gate (absent) target on all four read sites", async () => {
    // builtin:coding pins to exactly one required gate; no result entry exists for it.
    await seedTask("RBY-UNRUN", {
      column: "in-review",
      description: "reviewbypassunrunfixture stranded unrun gate",
      set: { enabledWorkflowSteps: ["plan-review"] },
    });
    const store = h.store();

    const sites = await readAllSites(store, "RBY-UNRUN", "reviewbypassunrunfixture");
    expectSitesAgree(sites, { kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" });
  });

  it("lets the failed result win over the unrun gate on all four read sites", async () => {
    // Default required set {plan-review, code-review}: plan-review never ran, code-review failed.
    // The store rewrites the failed result, so the read path must name the same target.
    await seedTask("RBY-FAILED", {
      column: "in-review",
      description: "reviewbypassfailedfixture failed code review",
      set: { workflowStepResults: [gateResult("code-review", "failed", "Code Review")] },
    });
    const store = h.store();

    const sites = await readAllSites(store, "RBY-FAILED", "reviewbypassfailedfixture");
    expectSitesAgree(sites, { kind: "failed", workflowStepId: "code-review", workflowStepName: "Code Review" });
  });

  it("offers nothing once every required gate has a result entry", async () => {
    await seedTask("RBY-APPROVED", {
      column: "in-review",
      description: "reviewbypassapprovedfixture all gates answered",
      set: {
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [gateResult("plan-review", "passed", "Plan Review")],
      },
    });
    const store = h.store();

    const sites = await readAllSites(store, "RBY-APPROVED", "reviewbypassapprovedfixture");
    expectSitesAgree(sites, undefined);
  });

  it("offers nothing for a paused card even with an unrun gate", async () => {
    await seedTask("RBY-PAUSED", {
      column: "in-review",
      description: "reviewbypasspausedfixture paused unrun gate",
      set: { enabledWorkflowSteps: ["plan-review"], paused: 1 },
    });
    const store = h.store();

    const sites = await readAllSites(store, "RBY-PAUSED", "reviewbypasspausedfixture");
    expectSitesAgree(sites, undefined);
  });

  it("offers nothing outside the review lane even with an unrun gate", async () => {
    await seedTask("RBY-OFFLANE", {
      column: "in-progress",
      description: "reviewbypassofflanefixture mid-work unrun gate",
      set: { enabledWorkflowSteps: ["plan-review"] },
    });
    const store = h.store();

    const sites = await readAllSites(store, "RBY-OFFLANE", "reviewbypassofflanefixture");
    expectSitesAgree(sites, undefined);
  });

  it("keeps the capability on the slim board row while stripping the log", async () => {
    // The board feed is slim; only `log` is stripped from the projection. The capability must
    // survive the strip — the context menu that renders the bypass item reads THIS row.
    await seedTask("RBY-SLIM", {
      column: "in-review",
      description: "reviewbypassslimfixture slim board capability",
      set: { enabledWorkflowSteps: ["plan-review"] },
    });
    const store = h.store();

    const slim = (await store.listTasks({ slim: true })).find((entry) => entry.id === "RBY-SLIM");
    expect(slim?.log).toEqual([]);
    expect(slim?.reviewBypass).toEqual({ kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" });
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179) — THE offer==accept cross-check on one row.
  The defect had two halves: a card the menu hid while `POST /tasks/:id/bypass-review` succeeded
  (stranded unrun gate), and a card the menu offered that the store then refused (paused). Both
  directions are pinned on the SAME seeded row: the hydrated capability and the store's own verdict
  must be the same truth, and a successful bypass must remove the capability everywhere it was
  offered (the audited approval is now a result entry, so re-hydration says "nothing to clear").
  */
  it("store accepts exactly what every read site offers, and the offer dies with the approval", async () => {
    await seedTask("RBY-XACCEPT", {
      column: "in-review",
      description: "reviewbypassxacceptfixture cross-check accepted",
      set: { enabledWorkflowSteps: ["plan-review"] },
    });
    const store = h.store();

    expectSitesAgree(await readAllSites(store, "RBY-XACCEPT", "reviewbypassxacceptfixture"), {
      kind: "absent",
      workflowStepId: "plan-review",
      workflowStepName: "plan-review",
    });

    const updated = await store.bypassFailedPreMergeReviewStep("RBY-XACCEPT", {
      reason: "operator cleared the unrun gate",
      actor: "operator",
    });
    const entry = (updated.workflowStepResults ?? []).find((r) => r.workflowStepId === "plan-review");
    expect(entry).toMatchObject({ status: "skipped", bypassedBy: "operator", bypassedFromStatus: "absent" });
    expect(entry?.bypassedAt).toBeTruthy();
    expect(entry?.bypassReason).toBe("operator cleared the unrun gate");

    /* The audited approval IS a result entry: every site must now offer nothing, or the menu would
    re-present a gate that is already honestly cleared (and the store would refuse the second click). */
    expectSitesAgree(await readAllSites(store, "RBY-XACCEPT", "reviewbypassxacceptfixture"), undefined);
  });

  it("store refuses exactly what every read site hides (paused)", async () => {
    await seedTask("RBY-XREFUSE", {
      column: "in-review",
      description: "reviewbypassxrefusefixture cross-check refused",
      set: { enabledWorkflowSteps: ["plan-review"], paused: 1 },
    });
    const store = h.store();

    expectSitesAgree(await readAllSites(store, "RBY-XREFUSE", "reviewbypassxrefusefixture"), undefined);
    await expect(
      store.bypassFailedPreMergeReviewStep("RBY-XREFUSE", { reason: "attempt", actor: "operator" }),
    ).rejects.toThrow(/task is paused/);
  });
});
