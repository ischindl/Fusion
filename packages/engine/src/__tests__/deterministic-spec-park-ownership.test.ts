import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DETERMINISTIC_SPEC_REJECTION_METADATA_KEY,
  type Settings,
  type Task,
  type TaskDeterministicSpecRejectionEpisode,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import {
  advanceDeterministicSpecRejectionEpisode,
  buildDeterministicSpecExhaustedError,
  computeSpecFingerprint,
  DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED,
} from "../healing/deterministic-spec-rejection.js";

/*
FNXC:DeterministicSpecRejection 2026-11-08-04:05 (RUFU-485):
The ownership contract for a deterministic-spec-exhaustion park.

RUFU-482 is the measurement: a planner regenerated a scanned-section note whose path token ended in an
ellipsis, the deterministic checker refused it verbatim, and after the refusal budget the card sat
`failed` with `recoveryRetryCount: null` and `nextRecoveryAt: null` - a state whose error sentence named
a remedy no automated lane could take and whose retry fields named no owner. Triage's discovery excludes
`status: "failed"`, FN-8592's stranded-hold sweep answers `retry-owned` for any failed card, and
`describeTaskRecoveryOwner` can only report "no owner" from two nulls. The card's author and its reviewer
each waited for the other.

The premise this sweep acts on is CONTENT, not elapsed time: a deterministic checker is a function of the
spec, so unchanged bytes guarantee the same verdict and a re-admission would spend a session to learn
nothing. Hence `spec-unchanged` is a no-action outcome, and one of the hardest invariants below is that a
repair re-admits EXACTLY ONCE per distinct content - an unbounded content-keyed repair oscillates and
burns one planner session per maintenance pass, which is a faster failure than the park it replaced.

Also pinned here: the three foreign planning parks (`PLANNING_RESEED_CYCLE_EXHAUSTED:`,
`PLANNING_FENCE_UNAVAILABLE:`, legacy `PLANNING_FAILED_EXHAUSTED:`) are never candidates. RUFU-768's
ceiling is the honest disposition for a *drifting* failure and RUFU-288's fence repair is a lock re-probe;
folding either in would make a deterministic refusal look like infrastructure, which is precisely the
mis-read that kept RUFU-482's card parked.
*/

const MIN = 60_000;
const stale = (ms: number) => new Date(Date.now() - ms).toISOString();

const TASK_ID = "FN-4850-PARK";
const REPO_DIR = "rufu-485-ownership-project";

/** The deterministic verdict this episode is about: a dangling task-document citation. */
const DIAGNOSTIC = "REVISE — Dangling task-document references in PROMPT.md:\n- .fusion/tasks/FN-4850/notes/retry-branch-audit.md";
const REFUSED_SPEC = [
  "## Original Description",
  "Stop the planner rejecting its own output.",
  "",
  "## Context to Read First",
  "- .fusion/tasks/FN-4850/notes/retry-branch-audit.md",
  "",
  "## Steps",
  "1. Park on the second identical deterministic verdict.",
].join("\n");
/** An operator's repair: the dangling citation is gone, so the verdict cannot recur. */
const REPAIRED_SPEC = [
  "## Original Description",
  "Stop the planner rejecting its own output.",
  "",
  "## Context to Read First",
  "- docs/architecture.md",
  "",
  "## Steps",
  "1. Park on the second identical deterministic verdict.",
].join("\n");
const SECOND_REPAIR = `${REPAIRED_SPEC}\n\n## Acceptance Criteria\nA second, genuinely different edit.`;

/** Trait-driven column model: `todo` is the planning lane, `wip` and `done` are not. */
function planningIr(): WorkflowIr {
  return {
    version: "v2",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }] },
      { id: "wip", name: "WIP", traits: [{ trait: "in-progress" }] },
      { id: "done", name: "Done", traits: [{ trait: "done" }] },
    ],
    nodes: [
      { id: "plan", type: "prompt", column: "todo" },
      { id: "execute", type: "prompt", column: "wip" },
    ],
    edges: [],
  } as unknown as WorkflowIr;
}

/**
 * A card parked by the real writer: the episode comes from `advanceDeterministicSpecRejectionEpisode`
 * and the error from `buildDeterministicSpecExhaustedError`, so the sweep is exercised against the exact
 * shape triage persists rather than a hand-rolled fixture that could drift from it.
 */
function parkedTask(overrides: Record<string, unknown> = {}): Task {
  // Aged on purpose: the sweep honors a 60 s grace window so it never races triage's own write or an
  // operator Retry, and the young-park case is covered by its own test below.
  const aged = () => new Date(Date.now() - 20 * MIN);
  const first = advanceDeterministicSpecRejectionEpisode(undefined, { diagnostic: DIAGNOSTIC, specContent: REFUSED_SPEC, now: aged });
  const second = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: first.episode } }, {
    diagnostic: DIAGNOSTIC,
    specContent: REFUSED_SPEC,
    now: aged,
  });
  return {
    id: TASK_ID,
    title: "Stop the planner rejecting its own deterministic output",
    description: "",
    column: "todo",
    status: "failed",
    error: buildDeterministicSpecExhaustedError({ attempts: second.episode.rejectionCount, diagnostic: DIAGNOSTIC }),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: stale(90 * MIN),
    updatedAt: stale(20 * MIN),
    columnMovedAt: stale(90 * MIN),
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    workflowStepResults: [],
    sourceMetadata: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: second.episode },
    ...overrides,
  } as unknown as Task;
}

/** A sibling planning park that belongs to a DIFFERENT owner lane. */
function foreignPark(error: string, overrides: Record<string, unknown> = {}): Task {
  return parkedTask({ error, sourceMetadata: {}, updatedAt: stale(20 * MIN), ...overrides });
}

/**
 * Re-park a repaired card the way the real writer does: the planner reproduced the identical verdict, so
 * the ladder itself produces the `escalation: "park"` episode (a hand-set `status` alone is NOT the park
 * shape, and the sweep must be able to tell the difference).
 */
function rePark(task: Task, specContent: string): Task {
  const prior = task.sourceMetadata?.[DETERMINISTIC_SPEC_REJECTION_METADATA_KEY] as TaskDeterministicSpecRejectionEpisode;
  const step = advanceDeterministicSpecRejectionEpisode({ sourceMetadata: task.sourceMetadata }, {
    diagnostic: DIAGNOSTIC,
    specContent,
    // Backdated so the re-park is past the sweep's grace window: this test is about the content stamp,
    // not about the grace period the young-park case covers on its own.
    now: () => new Date(Date.now() - 20 * MIN),
  });
  expect(step.identicalRejection).toBe(true);
  Object.assign(task, {
    status: "failed",
    error: buildDeterministicSpecExhaustedError({ attempts: step.episode.rejectionCount, diagnostic: DIAGNOSTIC }),
    sourceMetadata: { [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: step.episode },
  });
  // The repair's stamp must survive a re-park, or the sweep would re-admit the same content again.
  expect(step.episode.staleSpecFingerprint).toBe(prior.staleSpecFingerprint);
  return task;
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  ir?: WorkflowIr | null;
  isTaskActive?: (taskId: string) => boolean;
  /** Omitted when the store has no planning lifecycle lock at all (the fallback path). */
  lifecycleLock?: boolean;
  specContent?: string | null;
}

let tasksDir = "";

function harness(task: Task, options: HarnessOptions = {}) {
  const logged: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const moves: string[] = [];
  const ir = options.ir === undefined ? planningIr() : options.ir;

  // The spec on disk is the premise this sweep reads, so the harness writes the real file at the real
  // path rather than stubbing the read.
  const promptPath = getPromptPath(tasksDir, task.id);
  rmSync(dirname(promptPath), { recursive: true, force: true });
  mkdirSync(dirname(promptPath), { recursive: true });
  const content = options.specContent === undefined ? REFUSED_SPEC : options.specContent;
  if (content !== null) writeFileSync(promptPath, content, "utf8");

  // Real key-level merge semantics for `sourceMetadataPatch`: the sweep's only episode write is key-level,
  // and a fake that blindly Object.assign'd the patch field would both lose the episode and hide the
  // sibling-key loss the production merge is specifically built to avoid.
  const applyPatch = (row: Task, patch: Record<string, unknown>) => {
    const { sourceMetadataPatch, ...rest } = patch;
    Object.assign(row, rest);
    if (sourceMetadataPatch && typeof sourceMetadataPatch === "object") {
      const next = { ...(row.sourceMetadata ?? {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(sourceMetadataPatch as Record<string, unknown>)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      row.sourceMetadata = next;
    }
  };

  const store = {
    getSettings: async () => ({ globalPause: false, enginePaused: false, ...options.settings } as Settings),
    listTasks: async () => [task],
    getTask: async (id: string) => (id === task.id ? task : undefined),
    updateTaskAtomic: async (_id: string, updater: (live: Task) => unknown) => {
      const patch = await updater(task);
      if (patch) {
        updates.push(patch as Record<string, unknown>);
        applyPatch(task, patch as Record<string, unknown>);
        task.updatedAt = new Date().toISOString();
      }
      return task;
    },
    logEntry: async (_id: string, message: string) => { logged.push(message); },
    recordRunAuditEvent: async (event: Record<string, unknown>) => { audit.push(event); },
    // Every lifecycle move is recorded: the repair is in place, so a sweep that moved a column has broken
    // lifecycle containment and this array is how the test sees it.
    moveTask: async (_id: string, column: string) => { moves.push(column); },
    handoffTaskToReview: async (_id: string) => { moves.push("review"); },
    ...(options.lifecycleLock === false ? {} : {
      withPlanningLifecycleLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    }),
    getTaskWorkflowSelection: () => (ir ? { workflowId: "wf-485" } : null),
    getWorkflowDefinition: async (id: string) => (id === "wf-485" && ir ? { ir } : undefined),
    listWorkflowDefinitions: async () => (ir && !options.unresolvableSelection ? [{ ir }] : []),
    getRootDir: () => REPO_DIR,
    getTasksDir: () => tasksDir,
    writePrompt: async (_id: string, content: string) => { writeFileSync(promptPath, content, "utf8"); },
  } as unknown as TaskStore;

  const writesOnDisk = () => readFileSync(promptPath, "utf8").length;
  return {
    task,
    store,
    logged,
    audit,
    updates,
    moves,
    promptPath,
    writesOnDisk,
    setSpec: (next: string | null) => {
      if (next === null) rmSync(promptPath, { force: true });
      else writeFileSync(promptPath, next, "utf8");
    },
    manager: new SelfHealingManager(store, { rootDir: "/repo", isTaskActive: options.isTaskActive }),
  };
}

const rowsOf = (audit: Array<Record<string, unknown>>, mutationType: string) =>
  audit.filter((event) => event.mutationType === mutationType);

const REPAIR_ROW = "task:reconcile-deterministic-spec-rejection-parks";
const NO_ACTION_ROW = "task:reconcile-deterministic-spec-rejection-parks-no-action";

beforeAll(() => {
  tasksDir = mkdtempSync(join(tmpdir(), "rufu-485-ownership-"));
});

afterAll(() => {
  rmSync(tasksDir, { recursive: true, force: true });
});

describe("reconcileDeterministicSpecRejectionParks (RUFU-485)", () => {
  it("re-queues planning once when the spec on disk differs from the refused bytes, in place", async () => {
    const { task, logged, audit, moves, updates, manager } = harness(parkedTask(), { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);

    expect(task.status).toBe("needs-replan");
    expect(task.error).toBeNull();
    // The borrowed counters the park cleared stay cleared; the sweep must not re-borrow them.
    expect(task.recoveryRetryCount).toBeNull();
    expect(task.nextRecoveryAt).toBeNull();
    // In place: a planning re-queue is a status write, never a lane move.
    expect(moves).toEqual([]);
    expect(task.column).toBe("todo");
    expect(updates).toHaveLength(1);
    expect(logged.join(" ")).toContain("deterministic-spec park lifted");

    const episode = task.sourceMetadata?.[DETERMINISTIC_SPEC_REJECTION_METADATA_KEY] as TaskDeterministicSpecRejectionEpisode;
    expect(episode.escalation).toBe("hold");
    expect(episode.parkedAt).toBeUndefined();
    expect(episode.staleSpecFingerprint).toBe(computeSpecFingerprint(REPAIRED_SPEC));

    const repair = rowsOf(audit, REPAIR_ROW);
    expect(repair).toHaveLength(1);
    expect(repair[0]).toMatchObject({
      taskId: TASK_ID,
      agentId: "self-healing",
      domain: "database",
      target: TASK_ID,
      metadata: { taskId: TASK_ID, column: "todo", rejectionCount: 2, outcome: "re-admitted" },
    });
    expect(Object.keys(repair[0]!.metadata as object).sort()).toEqual(
      ["column", "outcome", "rejectionCount", "taskId", "withheldAgeMs"].sort(),
    );
    expect(rowsOf(audit, NO_ACTION_ROW)).toHaveLength(0);
  });

  it("leaves an unchanged spec parked and says so, without a write", async () => {
    const { task, updates, moves, audit, manager } = harness(parkedTask());

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(moves).toEqual([]);
    const noAction = rowsOf(audit, NO_ACTION_ROW);
    expect(noAction).toHaveLength(1);
    expect(noAction[0]).toMatchObject({ metadata: { outcome: "spec-unchanged", column: "todo" } });
  });

  it("re-admits EXACTLY ONCE per distinct content, then only on a new content change", async () => {
    const { task, audit, setSpec, manager } = harness(parkedTask(), { specContent: REPAIRED_SPEC });

    // First pass: the operator's edit earns the one re-admission.
    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);
    expect(task.status).toBe("needs-replan");

    // The planner reproduces the same verdict, so the card is parked again over the SAME bytes. The
    // stamp is what stops the oscillation: without it this pass would re-admit forever, one planner
    // session per maintenance tick, on a defect that never moved.
    rePark(task, REPAIRED_SPEC);
    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);
    expect(task.status).toBe("failed");
    expect(rowsOf(audit, NO_ACTION_ROW)).toHaveLength(1);
    /*
    `spec-unchanged`, not `already-repaired`, and that is the honest label: the re-park recorded the
    EDITED bytes as its own known-rejected fingerprint, so the refusal the card now carries really was
    computed over exactly what is on disk. An operator reading this needs to know the spec did not move
    since the refusal, which is true - the `already-repaired` code belongs to the narrower case below,
    where the disk holds content that spent an EARLIER re-admission while the park names different bytes.
    */
    expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "spec-unchanged" } });

    // A genuinely different edit is a new fact and earns one more attempt.
    setSpec(SECOND_REPAIR);
    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);
    expect(task.status).toBe("needs-replan");
    const episode = task.sourceMetadata?.[DETERMINISTIC_SPEC_REJECTION_METADATA_KEY] as TaskDeterministicSpecRejectionEpisode;
    expect(episode.staleSpecFingerprint).toBe(computeSpecFingerprint(SECOND_REPAIR));
    // rejectionCount survives a repair on purpose, so a re-refusal parks after ONE session, not two.
    expect(episode.rejectionCount).toBe(3);
  });

  it("refuses to spend a second re-admission on content that already spent one", async () => {
    // The narrow shape `already-repaired` exists for: the card is parked at refusal over bytes X, while
    // the disk holds content Y that THIS card's earlier repair already bought a session for. Re-admitting
    // on Y would pay twice for one edit, so the stamp alone - not the refusal fingerprint - must refuse.
    const task = parkedTask();
    const episode = task.sourceMetadata![DETERMINISTIC_SPEC_REJECTION_METADATA_KEY] as TaskDeterministicSpecRejectionEpisode;
    episode.staleSpecFingerprint = computeSpecFingerprint(REPAIRED_SPEC);
    const { updates, audit, manager } = harness(task, { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "already-repaired" } });
  });

  it("never re-admits twice for one repair even across repeated passes", async () => {
    const { task, audit, manager } = harness(parkedTask(), { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);
    rePark(task, REPAIRED_SPEC);
    // Hammer the sweep over the same content: the second repair never arrives.
    for (let pass = 0; pass < 4; pass += 1) {
      await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);
    }
    expect(rowsOf(audit, REPAIR_ROW)).toHaveLength(1);
    expect(rowsOf(audit, NO_ACTION_ROW)).toHaveLength(1);
  });

  it("skips and stays parked when the spec cannot be read, never parking the card deeper", async () => {
    for (const [label, specContent] of [["missing", null], ["empty", ""] as [string, string]] as Array<[string, string | null]>) {
      const { task, updates, audit, manager } = harness(parkedTask(), { specContent });

      await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

      // An unreadable premise is not evidence that the refused defect was removed, and the sweep's only
      // write is a re-admission — so a failed read must leave the honest park standing.
      expect(task.status, label).toBe("failed");
      expect(task.error, label).toContain(DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED);
      expect(updates).toHaveLength(0);
      expect(rowsOf(audit, NO_ACTION_ROW)).toHaveLength(1);
      expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "spec-unreadable" } });
    }
  });

  it("yields to a live planning or execution session", async () => {
    const { task, updates, audit, manager } = harness(parkedTask(), { specContent: REPAIRED_SPEC, isTaskActive: () => true });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "live-session" } });
  });

  it("defers to an operator hold, a paused card, and a global/engine pause", async () => {
    for (const overrides of [{ paused: true }, { userPaused: true }]) {
      const { updates, audit, manager } = harness(parkedTask(overrides), { specContent: REPAIRED_SPEC });
      await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);
      expect(updates).toHaveLength(0);
      expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "operator-held" } });
    }

    for (const settings of [{ globalPause: true }, { enginePaused: true }]) {
      const { updates, audit, manager } = harness(parkedTask(), { settings, specContent: REPAIRED_SPEC });
      await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);
      expect(updates).toHaveLength(0);
      // A paused engine audits nothing — the pause is itself the record.
      expect(audit).toHaveLength(0);
    }
  });

  it("leaves a human-review terminal contract untouched when auto-merge is off", async () => {
    const { updates, audit, manager } = harness(parkedTask({ autoMerge: false }), { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "auto-merge-off" } });
  });

  it("does not write a planning-lane signal onto a card that left the planning lane", async () => {
    const { task, updates, audit, manager } = harness(parkedTask({ column: "wip" }), { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(rowsOf(audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "left-planning-lane" } });
  });

  it("under-acts when the graph declares no column model", async () => {
    // A v1 graph upgrades with trait-less columns: it answers "no planning lanes" the same way a v2 board
    // that deliberately declares none does, and for a write that changes planning state the safe direction
    // is to leave the card in its honest failed park rather than guess a lane.
    //
    // The sweep's third refusal, `workflow-unresolvable`, is deliberately NOT asserted: the resolver
    // SUBSTITUTES the built-in IR for a missing selection, a missing definition, and even a faulting
    // definition read (all three were probed while writing this test), so no store shape reaches it. It
    // stays as the defensive arm beside the fence sweep's identical one, which its own test likewise
    // leaves unasserted - a fake that merely satisfied the branch would have been a fake, not a proof.
    const v1Ir = { nodes: [{ id: "plan", type: "prompt" }], edges: [] } as unknown as WorkflowIr;
    const noLanes = harness(parkedTask(), { ir: v1Ir, specContent: REPAIRED_SPEC });
    await expect(noLanes.manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);
    expect(noLanes.task.status).toBe("failed");
    expect(noLanes.updates).toHaveLength(0);
    expect(rowsOf(noLanes.audit, NO_ACTION_ROW)[0]).toMatchObject({ metadata: { outcome: "lane-vocabulary-unreadable" } });
  });

  it("waits out the grace window without writing or auditing a just-parked card", async () => {
    const fresh = parkedTask();
    const episode = fresh.sourceMetadata![DETERMINISTIC_SPEC_REJECTION_METADATA_KEY] as TaskDeterministicSpecRejectionEpisode;
    episode.parkedAt = new Date().toISOString();

    const { task, updates, audit, manager } = harness(fresh, { specContent: REPAIRED_SPEC });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(0);

    expect(task.status).toBe("failed");
    expect(updates).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("never touches the re-seed ceiling, the fence park, or the legacy exhaustion sentence", async () => {
    const foreignParks = [
      ["PLANNING_RESEED_CYCLE_EXHAUSTED (RUFU-768)", "PLANNING_RESEED_CYCLE_EXHAUSTED: planning re-seed ceiling reached (3 cycles) — each cycle re-planned and re-failed before Plan Review."],
      ["PLANNING_FENCE_UNAVAILABLE (RUFU-287/288)", "PLANNING_FENCE_UNAVAILABLE: durable planning handoff refused by the workflow-principal fence (role=triage) — 3 attempts exhausted."],
      ["legacy PLANNING_FAILED_EXHAUSTED", "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage"],
    ] as const;

    for (const [label, error] of foreignParks) {
      // The spec genuinely changed: the ONLY reason this sweep would ever act. It must still not act,
      // because these parks have their own owners and their own honest dispositions.
      const { task, updates, audit, manager } = harness(foreignPark(error), { specContent: REPAIRED_SPEC });

      await expect(manager.reconcileDeterministicSpecRejectionParks(), label).resolves.toBe(0);

      expect(task.status, label).toBe("failed");
      expect(task.error, label).toBe(error);
      expect(updates).toHaveLength(0);
      expect(audit).toHaveLength(0);
    }
  });

  it("dedupes a withheld outcome to one row per card and code, and clears it after a repair", async () => {
    const unchanged = harness(parkedTask());
    await unchanged.manager.reconcileDeterministicSpecRejectionParks();
    await unchanged.manager.reconcileDeterministicSpecRejectionParks();
    await unchanged.manager.reconcileDeterministicSpecRejectionParks();
    expect(unchanged.audit).toHaveLength(1);

    // A repair ends the episode, so a later park must be able to report a fresh refusal: the withheld
    // memos for this card are dropped the moment the repair lands.
    const repaired = harness(parkedTask(), { specContent: REPAIRED_SPEC });
    await expect(repaired.manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);
    expect(rowsOf(repaired.audit, NO_ACTION_ROW)).toHaveLength(0);
    expect(rowsOf(repaired.audit, REPAIR_ROW)).toHaveLength(1);
  });

  it("still repairs when the store exposes no planning lifecycle lock", async () => {
    const { task, moves, manager } = harness(parkedTask(), { specContent: REPAIRED_SPEC, lifecycleLock: false });

    await expect(manager.reconcileDeterministicSpecRejectionParks()).resolves.toBe(1);

    expect(task.status).toBe("needs-replan");
    expect(moves).toEqual([]);
  });

  it("requires BOTH halves of the park shape: a sentinel error beside a non-parked episode is no candidate", async () => {
    // The fingerprint that licenses a repair lives in the episode. A row that carries the sentence but
    // whose episode is missing, malformed, or still at `"hold"` proves nothing about the refused bytes, so
    // the sweep must leave it alone rather than re-admit on a guess.
    for (const [label, metadata] of [
      ["absent", {}],
      ["malformed", { deterministicSpecRejection: { escalation: "park" } }],
      ["still-held", { deterministicSpecRejection: { rejectionIdentity: "x", specFingerprint: "y", rejectionCount: 1, escalation: "hold", firstAt: stale(20 * MIN), lastAt: stale(20 * MIN) } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { task, updates, audit, manager } = harness(parkedTask({ sourceMetadata: metadata }), { specContent: REPAIRED_SPEC });

      await expect(manager.reconcileDeterministicSpecRejectionParks(), label).resolves.toBe(0);

      expect(task.status, label).toBe("failed");
      expect(updates, label).toHaveLength(0);
      expect(audit, label).toHaveLength(0);
    }
  });

  it("is registered in BOTH startup recovery and maintenance batch 1, clear of the sibling planning sweeps", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startup = source.slice(source.indexOf("async runStartupRecovery"), source.indexOf("  stop(): void"));
    expect(startup).toContain('name: "reconcile-deterministic-spec-rejection-park"');
    expect(startup).toContain("reconcileDeterministicSpecRejectionParks");
    const maintenance = source.slice(source.indexOf("const batch1Fns"));
    expect(maintenance).toContain('name: "reconcile-deterministic-spec-rejection-park"');
    expect(maintenance).toContain("reconcileDeterministicSpecRejectionParks");

    // Clear of the neighbours it must not merge with: the sweep body knows none of their sentinels, and
    // its registration sits beside the fence owner rather than inside another sweep's name.
    const body = source.slice(
      source.indexOf("async reconcileDeterministicSpecRejectionParks"),
      source.indexOf("private async readDeterministicSpecFingerprint"),
    );
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain("PLANNING_RESEED_CYCLE_EXHAUSTED");
    expect(body).not.toContain("PLANNING_FENCE_UNAVAILABLE");
    expect(body).not.toContain("PLANNING_FAILED_EXHAUSTED");
    expect(body).not.toContain("reconcilePrincipalHeldPlanning");
    expect(body).not.toContain("reconcilePlanningAdmissionStall");
  });
});
