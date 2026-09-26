/**
 * FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
 * Read-site parity proof for the canonical stall/hold reason. The interface contract names this
 * the thing review checks: getTask · listTasks({slim}) · listTasksModifiedSince · searchTasks must
 * report the IDENTICAL code+reason for one seeded fixture. Each site wires the derivation through
 * different plumbing (per-row async, pre-computed Maps feeding the synchronous modified-since row
 * map, search-local column maps), which is exactly where a lane or resolver could drift — the
 * modified-since site has a recorded history of missing derived-field hydration.
 *
 * Also pinned: the freshness suppression is the stalledReview review-lane rule (a fresh agent log
 * on a NON-review dependency-blocked card does NOT suppress — the agent working does not unblock
 * the dependency), and terminal/clean cards never carry noise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { HELD_HUMAN_REVIEW_STALL_REASON, PLAN_ADMISSION_THROTTLED_STALL_REASON, type TaskStallReason } from "../../tasks/task-stall-reason.js";
import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER } from "../../merge/task-merge.js";
import type { TaskStore } from "../../store.js";

const pgTest = pgDescribe;

const EPOCH = "1970-01-01T00:00:00.000Z";

interface SiteValues {
  detail?: TaskStallReason;
  slim?: TaskStallReason;
  modified?: TaskStallReason;
  searched?: TaskStallReason;
}

/** Read every hydrated site that must agree, keyed by `id` (search matches by `query`). */
async function readAllSites(store: TaskStore, id: string, query: string): Promise<SiteValues> {
  const detail = await store.getTask(id);
  const slim = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
  const modified = (await store.listTasksModifiedSince(EPOCH)).tasks.find((entry) => entry.id === id);
  const searched = (await store.searchTasks(query, { slim: true })).find((entry) => entry.id === id);
  return {
    detail: detail.stallReason,
    slim: slim?.stallReason,
    modified: modified?.stallReason,
    searched: searched?.stallReason,
  };
}

/** All four sites must agree with the detail read, code+reason verbatim. */
function expectSitesAgree(sites: SiteValues): void {
  const anchor = { code: sites.detail?.code, reason: sites.detail?.reason };
  for (const key of ["slim", "modified", "searched"] as const) {
    expect(
      { code: sites[key]?.code, reason: sites[key]?.reason },
      `site "${key}" diverged from getTask`,
    ).toEqual(anchor);
  }
}

pgTest("TaskStore stallReason hydration parity (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stall_reason",
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
    const updatedAt = new Date(now - 6 * 60_000).toISOString();
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

  const failedCodeReview = () => [{
    workflowStepId: "code-review",
    status: "failed",
    phase: "pre-merge",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
    output: "",
    notes: "",
  }];

  it("reports the identical merge-blocker on all four read sites for a failed pre-merge step", async () => {
    await seedTask("STLR-MERGE", {
      column: "in-review",
      description: "stallreasonmergefixture failed review card",
      set: { workflowStepResults: failedCodeReview() },
    });
    const store = h.store();

    const sites = await readAllSites(store, "STLR-MERGE", "stallreasonmergefixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("merge-blocker");
    expect(sites.detail?.reason).toBe("task has failed pre-merge workflow steps");
    expect(sites.detail?.observedAt).toBeTruthy();
  });

  /*
  FNXC:TaskStallReason 2026-09-22-23:36 (RUFU-276, Step 5):
  Board-list proof for the failed-park not-run wedge: a card terminalized by the pre-RUFU-276 retry
  seam (`status:'failed'` + `AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: <canonical sentence>`) must
  surface the NAMED `pre-merge-gate-pending` code with the canonical gate sentence — not the generic
  `merge-blocker` and never the composed park prose — identically on all four hydrated read sites.
  The derivation is pure on the blocker string, so the fixture needs no workflow IR: the blocking-status
  arm composes the persisted error before any gate evaluation runs.
  */
  it("names the failed not-run retry-rejection park on all four read sites", async () => {
    await seedTask("STLR-NOTRUN", {
      column: "in-review",
      description: "stallreasonnotrunfixture wedged approved card",
      set: {
        status: "failed",
        error: `AUTO_MERGE_RETRY_REJECTED: Cannot merge STLR-NOTRUN: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`,
      },
    });
    const store = h.store();

    const sites = await readAllSites(store, "STLR-NOTRUN", "stallreasonnotrunfixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("pre-merge-gate-pending");
    expect(sites.detail?.reason).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    // The slim board row — the actual board-list assertion — carries the named code too.
    expect(sites.slim?.code).toBe("pre-merge-gate-pending");
  });

  it("reports the identical dependency-blocker on all four read sites for an unmet dependency", async () => {
    await seedTask("STLR-DEP", { column: "todo", description: "dependency provider" });
    await seedTask("STLR-BLOCKED", {
      column: "todo",
      description: "stallreasondepfixture blocked card",
      set: { dependencies: ["STLR-DEP"] },
    });
    const store = h.store();

    const sites = await readAllSites(store, "STLR-BLOCKED", "stallreasondepfixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("dependency-blocker");
    expect(sites.detail?.reason).toBe("task has unresolved dependencies: STLR-DEP");
  });

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  Read-site parity for the planning lane, the same contract this file exists to pin. The planning arm
  reaches the derivation through context that the review arms never needed — `planningColumns` resolved
  from the workflow IR — so the four sites are exactly where that resolution could drift: the slim board
  row and the modified-since prelude build their context once for the whole page, `getTask` per row, and
  search builds its own column maps. `builtin:coding` resolves its planning lane as `triage` (intake)
  ∪ `hold` (hold), so these `todo`-column cards must receive the code from every site.
  */
  it("reports the identical planning-admission throttle code on all four read sites", async () => {
    await seedTask("STLR-PLANHOLD", {
      column: "todo",
      description: "stallreasonplanfixture aged planning card",
      set: {
        status: null,
        sourceMetadata: {
          planAdmissionStall: {
            code: "plan-admission-throttled",
            lastAt: new Date(Date.now() - 60_000).toISOString(),
            firstAt: new Date(Date.now() - 86_400_000).toISOString(),
            stallCount: 4,
            signature: "running-agent cap|3|0|0",
          },
        },
      },
    });
    const store = h.store();

    const sites = await readAllSites(store, "STLR-PLANHOLD", "stallreasonplanfixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("plan-admission-throttled");
    // The slim board row is the reported failure surface: the chip's absence there was the bug.
    expect(sites.slim?.code).toBe("plan-admission-throttled");
    expect(sites.detail?.reason).toBe(PLAN_ADMISSION_THROTTLED_STALL_REASON);
  });

  it("reports the recovery backoff on all four sites for a planning card parked on a future retry", async () => {
    await seedTask("STLR-PLANBACKOFF", {
      column: "todo",
      description: "stallreasonbackofffixture backed-off planning card",
      set: {
        status: null,
        nextRecoveryAt: new Date(Date.now() + 900_000).toISOString(),
      },
    });
    const store = h.store();

    const sites = await readAllSites(store, "STLR-PLANBACKOFF", "stallreasonbackofffixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("plan-recovery-backoff");
  });

  it("names nothing on any site for a fresh planning card, a paused one, or one mid-planning", async () => {
    await seedTask("STLR-PLANFRESH", { column: "todo", description: "stallreasonplanfreshfixture untouched card", set: { status: null } });
    await seedTask("STLR-PLANPAUSED", {
      column: "todo",
      description: "stallreasonplanpausedfixture paused card",
      set: { status: null, paused: 1 },
    });
    await seedTask("STLR-PLANLIVE", {
      column: "todo",
      description: "stallreasonplanlivefixture planning now",
      set: { status: "planning" },
    });
    const store = h.store();

    for (const [id, query] of [
      ["STLR-PLANFRESH", "stallreasonplanfreshfixture"],
      ["STLR-PLANPAUSED", "stallreasonplanpausedfixture"],
      ["STLR-PLANLIVE", "stallreasonplanlivefixture"],
    ] as const) {
      const sites = await readAllSites(store, id, query);
      expect(sites, `${id} must speak for none of these states`).toEqual({
        detail: undefined,
        slim: undefined,
        modified: undefined,
        searched: undefined,
      });
    }
  });

  it("reports held-human-review on all four sites while the board withholds auto-merge processing", async () => {
    /*
    FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
    The contract's sharpest edge: project `autoMerge: false` suppresses the review-lane merge-stall
    badges (the terminal-until-human contract), yet the held-for-human reason must STILL surface —
    this is the operator's "why does nothing move" answer on a manual-merge board. The withhold is a
    BOARD gate (`allowsAutoMergeProcessing`), not a per-task column: a per-task autoMerge false under
    a board that is ON does not hold this gate.
    */
    const store = h.store();
    await store.updateSettings({ autoMerge: false });
    await seedTask("STLR-HELD", {
      column: "in-review",
      description: "stallreasonheldfixture manual merge card",
    });

    const sites = await readAllSites(store, "STLR-HELD", "stallreasonheldfixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("held-human-review");
    expect(sites.detail?.reason).toBe(HELD_HUMAN_REVIEW_STALL_REASON);

    const slim = (await store.listTasks({ slim: true })).find((entry) => entry.id === "STLR-HELD");
    expect(slim?.inReviewStall).toBeUndefined();
    expect(slim?.stallReason).toBeDefined();
  });

  it("suppresses the reason on every site while merge-queued or a fresh agent log streams on a review card", async () => {
    await seedTask("STLR-QUEUED", {
      column: "in-review",
      description: "stallreasonqueuedfixture queued merge card",
      set: { workflowStepResults: failedCodeReview() },
    });
    await h.store().enqueueMergeQueue("STLR-QUEUED");
    const sitesQueued = await readAllSites(h.store(), "STLR-QUEUED", "stallreasonqueuedfixture");
    expect(sitesQueued).toEqual({ detail: undefined, slim: undefined, modified: undefined, searched: undefined });

    await seedTask("STLR-LIVE", {
      column: "in-review",
      description: "stallreasonlivefixture streaming reviewer card",
      set: { workflowStepResults: failedCodeReview() },
    });
    await h.store().appendAgentLog("STLR-LIVE", "rerunning review verification", "thinking", undefined, "reviewer");
    const sitesLive = await readAllSites(h.store(), "STLR-LIVE", "stallreasonlivefixture");
    expect(sitesLive).toEqual({ detail: undefined, slim: undefined, modified: undefined, searched: undefined });
  });

  it("does NOT suppress a non-review dependency blocker under fresh activity (freshness is the review-lane rule)", async () => {
    /*
    The freshness helper is lane-gated (returns false off review columns) exactly like the
    stalledReview rule it mirrors: an agent streaming on a todo card does not unblock its
    dependency, so the server keeps answering "why is it standing still". The dashboard hook's
    lane-agnostic clear stays a bounded until-next-refetch heuristic, not a server rule.
    */
    await seedTask("STLR-DEP2", { column: "todo", description: "dependency provider two" });
    await seedTask("STLR-BLOCKED2", {
      column: "todo",
      description: "stallreasonliveblockedfixture working but blocked",
      set: { dependencies: ["STLR-DEP2"] },
    });
    const store = h.store();
    await store.appendAgentLog("STLR-BLOCKED2", "still trying", "thinking", undefined, "executor");

    const sites = await readAllSites(store, "STLR-BLOCKED2", "stallreasonliveblockedfixture");
    expectSitesAgree(sites);
    expect(sites.detail?.code).toBe("dependency-blocker");
  });

  it("carries no reason on clean, moving, or terminal cards across all sites", async () => {
    await seedTask("STLR-CLEAN", { column: "todo", description: "stallreasoncleanfixture plain card" });
    await seedTask("STLR-DONE", {
      column: "done",
      description: "stallreasondonefixture finished card",
      set: { dependencies: ["STLR-CLEAN"], workflowStepResults: failedCodeReview() },
    });
    const store = h.store();

    const clean = await readAllSites(store, "STLR-CLEAN", "stallreasoncleanfixture");
    expect(clean).toEqual({ detail: undefined, slim: undefined, modified: undefined, searched: undefined });

    /* Terminal wins before the review/dependency branches: failed results on a done card are history. */
    const done = await readAllSites(store, "STLR-DONE", "stallreasondonefixture");
    expect(done.detail).toBeUndefined();
    expect(done.slim).toBeUndefined();
    expect(done.modified).toBeUndefined();
  });
});
