import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  getBuiltinWorkflow,
  getTaskMergeBlocker,
  isPreMergeGateFailedBlocker,
  resolveRequiredPreMergeStepIds,
  type Task,
  type WorkflowStepResult,
} from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import * as reviewDispatchSweep from "../scheduling/review-dispatch-sweep.js";

/*
FNXC:ReviewVerdictAdvance 2026-09-17-12:45 (RUFU-225, salvaged by RUFU-294):
A reviewer verdict must durably decide the card's fate. A delivered Code Review APPROVE bound to the
current content (`reviewInputFingerprint`) is re-enqueued for merge by `recoverMergeableReviewTasks`,
and this file pins that boundary end to end through the sweep — in both directions, because the
advance right and the deferral duty belong to the same decision.

FNXC:ReviewVerdictAdvance 2026-10-15-16:55 (RUFU-294 salvage adaptation):
This is the upstream `fb6cffe876` pin rebuilt on current `main`, not its patch. Three things moved
under it, and each changed what the file may assert:
  1. The sweep grew required seams (project-union review lanes, per-task workflow IR with
     provenance, merge admission, `resolvePreMergeGateForTask`, unrun-park classification, active
     work items, per-task recovery budgets), so the store fake is the one the current sibling
     (`verdictless-pre-merge-gate-rerun.test.ts`) proves against this sweep.
  2. The content binding is produced by exactly one module — `captureMergeContentDescriptor` —
     which self-healing imports directly, so the descriptor is supplied at that seam. The pin is
     about two authorities agreeing about a card, not about git.
  3. No refusal here is asserted as a sentence. `merge-blocker-reason-coupling.test.ts`
     (`FNXC:MergeBlockerReasons`) states the rule: the wording may be reworded freely while the rule
     may not drift from the door that enforces it. Main already reworded the move container once
     (quoted in-lock preflight, unquoted container), which is exactly the drift that rule predicts.
     Deferral here is asserted as: the sweep did not enqueue, wrote nothing, and the blocker the door
     returns classifies as the failed-pre-merge family via the authority's own predicate
     `isPreMergeGateFailedBlocker`.
The deferral owner named upstream (`STAS-205 review-dispatch-sweep`) no longer exists; the in-side
owner is `scheduling/review-dispatch-sweep.ts`, and its surface is pinned structurally below.

FNXC:ReviewVerdictAdvance 2026-11-20-22:05 (RUFU-739 is the card that actually delivered this file):
RUFU-294 reported this shipment three times and never landed it: its only commit
`62804b4340a3ac40e7d1e94216782e1d75b168d3` survived as the tip of `lan/fusion/rufu-293` (plus three
`refs/backup/*` safety refs) with no local branch of its own, and the file stayed absent from `main`
for five more weeks. RUFU-739 recovers the content from the git object and is the card accountable
for it now. Two seams had to be added to the store fake because the sweep's per-pass caches went
unguarded after the salvage was written (RUFU-584): `workflowSelectionEpoch` is read next to
`workflowDefinitionEpoch`, and the board read is now a slim projection, so `listTasks` must not hand
the sweep the same object `getTask` answers for the durable row. Line-number citations inherited from
the salvage were dropped rather than re-verified — symbol anchors are the ones that survive a move.
*/

const IR = getBuiltinWorkflow("builtin:coding")!.ir;
const SELECTION_STEP_IDS = ["code-review"];
const REQUIRED = resolveRequiredPreMergeStepIds(IR, SELECTION_STEP_IDS);
const REVIEW_COLUMNS = new Set(["in-review"]);
const CURRENT_FP = "fp-current";
const ROOT_DIR = "/tmp/rufu739-review-advance";

const seams = vi.hoisted(() => ({
  capture: vi.fn(),
  rerouteStale: vi.fn(),
  rerouteUnrun: vi.fn(),
}));

vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: seams.capture }));
// The reseed/reroute modules export classifiers and constants the sweep also imports, so only the
// one routed function each test observes is overridden; the rest of the module stays real.
vi.mock("../merge/stale-content-review-reroute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/stale-content-review-reroute.js")>()),
  rerouteSingularStaleContentToReview: seams.rerouteStale,
}));
vi.mock("../merge/pre-merge-gate-reseed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/pre-merge-gate-reseed.js")>()),
  rerouteUnrunPreMergeGateToReview: seams.rerouteUnrun,
}));

/** The delivered verdict the map is about: an authored APPROVE bound to the content being merged. */
function codeReviewApprove(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    phase: "pre-merge",
    status: "passed",
    reviewKind: "code",
    verdict: "APPROVE",
    reviewInputFingerprint: CURRENT_FP,
    completedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

/** A failed NON-required pre-merge row: it is outside the selection, so the required set still
 *  approves and only the failed-row scan can refuse — the exact third blocker reason. */
function failedExtraPreMergeRow(): WorkflowStepResult {
  return {
    workflowStepId: "browser-verification",
    phase: "pre-merge",
    status: "failed",
    output: "screen recordings unavailable",
    completedAt: "2026-09-15T00:00:00.000Z",
  };
}

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-739-advance",
    title: "Delivered reviewer APPROVE does not durably advance",
    description: "",
    column: "in-review",
    status: null,
    paused: false,
    autoMerge: true,
    mergeRetries: 0,
    worktree: ROOT_DIR,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: [...SELECTION_STEP_IDS],
    workflowStepResults: [codeReviewApprove()],
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** Live-object TaskStore fake for `recoverMergeableReviewTasks`, in the idiom the current sibling
 *  sweep test proves: EventEmitter base, real `updateTaskAtomic` semantics, and every seam the
 *  widened sweep resolves (workflow selection, IR definitions, work items, merge queue, agent logs).
 *  Both per-pass epoch counters are stated because `batchWorkflowIrCache()` and the selection cache
 *  read them unguarded; a fake missing one reduces the whole sweep to a caught `log.warn`, which is
 *  how a sibling suite once asserted on a sweep that never ran (RUFU-584). */
function sweepStore(live: Task, extra: Record<string, unknown> = {}) {
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    // The board read is a PROJECTION: `listTasks({ slim: true, excludeLog: true })` answers a copy
    // with no log, while `getTask` answers the durable row. Sharing one object would let the sweep
    // decide from state the durable row never had.
    listTasks: vi.fn(async (options?: { column?: string }) => (options?.column === "in-review" ? [{ ...live, log: [] }] : [])),
    getTask: vi.fn(async (id: string) => (id === live.id ? live : undefined)),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(live, patch); return live; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Record<string, unknown> | null) => {
      const patch = await updater(live);
      if (patch) Object.assign(live, patch);
      return live;
    }),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [...SELECTION_STEP_IDS] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [...SELECTION_STEP_IDS] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: IR }]),
    // The batch IR and selection caches are epoached: they re-read only when these counters move.
    // No case here writes a definition or a selection mid-pass, so a constant epoch is the honest fake.
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true })),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    peekMergeQueue: vi.fn(async () => []),
    getAgentLogs: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    ...extra,
  }) as unknown as EventEmitter & Record<string, any>;
  return store;
}

/** The capture seam is the only content truth the sweep sees; each test fixes what it returns. */
function captureFingerprint(fingerprint = CURRENT_FP) {
  seams.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint } });
}

/** Door inputs the recovery sites forward in parity (required-gate ids + the same content). */
function doorInputs(task: Task, fingerprint = CURRENT_FP) {
  return getTaskMergeBlocker(task, {
    reviewColumns: REVIEW_COLUMNS,
    requiredPreMergeStepIds: REQUIRED,
    mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint } } as never,
  });
}

function runSweep(live: Task, options: { store?: EventEmitter & Record<string, any>; enqueueMerge?: () => boolean } = {}) {
  const enqueueMerge = options.enqueueMerge ?? vi.fn(() => true);
  const manager = new SelfHealingManager(options.store ?? sweepStore(live), {
    rootDir: ROOT_DIR,
    enqueueMerge,
  } as never);
  return { manager, enqueueMerge };
}

beforeEach(() => {
  seams.capture.mockReset();
  seams.rerouteStale.mockReset();
  seams.rerouteUnrun.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("review-verdict advance / deferral boundary through merge recovery (RUFU-225 → RUFU-739)", () => {
  it("advances a card whose delivered APPROVE is bound to the current content — sweep and door agree", async () => {
    captureFingerprint(CURRENT_FP);
    const task = reviewTask();
    const { manager, enqueueMerge } = runSweep(task);

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).toHaveBeenCalledTimes(1);
    expect(enqueueMerge).toHaveBeenCalledWith(task.id);
    // The pair-agreement leg: the sweep advanced exactly the card the door clears.
    expect(doorInputs(task)).toBeUndefined();
  });

  it("declines the card the door refuses on the failed-pre-merge family, and advances it once that row is gone", async () => {
    captureFingerprint(CURRENT_FP);
    const task = reviewTask({ workflowStepResults: [codeReviewApprove(), failedExtraPreMergeRow()] });
    const store = sweepStore(task);
    const { manager, enqueueMerge } = runSweep(task, { store });

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    // Deferral is a skip, not a state write: no park, no replan, no retry burn by this sweep.
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    // Authority leg (no sentence anywhere): the door refuses this card, and what it returns belongs
    // to the failed-pre-merge family the map defers on.
    const blocker = doorInputs(task);
    expect(blocker).toBeDefined();
    expect(isPreMergeGateFailedBlocker(blocker as string)).toBe(true);

    // Non-vacuity: the same card minus the extra failed row advances on the very next sweep.
    task.workflowStepResults = [codeReviewApprove()];
    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).toHaveBeenCalledTimes(1);
    expect(enqueueMerge).toHaveBeenCalledWith(task.id);
    expect(doorInputs(task)).toBeUndefined();
  });

  it("routes an APPROVE bound to DIFFERENT content to the stale-content owner instead of advancing it", async () => {
    captureFingerprint(CURRENT_FP);
    seams.rerouteStale.mockResolvedValue({ handled: true, seeded: false });
    const task = reviewTask({ workflowStepResults: [codeReviewApprove({ reviewInputFingerprint: "fp-old" })] });
    const { manager, enqueueMerge } = runSweep(task);

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    expect(seams.rerouteStale).toHaveBeenCalledTimes(1);
    expect(isPreMergeGateFailedBlocker(doorInputs(task) as string) || doorInputs(task) !== undefined).toBe(true);
  });

  it("never advances a passed APPROVE that carries no content fingerprint (unprovable content)", async () => {
    captureFingerprint(CURRENT_FP);
    seams.rerouteStale.mockResolvedValue({ handled: false, seeded: false });
    const task = reviewTask({ workflowStepResults: [codeReviewApprove({ reviewInputFingerprint: undefined })] });
    const { manager, enqueueMerge } = runSweep(task);

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    expect(seams.rerouteStale).not.toHaveBeenCalled();
    expect(doorInputs(task)).toBeDefined();
  });

  it("routes a card whose required gate never ran to the not-run reseed owner instead of advancing it", async () => {
    captureFingerprint(CURRENT_FP);
    seams.rerouteUnrun.mockResolvedValue({ rerouted: true });
    const task = reviewTask({ workflowStepResults: [] });
    const { manager, enqueueMerge } = runSweep(task);

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    expect(seams.rerouteUnrun).toHaveBeenCalledTimes(1);
  });

  it("does not touch a card with a live executing session (upstream of the merge gate)", async () => {
    captureFingerprint(CURRENT_FP);
    const task = reviewTask();
    const { manager, enqueueMerge } = runSweep(task);
    (manager as unknown as { options: Record<string, unknown> }).options.getExecutingTaskIds = () => new Set([task.id]);

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    // Excluded upstream of content truth: the sweep never captured content for this card.
    expect(seams.capture).not.toHaveBeenCalled();
  });

  it("does not double-advance a card the merge lane already owns", async () => {
    captureFingerprint(CURRENT_FP);
    const task = reviewTask();
    const store = sweepStore(task, { peekMergeQueue: vi.fn(async () => [{ taskId: task.id }]) });
    const { manager, enqueueMerge } = runSweep(task, { store });

    await manager.recoverMergeableReviewTasks();

    expect(enqueueMerge).not.toHaveBeenCalled();
    // It WAS a genuine advance candidate — only queue ownership suppressed the second enqueue.
    expect(seams.capture).toHaveBeenCalled();
  });

  /*
  FNXC:ReviewVerdictAdvance 2026-10-15-16:55 (RUFU-294 salvage adaptation):
  The map's other half is structural: the review-lane DISPATCH owner decides who runs a review, never
  whether the card may leave the lane. It is the in-side authority named in docs/architecture.md, so
  the invariant worth pinning is that it has no forward-advance surface at all — a code construct, not
  prose. Upstream pinned a class that no longer exists; this pins the current module's exports.
  */
  it("gives the review-lane dispatch owner no forward-advance surface (in-side authority only)", () => {
    const advanceSurface = Object.keys(reviewDispatchSweep).filter((name) => /move|advance|merge|enqueue|complete/i.test(name));
    expect(advanceSurface).toEqual([]);
    // And the authority itself is present, so the pin above is not passing because the module is empty.
    expect(Object.keys(reviewDispatchSweep)).toEqual(expect.arrayContaining(["classifyReviewCard", "resolveReviewSlot"]));
  });
});
