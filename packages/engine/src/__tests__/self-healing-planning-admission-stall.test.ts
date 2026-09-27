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
  PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS,
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  planAdmissionStallWrite,
  deriveTaskStallReason,
  readPlanAdmissionStallEpisode,
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
  isSweepOwnedPlanningAdmissionEpisode,
  planningAdmissionAgeMs,
  planningAdmissionAgeBaseMs,
  planningAdmissionEffectiveAgeMs,
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

/*
FNXC:PlanningAdmissionStall 2026-09-27-05:55 (RUFU-350):
The fixture the RECONCILIATION SWEEP writes, as opposed to `episodeOf`, which is triage's shape.

Both shapes are transcribed from production, not designed here. `episodeOf` mirrors the FN-8600 throttle site
(`triage.ts`, a pipe-joined composite gate identity and NO `ageMs`); this mirrors the sweep's own write
(`self-healing.ts`): the `sweep:`-prefixed code signature, plus the `ageMs` the reconstructed waiting base is
derived from. Two rules the RUFU-350 fixtures keep honest:
- the signature is kept BYTE-IDENTICAL to production, because an invented shape makes the writer-discriminator
  test tautological — it would prove that a helper recognizes a fixture nobody writes;
- `ageMs` gets NO default. A `sweep:` episode without it is the LEGACY shape every pre-RUFU-350 write carried,
  and it proves no base, so each case has to state the wait it means to encode.
*/
function sweepEpisodeOf(over: Partial<TaskPlanAdmissionStallEpisode> = {}): TaskPlanAdmissionStallEpisode {
  return {
    code: "plan-no-admission",
    signature: "sweep:plan-no-admission",
    lastAt: FRESH_ISO,
    firstAt: FRESH_ISO,
    stallCount: 1,
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
    /*
    FNXC:PlanningAdmissionStall 2026-09-27-04:55 (RUFU-350):
    Record AND apply. The pre-RUFU-350 fake only recorded patches, so every case in this file fed the sweep
    a pristine row on every call and the sweep could stay green while erasing its own badge in production:
    the bug lives in what pass N+1 READS, and a record-only fake guarantees pass N+1 reads the fixture again
    instead of the row pass N wrote. Applying is therefore the minimum faithfulness needed to express the
    reported condition at all — `listTasks` hands back the same rows `updateTask` mutates.

    Two real-store behaviors are reproduced because both are load-bearing for age arithmetic:
    - `sourceMetadataPatch` merges per key and a `null` value deletes that key, so a sibling provenance key
      survives an episode write (a whole-object overwrite would make the sibling-key cases pass vacuously).
    - every accepted write bumps `updatedAt`, which is exactly the clock `planningAdmissionAgeMs` reads.
      A zero-write pass therefore leaves it byte-identical, and a bare `{}` patch bumps it just as the real
      store does — that asymmetry is what the pass-sequence cases assert.
    */
    updateTask: async (taskId: string, patch: Record<string, unknown>) => {
      updates.push({ taskId, patch });
      const row = tasks.find((candidate) => candidate.id === taskId);
      if (!row) return;
      const metadataPatch = patch.sourceMetadataPatch as Record<string, unknown> | undefined;
      if (metadataPatch) {
        const merged: Record<string, unknown> = { ...(row.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(metadataPatch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        row.sourceMetadata = merged as Task["sourceMetadata"];
      }
      const { sourceMetadataPatch: _applied, ...fields } = patch;
      Object.assign(row, fields);
      row.updatedAt = new Date().toISOString();
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
/* The clock and the writer discriminator (RUFU-350)                           */
/* -------------------------------------------------------------------------- */

/*
FNXC:PlanningAdmissionStall 2026-09-27-05:55 (RUFU-350):
Unit coverage for the two pure helpers the fix turns on, over the data states enumerated up front. Sweep-level
tests are the only existing path into these functions, and the states that decide the outcome — a row whose raw
clock has collapsed under a reconstructed base, a foreign signature, a corrupt stamp, the legacy `ageMs`-less
shape — are exactly the ones a sweep-level fixture cannot enumerate without becoming twelve sweeps.

The arithmetic is kept self-consistent on purpose: the reconstructed base is pinned to the row's own
`createdAt`, so a helper that derived the base wrongly (a sign flip, a lost `ageMs`) would disagree with the
calendar and fail an equality instead of quietly shifting a threshold comparison.
*/
describe("the admission clock and its writer discriminator (RUFU-350)", () => {
  /** The true waiting start: the card was created 60 h and 20 min before this call's clock. */
  const BASE_MS = NOW - 60 * HOUR - 20 * MIN;
  const BASE_ISO = new Date(BASE_MS).toISOString();
  /** The row as the sweep reads it AFTER its own naming write: `updatedAt` is that write's instant. */
  const TOUCHED_ISO = new Date(NOW - 20 * MIN).toISOString();
  const touchedRow = () => ({ createdAt: BASE_ISO, updatedAt: TOUCHED_ISO });
  /** The episode that same naming write stored: the card had waited 60 h when it was named. */
  const namedEpisode = () => sweepEpisodeOf({ firstAt: TOUCHED_ISO, lastAt: TOUCHED_ISO, ageMs: 60 * HOUR });

  it("measures a card with no episode by the raw clock, exactly as before the fix", () => {
    expect(planningAdmissionEffectiveAgeMs({ createdAt: AGED_ISO, updatedAt: FRESH_ISO }, undefined, NOW))
      .toBe(HOUR);
    expect(planningAdmissionAgeBaseMs(undefined)).toBeUndefined();
  });

  it("reconstructs the wait from a complete sweep episode, and lands on the calendar date it must land on", () => {
    const episode = namedEpisode();
    // The base the sweep derives is the card's real waiting start — the row's own `createdAt`, independently.
    expect(planningAdmissionAgeBaseMs(episode)).toBe(BASE_MS);
    // The raw clock now reports the 20 minutes since the naming write — the number that erased the badge.
    expect(planningAdmissionAgeMs(touchedRow(), NOW)).toBe(20 * MIN);
    // The reconstructed clock reports the wait the card genuinely still has: 60 h at naming + 20 min since.
    expect(planningAdmissionEffectiveAgeMs(touchedRow(), episode, NOW)).toBe(60 * HOUR + 20 * MIN);
  });

  it("refuses to inherit a base from a triage episode, even one that happens to carry an `ageMs`", () => {
    /*
    Triage owns its episode: it stamps a gate-identity composite and no `ageMs` today. The discriminator must
    not depend on that accident — a foreign signature proves nothing this sweep may extend, or a triage stamp
    would silently inherit a base the sweep invented and age a card triage is still polling.
    */
    // Triage's real signature composition (`triage.ts`): [gate, maxConcurrent, claimed, cardCount].join("|").
    const triageEpisode = episodeOf({
      signature: "running-agent cap|2|2|3",
      firstAt: TOUCHED_ISO,
      lastAt: TOUCHED_ISO,
      ageMs: 60 * HOUR,
    });
    expect(isSweepOwnedPlanningAdmissionEpisode(triageEpisode)).toBe(false);
    expect(planningAdmissionAgeBaseMs(triageEpisode)).toBeUndefined();
    // Falls back to the raw clock rather than inventing the difference.
    expect(planningAdmissionEffectiveAgeMs(touchedRow(), triageEpisode, NOW)).toBe(20 * MIN);
  });

  it("treats the legacy `ageMs`-less sweep shape as owned but unprovable, so it ages by the raw clock", () => {
    /*
    Every episode written before this change carries the code signature and no `ageMs`. It is still the sweep's
    own (so the retract pass may still clear it), and it still proves no base (so the age falls back to the raw
    clock). The badge on such a card can therefore still self-erase — an honest boundary of a store that exposes
    no `sourceMetadataPatch`, and the reason a hand-built third fake shape would have been the wrong fixture.
    */
    const legacy = sweepEpisodeOf();
    expect(isSweepOwnedPlanningAdmissionEpisode(legacy)).toBe(true);
    expect(planningAdmissionAgeBaseMs(legacy)).toBeUndefined();
    expect(planningAdmissionEffectiveAgeMs(touchedRow(), legacy, NOW)).toBe(20 * MIN);
  });

  it("classifies ownership by the writer prefix alone, never by the code inside the signature", () => {
    // A signature equal to a bare CODE must not pass: the prefix is the only thing that claims sweep ownership.
    expect(isSweepOwnedPlanningAdmissionEpisode(sweepEpisodeOf({ signature: "plan-no-admission" }))).toBe(false);
    expect(isSweepOwnedPlanningAdmissionEpisode(sweepEpisodeOf({ signature: "sweep:plan-no-admission" }))).toBe(true);
    // An absent or empty signature is pre-discriminator data, treated as the sweep's own.
    expect(isSweepOwnedPlanningAdmissionEpisode(sweepEpisodeOf({ signature: undefined }))).toBe(true);
    expect(isSweepOwnedPlanningAdmissionEpisode(sweepEpisodeOf({ signature: "" }))).toBe(true);
    // Nothing stored at all is not somebody else's live claim.
    expect(isSweepOwnedPlanningAdmissionEpisode(undefined)).toBe(true);
    expect(isSweepOwnedPlanningAdmissionEpisode(null)).toBe(true);
  });

  it("falls back to the raw clock on a corrupt stamp instead of inventing an impossible wait", () => {
    const row = touchedRow();
    const corrupt = (over: Record<string, unknown>) => ({ ...namedEpisode(), ...over });
    // A non-string `firstAt` (a serialized Date object) and an unparseable one are both unprovable.
    expect(planningAdmissionAgeBaseMs(corrupt({ firstAt: new Date(BASE_MS) }))).toBeUndefined();
    expect(planningAdmissionAgeBaseMs(corrupt({ firstAt: "last tuesday" }))).toBeUndefined();
    // A non-finite, non-numeric, or negative `ageMs` would fabricate a base EARLIER than the card's birth.
    expect(planningAdmissionAgeBaseMs(corrupt({ ageMs: Number.NaN }))).toBeUndefined();
    expect(planningAdmissionAgeBaseMs(corrupt({ ageMs: "3600000" as unknown as number }))).toBeUndefined();
    expect(planningAdmissionAgeBaseMs(corrupt({ ageMs: -1 }))).toBeUndefined();
    for (const episode of [
      corrupt({ firstAt: new Date(BASE_MS) }),
      corrupt({ firstAt: "last tuesday" }),
      corrupt({ ageMs: Number.NaN }),
      corrupt({ ageMs: "3600000" as unknown as number }),
      corrupt({ ageMs: -1 }),
    ]) {
      expect(planningAdmissionEffectiveAgeMs(row, episode, NOW)).toBe(20 * MIN);
    }
  });

  it("never reports a negative wait when the row is stamped ahead of the call's clock", () => {
    /*
    A host clock that steps backwards between the row write and this call makes the raw age negative. The raw
    helper reports what the calendar says — it is a measurement, and a measurement that hides its own direction
    is worse than useless — while the helper that feeds the gate, the ladder, and the audit row clamps, because
    a negative number would be written into a run-audit row as the operator-visible wait.
    */
    const futureRow = { createdAt: BASE_ISO, updatedAt: new Date(NOW + 5 * MIN).toISOString() };
    expect(planningAdmissionAgeMs(futureRow, NOW)).toBe(-5 * MIN);
    expect(planningAdmissionEffectiveAgeMs(futureRow, undefined, NOW)).toBe(0);
    // The reconstructed arm was already clamped; both arms now agree at the boundary.
    const futureBase = sweepEpisodeOf({ firstAt: new Date(NOW + MIN).toISOString(), lastAt: TOUCHED_ISO, ageMs: 0 });
    expect(planningAdmissionAgeBaseMs(futureBase)).toBe(NOW + MIN);
    expect(planningAdmissionEffectiveAgeMs(futureRow, futureBase, NOW)).toBe(0);
  });

  it("keeps the reconstructed base stable across a same-code refresh, and moves it when grown age is stamped", () => {
    /*
    The base is only durable if the shared writer's `ageMs` field still means what the first write meant.
    `planAdmissionStallWrite` keeps `firstAt` through a same-code refresh and REPLACES `ageMs`, so stamping the
    grown age every refresh would slide `firstAt - ageMs` earlier by the refresh interval each time — the badge
    would age itself out at refresh N instead of never. This is the invariant behind the `ageMsToStamp` fork.
    */
    const namedAt = NOW - PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS - MIN;
    const prior = sweepEpisodeOf({
      firstAt: new Date(namedAt).toISOString(),
      lastAt: new Date(namedAt).toISOString(),
      ageMs: 60 * HOUR,
    });
    const baseBefore = planningAdmissionAgeBaseMs(prior)!;

    // What the sweep writes today: the PRIOR age, refreshed past the floor so the write is not refused.
    const refreshed = planAdmissionStallWrite(
      prior,
      { code: prior.code, signature: prior.signature, ageMs: prior.ageMs },
      NOW,
    )!;
    expect(refreshed.lastAt).toBe(new Date(NOW).toISOString());
    expect(planningAdmissionAgeBaseMs(refreshed)).toBe(baseBefore);

    // The counterfactual: the grown age moves the base earlier by exactly the refresh interval.
    const drifted = planAdmissionStallWrite(
      prior,
      { code: prior.code, signature: prior.signature, ageMs: 60 * HOUR + (NOW - namedAt) },
      NOW,
    )!;
    expect(planningAdmissionAgeBaseMs(drifted)).toBe(baseBefore - (NOW - namedAt));
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

    /*
    The same card under the policy default is not reportable — NAMING is what the default withholds, and
    that is what this case pins. The one write the pass does make is the RETRACTION of the episode only the
    3 h column threshold supported: 6 h of age never satisfies the 48 h default, so the claim written under
    the stricter bar is false under the wider one.

    The pre-RUFU-350 record-only harness made this read as zero writes by handing pass 2 a card with no
    episode at all. Production applies its writes, so the honest expectation is the retraction.
    */
    const h2 = harness([task], planningIr());
    expect(await h2.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(h2.audit.some((event) => event.mutationType === "task:planning-admission-stalled")).toBe(false);
    expect(auditFor(h2, task.id)?.metadata).toMatchObject({ outcome: "no-longer-aged" });
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
    /*
    FNXC:PlanningAdmissionStall 2026-09-27-05:45 (RUFU-350):
    And the sibling key survives ON THE ROW, not merely in the shape of the patch. The patch-shape assertion was
    written against a fake that never applied anything, so it could not distinguish "key-level patch" from "the
    fake dropped the whole field"; with a harness that applies what the store applies, the row is the only place
    the RUFU-246 premise provenance can be shown to have survived the write.
    */
    expect((task.sourceMetadata as Record<string, unknown>).someOtherLaneKey).toEqual({ keep: "me" });
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
    // The clear took its own key and nothing else: the row still carries the other lane's provenance.
    expect((task.sourceMetadata as Record<string, unknown>).someOtherLaneKey).toEqual({ keep: "me" });
    expect(readPlanAdmissionStallEpisode(task.sourceMetadata)).toBeUndefined();
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

  /*
  FNXC:PlanningAdmissionStall 2026-09-27-05:50 (RUFU-350):
  This is RUFU-273's "a touched row expires the age claim" case, RE-EXPRESSED rather than deleted, because
  RUFU-350 proved the sentence it pinned was only ever true of a claim that cannot prove its own start:
  `updateTask` bumps `updatedAt`, so the sweep's own naming write expired the claim it had just written.
  Both directions are now pinned side by side. An episode that carries its waiting base (`firstAt - ageMs`)
  SURVIVES a row touch — a self-write is not a foreign touch — while an episode that proves no base still
  expires exactly as it always did, which is the honest boundary of the shape that carries no `ageMs`.
  */
  it("expires a touched row whose claim proves no base, and keeps one that reconstructs its own wait", async () => {
    // The legacy shape every pre-RUFU-350 write carried: the sweep's own signature, no `ageMs`, so no base.
    const unverifiable = agedTask({ updatedAt: FRESH_ISO, sourceMetadata: storedEpisode() });
    // A complete-looking episode whose clock is unreadable proves no more than the legacy shape does.
    const corrupt = agedTask({
      updatedAt: FRESH_ISO,
      sourceMetadata: storedEpisode({ firstAt: "last tuesday", ageMs: 60 * HOUR }),
    });
    // The same touched row, but the episode says "I had already waited 60 h when I was first stamped".
    const provable = agedTask({
      updatedAt: FRESH_ISO,
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: sweepEpisodeOf({
          firstAt: new Date(NOW - 61 * HOUR).toISOString(),
          lastAt: FRESH_ISO,
          ageMs: 60 * HOUR,
        }),
      },
    });
    const h = harness([unverifiable, corrupt, provable], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(2);
    expect(h.updates.find((entry) => entry.taskId === unverifiable.id)?.patch).toEqual({
      sourceMetadataPatch: { [PLAN_ADMISSION_STALL_METADATA_KEY]: null },
    });
    expect(auditFor(h, unverifiable.id)?.metadata).toMatchObject({ outcome: "no-longer-aged" });
    expect(h.updates.find((entry) => entry.taskId === corrupt.id)?.patch).toEqual({
      sourceMetadataPatch: { [PLAN_ADMISSION_STALL_METADATA_KEY]: null },
    });
    expect(auditFor(h, corrupt.id)?.metadata).toMatchObject({ outcome: "no-longer-aged" });
    // The surviving card is untouched and still says why, with the age it reconstructed rather than the row's.
    expect(h.updates.find((entry) => entry.taskId === provable.id)).toBeUndefined();
    expect(readPlanAdmissionStallEpisode(provable.sourceMetadata)?.code).toBe("plan-no-admission");
    expect(auditFor(h, provable.id)?.metadata).toMatchObject({ outcome: "already-named" });
    expect(auditFor(h, provable.id)?.metadata?.ageMs).toBeGreaterThanOrEqual(100 * HOUR);
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

describe("reconcilePlanningAdmissionStalls — the badge survives its own sweep (RUFU-350)", () => {
  /*
  FNXC:PlanningAdmissionStall 2026-09-27-04:55 (RUFU-350):
  Every other case in this file feeds the sweep a PRISTINE row, so the whole feature can be green while the
  reported defect is fully present. A real sweep mutates the row it just stamped, and the age clock the next
  pass reads is the very field that write moved: `updateTask` bumps `updatedAt`, and age is
  `now - max(createdAt, updatedAt)`, so pass 2 measures the badge at ~0 s and retracts its own naming with
  outcome `no-longer-aged`. The second self-erasure is the whole-board retract pass, which deletes every
  stored episode outside its aged set — including the throttle episodes triage wrote minutes ago.

  These are the multi-pass fixtures: the harness now applies patches the way the real store does, so pass
  N+1 reads what pass N wrote. Both reported shapes are pinned against the READ authority
  (`deriveTaskStallReason`) as well as the row, because a badge that survives in storage but never renders
  would still leave the operator facing the original silence.
  */
  const readCtx = (): TaskStallReasonContext => ({
    now: Date.now(),
    planningColumns: new Set(["backlog", "hold-lane"]),
  });
  const episodeOnRow = (task: Task) => readPlanAdmissionStallEpisode(task.sourceMetadata);

  it("names once, then stays named: a three-pass sequence that costs one write", async () => {
    /*
    The full sequence the report needs, in ONE test, because the defect was a sequence and a per-pass fixture
    cannot show it: pass 1 writes, and passes 2+ READ what pass 1 wrote. Each pass asserts three things an
    operator can check — the exact write count, the row's untouched `updatedAt`, and the badge through the
    read authority — plus the audit outcome, so a future "optimization" that copy-writes an unchanged episode
    shows up as a write-count failure rather than as a silent extra row per card per hour.
    */
    const task = agedTask();
    writeSpec(task.id);
    const h = harness([task], planningIr());

    // Pass 1: exactly one write, the naming write — and it bumps the row's `updatedAt` like any real write.
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "named", code: "plan-no-admission" });
    expect(episodeOnRow(task)?.code).toBe("plan-no-admission");
    const namedUpdatedAt = task.updatedAt;
    expect(await deriveTaskStallReason(task, readCtx())).toMatchObject({ code: "plan-no-admission" });

    /*
    Passes 2 and 3 are the self-erasure window: pre-fix the raw clock reads the naming write's own `updatedAt`
    as a ~0 s card, the age gate fails, and THIS pass retracts the naming with `no-longer-aged`. Post-fix the
    card is measured from the base its own episode proves, the ladder answers `already-named`, and a card that
    stays silent is permanently free for the sweep.
    */
    for (const pass of [2, 3]) {
      h.updates.length = 0;
      h.audit.length = 0;
      expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
      // Zero writes includes zero copy-writes: an unchanged episode is never re-stamped.
      expect(h.updates, `pass ${pass} wrote a row it had no reason to touch`).toHaveLength(0);
      expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "already-named" });
      // Byte-identical, not merely re-parseable: any write would have moved this field.
      expect(task.updatedAt).toBe(namedUpdatedAt);
      expect(episodeOnRow(task)?.code).toBe("plan-no-admission");
      expect(await deriveTaskStallReason(task, readCtx())).toMatchObject({ code: "plan-no-admission" });
    }
  });

  it("carries the waiting base through a correction, so the corrected badge does not self-erase", async () => {
    /*
    The reachable drift trap at the write seam. Correcting a STALE episode to the residual is the one write the
    ladder can make over an episode that already proves a waiting base, and it restarts `firstAt` at the write
    instant — so the only thing keeping the reconstructed base intact is that the `ageMs` written beside it is
    the EFFECTIVE age. Stamp the raw age instead (what this call site did before RUFU-350) and the new base
    lands on `now - rawAge`, the age gate fails on the very next pass, and the sweep retracts its own
    correction — the reported bug, arriving through a different door.
    */
    const task = agedTask({
      // The raw clock says one hour old; only the episode says this card has been waiting ~5 days.
      updatedAt: FRESH_ISO,
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: sweepEpisodeOf({
          code: "plan-spec-unreadable",
          signature: "sweep:plan-spec-unreadable",
          firstAt: new Date(NOW - 60 * HOUR).toISOString(),
          // Past the 60-min ownership floor: nobody is still observing that reason, so it is correctable.
          lastAt: new Date(NOW - 2 * HOUR).toISOString(),
          ageMs: 59 * HOUR,
        }),
      },
    });
    // The spec reads fine now, so no evidence rung fires and the residual is the honest verdict.
    writeSpec(task.id);
    const h = harness([task], planningIr());
    const baseBefore = planningAdmissionAgeBaseMs(readPlanAdmissionStallEpisode(task.sourceMetadata));
    expect(baseBefore).toBeDefined();

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    const corrected = readPlanAdmissionStallEpisode(task.sourceMetadata);
    expect(corrected?.code).toBe("plan-no-admission");
    // The base survived a `firstAt` restart, to within the milliseconds the pass itself takes.
    expect(planningAdmissionAgeBaseMs(corrected)).toBeGreaterThanOrEqual(baseBefore! - MIN);
    // The age the operator is told is the reconstructed wait, not the one-hour row age.
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "named", ageMs: expect.any(Number) });
    expect(auditFor(h, task.id)?.metadata?.ageMs).toBeGreaterThanOrEqual(100 * HOUR);

    // Pass 2 is the pin: the raw-age stamp would have retracted this correction outright.
    h.updates.length = 0;
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(readPlanAdmissionStallEpisode(task.sourceMetadata)?.code).toBe("plan-no-admission");
    expect(await deriveTaskStallReason(task, readCtx())).toMatchObject({ code: "plan-no-admission" });
  });

  it("does not retract a triage-owned throttle episode while triage is still polling", async () => {
    /*
    The reported card: triage's own FN-8600 stamp (a pipe-joined gate signature, never a `sweep:` prefix)
    on a card that has already picked up a `status`, so the sweep never considers it nameable and the
    whole-board retract pass deletes the episode as `no-longer-a-candidate`. A fresh foreign-owned stamp is
    a claim triage still owns — the poll that wrote it runs every 15 s — so the sweep must leave it alone.
    */
    const task = agedTask({
      status: "queued",
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({
          signature: "running-agent cap|2|2|3",
          firstAt: new Date(NOW - 10 * MIN).toISOString(),
          lastAt: new Date(NOW - 10 * MIN).toISOString(),
          ageMs: 60 * HOUR,
        }),
      },
    });
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "triage-owned" });
    expect(episodeOnRow(task)?.signature).toBe("running-agent cap|2|2|3");
    /*
    The read path is asserted, but honestly: while the scheduler transient `status: "queued"` sits on the row the
    derivation deliberately renders NOTHING for the planning lane — a non-empty status belongs to whatever wrote
    it, which is RUFU-273's precedence rule, not a defect. So this shape's survival guarantee is that triage's
    episode is still there to render once the transient clears; the operator-visible sentence for a card in the
    silent set is the case below, and core's own suite pins the status-bearing non-render.
    */
    expect(await deriveTaskStallReason(task, readCtx())).toBeUndefined();
    expect(await deriveTaskStallReason({ ...task, status: "" }, readCtx()))
      .toMatchObject({ code: "plan-admission-throttled" });
  });

  it("leaves a live triage episode on a silently-aged card alone, and the badge still reads throttled", async () => {
    /*
    The operator-visible half of mechanism B: a card with NO status — the silent set the badge exists for — whose
    only written reason is triage's live throttle stamp. The sweep may not replace it with a `plan-no-admission`
    verdict of its own (RUFU-273's rule (a) refuses a different-code write inside the ownership window), so what
    the operator keeps reading is triage's capacity sentence rather than a generic one the sweep invented.
    */
    const task = agedTask({
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({
          signature: "running-agent cap|2|2|3",
          firstAt: new Date(NOW - 60 * HOUR).toISOString(),
          lastAt: new Date(NOW - 10 * MIN).toISOString(),
          ageMs: 60 * HOUR,
        }),
      },
    });
    writeSpec(task.id);
    const h = harness([task], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(episodeOnRow(task)?.code).toBe("plan-admission-throttled");
    // The naming pass reports the SAME `triage-owned` vocabulary the retract pass uses — RUFU-273's rung 6
    // owns a fresh throttle stamp, so both lanes now answer "triage owns this claim" with one outcome.
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "triage-owned" });
    expect(await deriveTaskStallReason(task, readCtx())).toMatchObject({
      code: "plan-admission-throttled",
      reason: expect.stringContaining("planner capacity"),
    });
  });

  it("still retracts a foreign episode once its owner has gone quiet past the ownership floor", async () => {
    // The control that keeps the floor from becoming an immunity: the same foreign stamp, last refreshed
    // beyond PLANNING_ADMISSION_STALL_TRIAGE_OWNERSHIP_MS, is stale history — triage stopped polling this
    // card — so the sweep retracts it exactly as it always did, and the row says so with its measurement.
    const task = agedTask({
      status: "queued",
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: episodeOf({
          signature: "running-agent cap|2|2|3",
          firstAt: new Date(NOW - 5 * HOUR).toISOString(),
          lastAt: new Date(NOW - 2 * HOUR).toISOString(),
          ageMs: 5 * HOUR,
        }),
      },
    });
    const h = harness([task], planningIr());

    // The pass count is writes OR retractions, so the honest expectation for a control that must clear is 1.
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(1);
    expect(episodeOnRow(task)).toBeUndefined();
    expect(auditFor(h, task.id)?.metadata).toMatchObject({ outcome: "no-longer-a-candidate" });
    // The age is the one the decision measured, not the one the clear's own `updatedAt` bump left behind
    // (a write-then-measure bug reports ~0 or a negative here).
    expect(auditFor(h, task.id)?.metadata?.ageMs).toBeGreaterThanOrEqual(4 * HOUR);
  });
});

describe("reconcilePlanningAdmissionStalls — sibling provenance survives both of its writes (RUFU-350)", () => {
  it("preserves every other provenance key on the row, across both halves of the sweep", async () => {
    /*
    The episode is a guest in a field other lanes also write: RUFU-246's premise rejection, duplicate/handoff
    provenance, and other lanes' own keys all live in the same `sourceMetadata` object. Naming and retracting are
    the two writes this sweep makes, and each must leave every other key in place — asserted ON THE ROW, which is
    where a whole-object write would show up as an absence. The naming half also pins the no-copy-write property:
    a pass with nothing to say must not even re-stamp the episode it found, so the stored object stays the same
    object.
    */
    const premise = { code: "plan-premise-rejected", lastAt: FRESH_ISO };
    const named = agedTask({ sourceMetadata: { someOtherLaneKey: { keep: "me" } } });
    const retracted = agedTask({
      status: "queued",
      sourceMetadata: {
        [PLAN_ADMISSION_STALL_METADATA_KEY]: sweepEpisodeOf({ firstAt: AGED_ISO, lastAt: AGED_ISO, ageMs: 60 * HOUR }),
        [PLAN_PREMISE_REJECTION_METADATA_KEY]: premise,
        someOtherLaneKey: { keep: "me" },
      },
    });
    writeSpec(named.id);
    const h = harness([named, retracted], planningIr());

    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(2);
    // Naming half: the write added its key and left the sibling key exactly where it was.
    expect((named.sourceMetadata as Record<string, unknown>).someOtherLaneKey).toEqual({ keep: "me" });
    const storedEpisode = readPlanAdmissionStallEpisode(named.sourceMetadata);
    expect(storedEpisode?.code).toBe("plan-no-admission");
    // Retracting half: only its own key went away; RUFU-246's premise episode and the sibling both survived.
    expect(readPlanAdmissionStallEpisode(retracted.sourceMetadata)).toBeUndefined();
    expect((retracted.sourceMetadata as Record<string, unknown>)[PLAN_PREMISE_REJECTION_METADATA_KEY]).toBe(premise);
    expect((retracted.sourceMetadata as Record<string, unknown>).someOtherLaneKey).toEqual({ keep: "me" });

    // Pass 2 has nothing to say about the card it named, so it does not even re-stamp the episode.
    h.updates.length = 0;
    expect(await h.manager.reconcilePlanningAdmissionStalls()).toBe(0);
    expect(readPlanAdmissionStallEpisode(named.sourceMetadata)).toBe(storedEpisode);
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
