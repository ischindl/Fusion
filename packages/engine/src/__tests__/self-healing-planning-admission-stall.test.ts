/**
 * RUFU-273 Step 3: the planning-admission stall sweep.
 *
 * Two layers are pinned here, and both matter for different reasons.
 *
 * The LADDER (`decidePlanningAdmissionStall`) is the operator-visible contract: which reason a silent
 * aged card gets, and when the sweep must keep its hands off a reason another lane already named.
 *
 * The SWEEP (`reconcilePlanningAdmissionStalls`) is the safety contract: a pass must never touch a
 * lifecycle field, must never erase a sibling provenance key, must bound its git work, and must leave a
 * run-audit row for every card it examined — including the ones it decided to leave alone, because an
 * unexplained silence plus an unexplained sweep is the exact state this task exists to end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PLAN_ADMISSION_STALL_METADATA_KEY,
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  deriveTaskStallReason,
  type RunAuditEventInput,
  type Task,
  type TaskPlanAdmissionStallEpisode,
  type TaskStallReasonContext,
  type WorkflowIr,
} from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import {
  PLANNING_ADMISSION_STALL_DEFAULT_MS,
  PLANNING_ADMISSION_STALL_MAX_BRANCH_PROBES,
  PLANNING_ADMISSION_STALL_MAX_CANDIDATES,
  PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS,
  decidePlanningAdmissionStall,
  isPlanningLaneIneligible,
  planningAdmissionAgeMs,
  probeTaskSpecReadable,
  resolvePlanningLanes,
  resolvePlanningStallThresholdMs,
  type PlanningAdmissionEvidence,
} from "../planning-admission-stall.js";

// Only silence the scheduler's output; `createLogger` is used by transitively imported modules
// (worktrunk-installer et al.), so the mock has to keep the rest of the module intact.
vi.mock(import("../logger.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  schedulerLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HOUR = 60 * 60_000;
const MIN = 60_000;
/** Wall-clock anchor for the fixture timestamps. The sweep reads `Date.now()` itself. */
const NOW = Date.now();
const AGED_ISO = new Date(NOW - 60 * HOUR).toISOString();
const FRESH_ISO = new Date(NOW - 1 * HOUR).toISOString();

/* -------------------------------------------------------------------------- */
/* IR fixtures — trait-driven membership, never a vocabulary match            */
/* -------------------------------------------------------------------------- */

function planningIr(overrides: {
  intakeConfig?: Record<string, unknown>;
  planningColumn?: string | null;
  planningColumns?: string[];
  columns?: Array<Record<string, unknown>>;
  thresholdMs?: number;
} = {}): WorkflowIr {
  const intakeColumn = {
    id: "backlog",
    name: "Backlog",
    traits: [{ trait: "intake", ...(overrides.intakeConfig ? { config: overrides.intakeConfig } : {}) }],
    ...(overrides.thresholdMs ? { recovery: { stalenessMs: overrides.thresholdMs } } : {}),
  };
  const columns = overrides.columns ?? [
    intakeColumn,
    { id: "wip", name: "WIP", traits: [{ trait: "in-progress" }] },
    { id: "hold-lane", name: "Hold", traits: [{ trait: "hold" }] },
    { id: "done", name: "Done", traits: [{ trait: "done" }] },
  ];
  const planningAt = overrides.planningColumn === null
    ? []
    : overrides.planningColumns ?? [overrides.planningColumn ?? "backlog"];
  const nodes = [
    ...planningAt.map((column) => ({ id: "plan", type: "prompt", column })),
    { id: "execute", type: "prompt", column: "wip" },
  ];
  return { version: "v2", columns, nodes, edges: [] } as unknown as WorkflowIr;
}

/** A v1 IR: no column model at all, so the workflow cannot answer a placement question. */
const V1_IR = { nodes: [{ id: "plan", type: "prompt" }], edges: [] } as unknown as WorkflowIr;

/* -------------------------------------------------------------------------- */
/* Task fixtures                                                              */
/* -------------------------------------------------------------------------- */

let seq = 0;
function agedTask(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `RUFU273-${seq}`,
    title: "aged planning card",
    column: "backlog",
    status: "",
    createdAt: AGED_ISO,
    updatedAt: AGED_ISO,
    ...over,
  } as Task;
}

function episodeOf(over: Partial<TaskPlanAdmissionStallEpisode> = {}): TaskPlanAdmissionStallEpisode {
  return {
    code: "plan-admission-throttled",
    lastAt: FRESH_ISO,
    firstAt: FRESH_ISO,
    stallCount: 2,
    ...over,
  } as TaskPlanAdmissionStallEpisode;
}

function evidenceOf(over: Partial<PlanningAdmissionEvidence> = {}): PlanningAdmissionEvidence {
  return {
    ageMs: 60 * HOUR,
    premiseEpisodePresent: false,
    recoveryBackoffActive: false,
    specUnreadable: false,
    laneIneligible: false,
    branch: { branchClaimed: false, worktreeUsable: true, uniqueCommitCount: undefined },
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Sweep harness                                                             */
/* -------------------------------------------------------------------------- */

interface Harness {
  manager: SelfHealingManager;
  updates: Array<{ taskId: string; patch: Record<string, unknown> }>;
  audit: RunAuditEventInput[];
}

function harness(
  tasks: Task[],
  ir: WorkflowIr | undefined | "missing-definition",
  rootDir: string = PROJECT_REPO,
): Harness {
  const updates: Harness["updates"] = [];
  const audit: RunAuditEventInput[] = [];
  const store = {
    tasksDir: join(rootDir, ".fusion", "tasks"),
    getSettings: async () => ({
      projectSlug: "rufu273",
      integrationBranch: "main",
      globalPause: false,
      enginePaused: false,
    }),
    listTasks: async () => tasks,
    updateTask: async (taskId: string, patch: Record<string, unknown>) => {
      updates.push({ taskId, patch });
    },
    recordRunAuditEvent: async (event: RunAuditEventInput) => {
      audit.push(event);
    },
    getTaskWorkflowSelection: () => ({ workflowId: "wf-test" }),
    getWorkflowDefinition: async (id: string) =>
      id === "wf-test" && ir !== "missing-definition" ? { ir } : undefined,
    /*
    The candidate bound of the sweep is the PROJECT vocabulary (`resolveProjectColumnsForRoles`), so the
    fixture has to answer the definitions-list read the helper makes, or the whole board reads as an
    untraited project whose only planning lanes are the legacy `todo`/`triage` ids and no fixture column is
    nameable. An unreadable definition list is modeled as an EMPTY list — the same legacy-floor answer.
    */
    listWorkflowDefinitions: async () => (ir === "missing-definition" ? [] : [{ ir }]),
  };
  const manager = new SelfHealingManager(store as unknown as never, {
    rootDir,
    enableWorktreeMaintenance: false,
  });
  return { manager, updates, audit };
}

/*
The sweep's two I/O legs are `PROMPT.md` under `<rootDir>/.fusion/tasks/<id>/` and bounded git probes
against `<rootDir>`. Neither may run against the real checkout: the repo's `.fusion` tree is protected by
the suite's own fs guard (correctly — a stray recursive delete there is a data-loss event), and probing
the real repo would make the test depend on this branch's divergence from `main`. So the fixture is a
throwaway repo: `main` with one commit, and a `feature` branch one commit ahead of it.
*/
let PROJECT_REPO = "";
const specDir = (taskId: string) => join(PROJECT_REPO, ".fusion", "tasks", taskId);
function writeSpec(taskId: string, content = "# spec"): void {
  mkdirSync(specDir(taskId), { recursive: true });
  writeFileSync(join(specDir(taskId), "PROMPT.md"), content, "utf8");
}
function makeSpecUnreadable(taskId: string): void {
  // A DIRECTORY named PROMPT.md: `readFile` fails with EISDIR — a real non-ENOENT refusal, no chmod games
  // (a root-owned 000 file would still read for the owner, and a test must not depend on the uid).
  mkdirSync(join(specDir(taskId), "PROMPT.md"), { recursive: true });
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: PROJECT_REPO, encoding: "utf8" }).trim();
}

beforeAll(() => {
  PROJECT_REPO = mkdtempSync(join(tmpdir(), "rufu273-sweep-"));
  git(["init", "-b", "main", "."]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "RUFU-273 fixture"]);
  writeFileSync(join(PROJECT_REPO, "seed.txt"), "seed\n", "utf8");
  git(["add", "seed.txt"]);
  git(["commit", "-m", "seed on main"]);
  git(["checkout", "-b", "feature"]);
  writeFileSync(join(PROJECT_REPO, "work.txt"), "unmerged work\n", "utf8");
  git(["add", "work.txt"]);
  git(["commit", "-m", "work only on feature"]);
});

afterAll(() => {
  if (PROJECT_REPO) rmSync(PROJECT_REPO, { recursive: true, force: true });
});

function episodeWritten(h: Harness, taskId: string): TaskPlanAdmissionStallEpisode | undefined {
  const update = h.updates.find((entry) => entry.taskId === taskId);
  const patch = update?.patch as { sourceMetadataPatch?: Record<string, TaskPlanAdmissionStallEpisode> } | undefined;
  return patch?.sourceMetadataPatch?.[PLAN_ADMISSION_STALL_METADATA_KEY];
}

function auditFor(h: Harness, taskId: string): RunAuditEventInput | undefined {
  return h.audit.find((event) => event.taskId === taskId);
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                 */
/* -------------------------------------------------------------------------- */

describe("decidePlanningAdmissionStall — precedence is the contract", () => {
  it("never overwrites RUFU-246's premise episode, whatever else the evidence says", () => {
    const decision = decidePlanningAdmissionStall(evidenceOf({
      premiseEpisodePresent: true,
      specUnreadable: true,
      laneIneligible: true,
      branch: { branchClaimed: true, worktreeUsable: false, uniqueCommitCount: 9 },
    }));
    expect(decision).toEqual({ outcome: "skip", reason: "premise-held" });
  });

  it("leaves a card in live recovery backoff to the recovery lane", () => {
    expect(decidePlanningAdmissionStall(evidenceOf({ recoveryBackoffActive: true, specUnreadable: true })))
      .toEqual({ outcome: "skip", reason: "recovery-backoff" });
  });

  it("names an unreadable spec before lane or residual", () => {
    expect(decidePlanningAdmissionStall(evidenceOf({ specUnreadable: true, laneIneligible: true })))
      .toEqual({ outcome: "write", code: "plan-spec-unreadable" });
  });

  it("names lane ineligibility rather than the residual 'no admission'", () => {
    expect(decidePlanningAdmissionStall(evidenceOf({ laneIneligible: true })))
      .toEqual({ outcome: "write", code: "plan-lane-ineligible" });
  });

  it("names recoverable work only on the full triple: branch claimed, worktree unusable, commits unmerged", () => {
    const full = decidePlanningAdmissionStall(evidenceOf({
      branch: { branchClaimed: true, worktreeUsable: false, uniqueCommitCount: 4 },
    }));
    expect(full).toEqual({ outcome: "write", code: "recoverable-work", uniqueCommitCount: 4 });

    for (const branch of [
      { branchClaimed: false, worktreeUsable: false, uniqueCommitCount: 4 },
      { branchClaimed: true, worktreeUsable: true, uniqueCommitCount: 4 },
      { branchClaimed: true, worktreeUsable: false, uniqueCommitCount: 0 },
      { branchClaimed: true, worktreeUsable: false, uniqueCommitCount: undefined },
    ]) {
      expect(decidePlanningAdmissionStall(evidenceOf({ branch })))
        .toEqual({ outcome: "write", code: "plan-no-admission" });
    }
  });

  it("leaves a fresh throttle episode to triage but corrects a stale one to the residual", () => {
    // Well INSIDE the ownership window: a throttle triage stamped minutes ago is a live observation.
    const fresh = episodeOf({ lastAt: new Date(NOW - 10 * MIN).toISOString() });
    expect(decidePlanningAdmissionStall(evidenceOf({ episode: fresh }), NOW))
      .toEqual({ outcome: "skip", reason: "triage-owned" });

    // Well OUTSIDE it: nobody has re-observed the gate for hours, so "waiting for a planner slot" is
    // history, and the residual's honesty is truer than a reason whose observer is gone.
    const stale = episodeOf({ lastAt: new Date(NOW - PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS - HOUR).toISOString() });
    expect(decidePlanningAdmissionStall(evidenceOf({ episode: stale }), NOW))
      .toEqual({ outcome: "write", code: "plan-no-admission" });
  });

  it("never re-stamps a card that already names the residual", () => {
    const residual = episodeOf({ code: "plan-no-admission", lastAt: new Date(NOW - 10 * HOUR).toISOString() });
    // Ten hours old, so freshness is not what keeps it silent: the residual is terminal-stable.
    expect(decidePlanningAdmissionStall(evidenceOf({ episode: residual }), NOW))
      .toEqual({ outcome: "skip", reason: "already-named" });
  });

  it("leaves a fresh episode that already matches the reached code, and corrects a stale mismatch", () => {
    const sameFresh = episodeOf({ code: "plan-spec-unreadable", lastAt: new Date(NOW - 10 * MIN).toISOString() });
    expect(decidePlanningAdmissionStall(evidenceOf({ specUnreadable: true, episode: sameFresh }), NOW))
      .toEqual({ outcome: "skip", reason: "already-named" });

    const mismatchStale = episodeOf({ code: "plan-admission-throttled", lastAt: new Date(NOW - 6 * HOUR).toISOString() });
    expect(decidePlanningAdmissionStall(evidenceOf({ specUnreadable: true, episode: mismatchStale }), NOW))
      .toEqual({ outcome: "write", code: "plan-spec-unreadable" });
  });

  it("residues to plan-no-admission when nothing else explains the silence", () => {
    expect(decidePlanningAdmissionStall(evidenceOf())).toEqual({ outcome: "write", code: "plan-no-admission" });
  });
});

/* -------------------------------------------------------------------------- */
/* Age, threshold, lane, and spec probes                                      */
/* -------------------------------------------------------------------------- */

describe("age, threshold, lane eligibility, and spec readability", () => {
  it("measures from the most recent touch, and refuses to invent an age from an unparseable clock", () => {
    expect(planningAdmissionAgeMs({ createdAt: AGED_ISO, updatedAt: FRESH_ISO }, NOW)).toBe(HOUR);
    expect(planningAdmissionAgeMs({ createdAt: "not-a-date" }, NOW)).toBeUndefined();
    expect(planningAdmissionAgeMs({}, NOW)).toBeUndefined();
  });

  it("takes the planning column's declared stalenessMs and falls back to the 48 h policy default", () => {
    expect(resolvePlanningStallThresholdMs(planningIr({ thresholdMs: 3 * HOUR }), "backlog")).toBe(3 * HOUR);
    expect(resolvePlanningStallThresholdMs(planningIr(), "backlog")).toBe(PLANNING_ADMISSION_STALL_DEFAULT_MS);
    expect(resolvePlanningStallThresholdMs(undefined, "backlog")).toBe(PLANNING_ADMISSION_STALL_DEFAULT_MS);
    // An undeclared column is not a 0 ms threshold: it is the default.
    expect(resolvePlanningStallThresholdMs(planningIr({ thresholdMs: 3 * HOUR }), "wip")).toBe(
      PLANNING_ADMISSION_STALL_DEFAULT_MS,
    );
  });

  it("calls a fast-lane, manual-intake, or planning-node-less column ineligible — and fails open on silence", () => {
    expect(isPlanningLaneIneligible(agedTask({ executionMode: "fast" }), planningIr())).toBe(true);
    expect(isPlanningLaneIneligible(agedTask(), planningIr({ intakeConfig: { autoTriage: false } }))).toBe(true);
    expect(isPlanningLaneIneligible(agedTask(), planningIr({ planningColumn: "wip" }))).toBe(true);
    expect(isPlanningLaneIneligible(agedTask(), planningIr())).toBe(false);
    // FAILS OPEN: a v1 IR (no column model) and a missing IR are both "cannot answer", not "ineligible".
    expect(isPlanningLaneIneligible(agedTask(), V1_IR)).toBe(false);
    expect(isPlanningLaneIneligible(agedTask(), undefined)).toBe(false);
  });

  it("answers the planning-lane question with THREE outcomes, so silence never reads as a verdict", () => {
    /*
    The retract half of the sweep trusts this helper's answer, so the third outcome is load-bearing: a
    workflow that cannot speak must not be reported as "this lane does not plan". A v1 graph and a v1 graph
    upgraded by `synthesizeDefaultColumns` (every default column present, `traits: []` on all of them) both
    LOOK like an empty answer and mean the opposite of one.
    */
    expect([...(resolvePlanningLanes(planningIr()) ?? [])].sort()).toEqual(["backlog", "hold-lane"]);
    expect(resolvePlanningLanes(V1_IR)).toBeUndefined();
    expect(resolvePlanningLanes(undefined)).toBeUndefined();
    expect(resolvePlanningLanes(planningIr({
      columns: [
        { id: "backlog", name: "Backlog", traits: [] },
        { id: "done", name: "Done", traits: [] },
      ],
    }))).toBeUndefined();
    // A v2 board that deliberately declares an intake lane and no hold lane answers the SET, not undefined.
    expect([...(resolvePlanningLanes(planningIr({ columns: [
      { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
      { id: "done", name: "Done", traits: [{ trait: "done" }] },
    ] })) ?? [])]).toEqual(["inbox"]);
  });

  it("distinguishes an absent spec from an unreadable one, and keeps no spec text", async () => {
    const absent = agedTask();
    const unreadable = agedTask();
    const readable = agedTask();

    expect(await probeTaskSpecReadable(PROJECT_REPO, absent.id)).toBe("absent");
    makeSpecUnreadable(unreadable.id);
    expect(await probeTaskSpecReadable(PROJECT_REPO, unreadable.id)).toBe("unreadable");
    writeSpec(readable.id, "SECRET SPEC TEXT MUST NOT BE RETURNED");
    expect(await probeTaskSpecReadable(PROJECT_REPO, readable.id)).toBe("readable");
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* -------------------------------------------------------------------------- */

describe("reconcilePlanningAdmissionStalls — population and lane membership", () => {
  it("names an aged, silent, planning-lane card and writes ONLY the episode key", async () => {
    const task = agedTask();
    writeSpec(task.id);
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)).toMatchObject({ code: "plan-no-admission", signature: "sweep:plan-no-admission" });
    const patch = h.updates[0].patch as Record<string, unknown>;
    // Key-preserving patch carrying exactly this lane's key: no whole-object sourceMetadata write, and
    // no lifecycle field anywhere in the patch.
    expect(Object.keys(patch)).toEqual(["sourceMetadataPatch"]);
    expect(Object.keys(patch.sourceMetadataPatch as object)).toEqual([PLAN_ADMISSION_STALL_METADATA_KEY]);
    expect(auditFor(h, task.id)?.mutationType).toBe("task:planning-admission-stalled");
  });

  it("keeps a young card, a paused card, a named-status card, and a dependency-blocked card untouched", async () => {
    const young = agedTask({ createdAt: FRESH_ISO, updatedAt: FRESH_ISO });
    const paused = agedTask({ paused: true });
    const userPaused = agedTask({ userPaused: true });
    const namedStatus = agedTask({ status: "awaiting-approval" });
    const dependencyBlocked = agedTask({ blockedBy: "RUFU273-SOMETHING" });
    const unparseableClock = agedTask({ createdAt: "nope", updatedAt: null as unknown as string });
    const all = [young, paused, userPaused, namedStatus, dependencyBlocked, unparseableClock];
    const h = harness(all, planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("resolves membership from intake/hold TRAITS, not a column name or a terminal vocabulary", async () => {
    const intake = agedTask();
    const heldWithPlanning = agedTask({ column: "hold-lane" });
    const terminal = agedTask({ column: "done" });
    const outside = agedTask({ column: "wip" });
    // The plan node is placed in BOTH planning lanes, so neither card is lane-ineligible: this is the
    // proof that membership is `intake` ∪ `hold` by TRAIT and that a renamed board is treated exactly
    // like the built-in one.
    const h = harness([intake, heldWithPlanning, terminal, outside], planningIr({ planningColumns: ["backlog", "hold-lane"] }));

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(2);
    expect(episodeWritten(h, intake.id)?.code).toBe("plan-no-admission");
    expect(episodeWritten(h, heldWithPlanning.id)?.code).toBe("plan-no-admission");
    expect(h.updates.map((entry) => entry.taskId).sort()).toEqual([heldWithPlanning.id, intake.id].sort());
  });

  it("does not let merged cards starve the per-pass cap (RUFU-273 code review P0)", async () => {
    /*
    The reported board shape, and the reason the feature was a no-op on it. A merge clears `status` back to
    nothing, so a landed card slips past every cheap guard the population applies, and it is OLDER than the
    cards still waiting to be planned. Membership in a planning lane used to be consulted only inside the
    per-candidate pass — i.e. AFTER the oldest-first `MAX_CANDIDATES` slice — so a board of `done` cards
    consumed every slot and the aged planning card below, the one an operator is actually asking about, was
    never resolved. The bound must therefore be cheap (the project's own `intake`/`hold` vocabulary) and
    applied before the sort, so the oldest-first order means oldest-first PLANNING card.
    */
    const landedIso = new Date(NOW - 200 * HOUR).toISOString();
    const landed = Array.from({ length: PLANNING_ADMISSION_STALL_MAX_CANDIDATES + 3 }, () =>
      agedTask({ column: "done", status: undefined, createdAt: landedIso, updatedAt: landedIso }));
    // 60 h old: younger than every landed card, so the pre-cap slice used to leave it out.
    const waiting = agedTask();
    const h = harness([...landed, waiting], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, waiting.id)?.code).toBe("plan-no-admission");
    // Excluded before any per-card work: a landed card is not even examined, so it leaves no row anywhere.
    expect(h.updates.filter((entry) => entry.taskId !== waiting.id)).toHaveLength(0);
    expect(h.audit.filter((event) => event.taskId !== waiting.id)).toHaveLength(0);
  });

  it("uses the project vocabulary as a bound, not a verdict: an excluded card is unnamed, never un-named by it", async () => {
    /*
    The bound above must not become a second, coarser authority over the clear half. A card in a column the
    project vocabulary excludes cannot be NAMED by this sweep, and that fact alone is not proof it left a
    planning lane — only its own IR may say that (the v1 case below proves the difference). So the stored
    claim on the second card is retracted through the per-card pass, while the first card, which has nothing
    stored, costs the pass nothing at all.
    */
    const justLanded = agedTask({ column: "done", status: undefined });
    const namedThenMerged = agedTask({
      column: "done",
      status: undefined,
      sourceMetadata: { [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({ code: "plan-no-admission" }) },
    });
    const h = harness([justLanded, namedThenMerged], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, justLanded.id)).toBeUndefined();
    expect(h.updates.map((entry) => entry.taskId)).toEqual([namedThenMerged.id]);
    expect(h.updates[0]?.patch).toEqual({ sourceMetadataPatch: { [PLAN_ADMISSION_STALL_METADATA_KEY]: null } });
    expect(auditFor(h, namedThenMerged.id)?.metadata).toMatchObject({ outcome: "left-planning-lane" });
  });

  it("names a held card whose lane has no planning node lane-ineligible rather than silently skipping it", async () => {
    /*
    A `hold` column with no planning node is its own honest diagnosis, and skipping it would be the
    silence this task is removing: 48 h of null-status stillness in a lane where no planning node will
    ever run means the workflow does not plan cards here — the operator needs that sentence, not a shrug.
    (The alternative reading — "it is waiting to be released, then something else plans it" — is already
    named by the board: a release-pending card carries a status, and a non-empty status is a prefilter skip.)
    */
    const held = agedTask({ column: "hold-lane" });
    const h = harness([held], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, held.id)?.code).toBe("plan-lane-ineligible");
  });

  it("skips a card whose workflow cannot be read at all, rather than naming it", async () => {
    const task = agedTask();
    const h = harness([task], "missing-definition");
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("applies the column's own stalenessMs threshold instead of the 48 h default", async () => {
    const task = agedTask({ createdAt: new Date(NOW - 6 * HOUR).toISOString(), updatedAt: new Date(NOW - 6 * HOUR).toISOString() });
    const h = harness([task], planningIr({ thresholdMs: 3 * HOUR }));
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);

    // The same card under the policy default is not yet reportable.
    const h2 = harness([task], planningIr());
    expect(await h2.manager.reconcilePlanningAdmissionStalls()).toBe(0);
  });

  it("names a manual-intake card lane-ineligible instead of 'no admission'", async () => {
    const task = agedTask();
    const h = harness([task], planningIr({ intakeConfig: { autoTriage: false } }));
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)?.code).toBe("plan-lane-ineligible");
  });

  it("names a fast-lane card lane-ineligible", async () => {
    const task = agedTask({ executionMode: "fast" });
    const h = harness([task], planningIr());
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)?.code).toBe("plan-lane-ineligible");
  });

  it("does not name a v1 workflow's card lane-ineligible — an IR that cannot answer is not evidence", async () => {
    const task = agedTask();
    const h = harness([task], V1_IR);
    // Membership itself needs a column model, so a v1 IR is not a planning lane and the card is skipped
    // entirely rather than named on a guess.
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
  });
});

describe("reconcilePlanningAdmissionStalls — evidence rungs and episode authority", () => {
  it("names an unreadable spec, and never names an absent one unreadable", async () => {
    const unreadable = agedTask();
    const absent = agedTask();
    makeSpecUnreadable(unreadable.id);

    const h = harness([unreadable, absent], planningIr());
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(2);
    expect(episodeWritten(h, unreadable.id)?.code).toBe("plan-spec-unreadable");
    expect(episodeWritten(h, absent.id)?.code).toBe("plan-no-admission");
  });

  it("never overwrites RUFU-246's premise episode and records the reason in run-audit", async () => {
    const task = agedTask({
      sourceMetadata: { [PLAN_PREMISE_REJECTION_METADATA_KEY]: { code: "plan-premise-rejected", lastAt: FRESH_ISO } },
    });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(auditFor(h, task.id)).toMatchObject({
      mutationType: "task:planning-admission-stalled-no-action",
      metadata: { outcome: "premise-held" },
    });
  });

  it("leaves a card with a live recovery backoff and a fresh triage throttle alone", async () => {
    const backedOff = agedTask({ nextRecoveryAt: new Date(NOW + HOUR).toISOString() });
    const throttled = agedTask({
      sourceMetadata: { [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({ lastAt: new Date(NOW - 10 * MIN).toISOString() }) },
    });
    const h = harness([backedOff, throttled], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(auditFor(h, backedOff.id)?.metadata).toMatchObject({ outcome: "recovery-backoff" });
    expect(auditFor(h, throttled.id)?.metadata).toMatchObject({ outcome: "triage-owned" });
  });

  it("corrects a stale throttle episode whose spec is unreadable, and preserves the sibling keys", async () => {
    const task = agedTask({
      sourceMetadata: {
        planAdmissionStall: episodeOf({ lastAt: new Date(NOW - 6 * HOUR).toISOString() }),
        someOtherLaneKey: { keep: "me" },
      },
    });
    makeSpecUnreadable(task.id);

    const h = harness([task], planningIr());
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)?.code).toBe("plan-spec-unreadable");
    // Key-level patch: the correction must not be able to erase the other lane's key.
    expect(h.updates[0].patch).not.toHaveProperty("sourceMetadata");
  });

  it("never re-stamps a residual episode that is already on the row", async () => {
    const task = agedTask({
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({
          code: "plan-no-admission",
          lastAt: new Date(NOW - 20 * HOUR).toISOString(),
        }),
      },
    });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "already-named" });
  });
});

describe("reconcilePlanningAdmissionStalls — retracting a claim that stopped being true", () => {
  /*
  The naming half of this sweep is only half its contract. An episode is a claim that the card is *now* an
  aged, silent, planning-lane card; when the card stops being one, a board that keeps rendering
  "waiting for a planner slot" is lying with the same confidence as the silence this task replaced. These
  cases pin the clear half, and the three ways a clear must NOT happen.
  */
  function storedEpisode(over: Partial<TaskPlanAdmissionStallEpisode> = {}) {
    return { [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({ code: "plan-no-admission", ...over }) };
  }

  it("retracts when the card was admitted, and clears ONLY its own key", async () => {
    const task = agedTask({ status: "queued", sourceMetadata: { ...storedEpisode(), someOtherLaneKey: { keep: "me" } } });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const update = h.updates.find((entry) => entry.taskId === task.id);
    const patch = update?.patch as Record<string, unknown> | undefined;
    expect(Object.keys(patch ?? {})).toEqual(["sourceMetadataPatch"]);
    // `null` at KEY level is the store's clear idiom; a whole-object write would erase the sibling key.
    expect(patch?.sourceMetadataPatch).toEqual({ [PLAN_ADMISSION_STALL_METADATA_KEY]: null });
    expect(auditFor(h, task.id)).toMatchObject({
      mutationType: "task:planning-admission-stalled-no-action",
      metadata: { outcome: "no-longer-a-candidate" },
    });
  });

  it("retracts when the card left its workflow's planning lane", async () => {
    const task = agedTask({ column: "wip", sourceMetadata: storedEpisode() });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(h.updates.find((entry) => entry.taskId === task.id)?.patch).toEqual({
      sourceMetadataPatch: { [PLAN_ADMISSION_STALL_METADATA_KEY]: null },
    });
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "left-planning-lane" });
  });

  it("retracts when the row was touched, so the age claim itself expired", async () => {
    const task = agedTask({ createdAt: AGED_ISO, updatedAt: FRESH_ISO, sourceMetadata: storedEpisode() });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(h.updates.find((entry) => entry.taskId === task.id)?.patch).toEqual({
      sourceMetadataPatch: { [PLAN_ADMISSION_STALL_METADATA_KEY]: null },
    });
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "no-longer-aged" });
  });

  it("leaves a paused card's stored episode byte-identical — the pause family owns that row", async () => {
    const sourceMetadata = storedEpisode();
    const task = agedTask({ paused: true, sourceMetadata });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
    expect(task.sourceMetadata).toBe(sourceMetadata);
  });

  it("retracts nothing when the workflow cannot answer the placement question — a v1 IR is not proof of leaving", async () => {
    /*
    Same fixture as the "does not name a v1 workflow's card" case, but with an episode already on the row.
    A v1 graph's synthesized columns carry no trait at all, so its role query answers EMPTY while its lanes
    plainly exist; reading that silence as "this lane is not for planning" would let the analysis-safety rule
    eat its own feature — the naming side already refuses to name on such an IR, so the clear side must
    refuse to un-name on it too.
    */
    const task = agedTask({ sourceMetadata: storedEpisode() });
    const h = harness([task], V1_IR);

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("costs zero writes on a healthy board, where no card carries an episode at all", async () => {
    const admitted = agedTask({ status: "queued" });
    const terminal = agedTask({ column: "done" });
    const h = harness([admitted, terminal], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });
});

describe("reconcilePlanningAdmissionStalls — bounded git cost", () => {
  /** The fixture branch: it exists in the throwaway repo and carries a commit `main` does not have. */
  const realBranch = "feature";
  const deadWorktree = ".fusion/worktrees/definitely-not-mounted-rufu-273";

  it("names recoverable work when the branch carries unmerged commits its worktree cannot show", async () => {
    const task = agedTask({ branch: realBranch, worktree: deadWorktree });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const episode = episodeWritten(h, task.id);
    expect(episode?.code).toBe("recoverable-work");
    expect(typeof episode?.uniqueCommitCount).toBe("number");
    expect((episode as unknown as { uniqueCommitCount: number }).uniqueCommitCount).toBeGreaterThan(0);
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ code: "recoverable-work" });
  });

  it("names recoverable work for the shape the report actually carried: a branch claim with NO worktree", async () => {
    /*
    RUFU-273 code review P1. The reported cards had `branch` and no `worktree` — the executor's checkout is
    cleaned up after a while and only the branch claim survives. `worktreeUsable` used to start at `true` and
    only be revised for a RECORDED path, so this exact card looked usable, was never probed, and could never
    reach the rung whose whole question is "is there work no checkout can show?".
    */
    const task = agedTask({ branch: realBranch });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const episode = episodeWritten(h, task.id);
    expect(episode?.code).toBe("recoverable-work");
    expect((episode as unknown as { uniqueCommitCount: number }).uniqueCommitCount).toBeGreaterThan(0);
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ code: "recoverable-work" });
  });

  it("keeps the probe budget in charge of a bare branch claim too", async () => {
    // The new reachability must not smuggle extra git I/O past the cadence gate.
    const task = agedTask({ branch: realBranch });
    const h = harness([task], planningIr());
    (h.manager as unknown as { lastGitWorktreeChurnAt: number }).lastGitWorktreeChurnAt = NOW;

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)?.code).toBe("plan-no-admission");
    expect(episodeWritten(h, task.id)?.uniqueCommitCount).toBeUndefined();
  });

  it("treats a branch whose probe fails as unnamed-by-probe rather than throwing the pass", async () => {
    const task = agedTask({ branch: "fusion/definitely-not-a-real-branch-rufu-273", worktree: deadWorktree });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    // Probe returned null → the rung is unproven → the honest residual, not `recoverable-work`.
    expect(episodeWritten(h, task.id)?.code).toBe("plan-no-admission");
  });

  it("does not probe a branch while the git churn cadence says not to", async () => {
    const task = agedTask({ branch: realBranch, worktree: deadWorktree });
    const h = harness([task], planningIr());
    // Pretend a churn-heavy sweep ran moments ago: the probe window is closed.
    (h.manager as unknown as { lastGitWorktreeChurnAt: number }).lastGitWorktreeChurnAt = NOW;

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeWritten(h, task.id)?.code).toBe("plan-no-admission");
    expect(episodeWritten(h, task.id)?.uniqueCommitCount).toBeUndefined();
  });

  it("caps the probes one pass will run, and leaves the overflow cards honestly unnamed", async () => {
    const count = PLANNING_ADMISSION_STALL_MAX_BRANCH_PROBES + 1;
    const tasks = Array.from({ length: count }, () => agedTask({ branch: realBranch, worktree: deadWorktree }));
    const h = harness(tasks, planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(count);
    const codes = tasks.map((task) => episodeWritten(h, task.id)?.code);
    expect(codes.filter((code) => code === "recoverable-work")).toHaveLength(PLANNING_ADMISSION_STALL_MAX_BRANCH_PROBES);
    expect(codes.filter((code) => code === "plan-no-admission")).toHaveLength(1);
  });

  it("bounds the candidate set it will resolve in one pass", () => {
    // The cap is what makes a pathological board cheap; the sort in the sweep takes the OLDEST first, so
    // the card that has been silent longest is never starved by newer arrivals.
    expect(PLANNING_ADMISSION_STALL_MAX_CANDIDATES).toBeGreaterThan(PLANNING_ADMISSION_STALL_MAX_BRANCH_PROBES);
  });
});

describe("reconcilePlanningAdmissionStalls — audit and lifecycle safety", () => {
  it("records one row per examined card with ids/counts/fixed codes and no prose", async () => {
    const named = agedTask();
    const skipped = agedTask({ sourceMetadata: { [PLAN_PREMISE_REJECTION_METADATA_KEY]: { lastAt: FRESH_ISO } } });
    writeSpec(named.id);
    const h = harness([named, skipped], planningIr());

    await h.manager.reconcilePlanningAdmissionStalls();
    expect(h.audit).toHaveLength(2);
    for (const event of h.audit) {
      expect(event.agentId).toBe("self-healing");
      expect(event.domain).toBe("database");
      expect(Object.keys(event.metadata ?? {}).sort()).toEqual(
        ["ageMs", "column", "outcome", "scannedCount"].concat(event.mutationType === "task:planning-admission-stalled" ? ["code"] : []).sort(),
      );
    }
    const values = JSON.stringify(h.audit.map((event) => event.metadata));
    expect(values).not.toMatch(/# spec|SECRET|prompt/i);
  });

  it("passes over a paused engine without scanning or writing", async () => {
    const h = harness([agedTask()], planningIr());
    (h.manager as unknown as { store: { getSettings: () => Promise<Record<string, unknown>> } }).store.getSettings =
      async () => ({ projectSlug: "rufu273", globalPause: true, enginePaused: false });
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it("survives a throwing store read and still reports zero rather than rejecting the pass", async () => {
    const h = harness([agedTask()], planningIr());
    h.manager["store"] = {
      ...h.manager["store"],
      updateTask: async () => {
        throw new Error("store down");
      },
    } as never;
    await expect(h.manager.reconcilePlanningAdmissionStalls()).resolves.toBeLessThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Symptom acceptance — the reported silence, composed end to end             */
/* -------------------------------------------------------------------------- */

/*
FNXC:PlanningAdmissionStall 2026-09-25-22:03 (RUFU-273):
Everywhere else the two halves are tested apart — the sweep's write and the derivation's read — and only
their composition is what makes the reported condition impossible. `## Symptom Verification` asks for that
composition on the three reported fixtures, so it is pinned against the REAL derivation rather than against
a re-statement of it: a card the sweep names must come back named from `deriveTaskStallReason`, and a fresh
card must come back silent from both. A green sweep suite plus a green derivation suite would otherwise
still pass if the episode key the sweep wrote were not the key the read path reads.
*/
describe("symptom acceptance — the reported silence, composed end to end", () => {
  /** Read-time planning-lane membership: the fixture IR's intake/hold columns, as hydration supplies them. */
  const planningColumns = new Set(["backlog", "hold-lane"]);
  const readCtx = (): TaskStallReasonContext => ({ now: Date.now(), planningColumns });

  /** The row as the read path sees it once the sweep's key-preserving patch has landed. */
  function rowAfterSweep(task: Task, h: Harness): Task {
    const episode = episodeWritten(h, task.id);
    if (!episode) return task;
    return {
      ...task,
      sourceMetadata: { ...(task.sourceMetadata ?? {}), [PLAN_ADMISSION_STALL_METADATA_KEY]: episode },
    } as Task;
  }

  it("an aged, un-admitted planning card ends up named on read, not silent", async () => {
    const task = agedTask();
    writeSpec(task.id);
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const row = rowAfterSweep(task, h);
    expect(row.sourceMetadata?.[PLAN_ADMISSION_STALL_METADATA_KEY]).toBeDefined();
    expect(await deriveTaskStallReason(row, readCtx())).toMatchObject({ code: "plan-no-admission" });
  });

  it("the branch claim the report saw as untouched is named recoverable work on read", async () => {
    // The reported row: a surviving `branch` claim and no recorded worktree at all (RUFU-273 review P1).
    const task = agedTask({ branch: "feature" });
    writeSpec(task.id);
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const row = rowAfterSweep(task, h);
    const episode = row.sourceMetadata?.[PLAN_ADMISSION_STALL_METADATA_KEY] as TaskPlanAdmissionStallEpisode | undefined;
    expect(episode?.code).toBe("recoverable-work");
    expect(await deriveTaskStallReason(row, readCtx())).toMatchObject({ code: "recoverable-work" });
  });

  it("a freshly created card gets neither an episode nor a named code", async () => {
    const task = agedTask({ createdAt: FRESH_ISO, updatedAt: FRESH_ISO });
    writeSpec(task.id);
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(episodeWritten(h, task.id)).toBeUndefined();
    await expect(deriveTaskStallReason(task, readCtx())).resolves.toBeUndefined();
  });
});
