/*
FNXC:OverlapScheduling 2026-11-21-10:26 (RUFU-832):

THE INVARIANT THIS FILE OWNS: a card in a review-trait lane owns no file-scope lease.

WHY IT EXISTS, measured on the board and not theorised: a card whose work was finished and merged left
its row in the review lane, `autoMerge:false` or a review remediation keeping it there with its
checkout retained. Every planner-lane card naming it as a dependency was then refused at three doors
at once. The scheduler's admission gate classified that holder as an active lease and suspended the
run; the store's repair boundary answered `scopes-still-overlap` so the repair released nothing; the
gridlock detector found no edge to break because the holder itself was waiting on nothing. Three
owners, each waiting on another, and a planning lane that accumulated 140 parked continuations behind
three such holders. No timer could shorten it: the review lane is terminal-until-merged, so the
landed-card case had literally no release authority — only an operator clicking Clear, or deleting
the card, ended the episode.

The disagreement was never about who may edit a file. `getTaskWorkingPaths` already excludes landed
work, so the merge side had stopped treating a review card's paths as claimed long before the
scheduler side had. This file pins the two classifiers to one answer and keeps the answer from
drifting back.

WHAT THIS FILE DOES NOT RELAX:
  - WIP claims its files (no checkout question asked — the scheduler moves a card there before a
    checkout exists, and gating that interval is how two cards start editing the same files);
  - a hold-lane card that still owns an unmerged checkout keeps its dormant lease;
  - a landed card (`mergeConfirmed`) releases, as it always did.
The controls below assert all three, because a test that only checks the new answer cannot tell a
lane rule from a fixture that stopped meaning anything.

NON-GOALS pinned here too: releasing a lease is a SCHEDULING decision. Nothing in this file moves a
card, writes a lease-release receipt, touches a branch, worktree, step, or gate result, or grants any
new wake authority — the review-lane entry itself wakes nobody (pinned in
`workflow-file-scope-continuation-wake.test.ts`); only the terminal fan-out still does.
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { classifyFileScopeLease, Scheduler } from "../scheduler.js";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import { SelfHealingManager } from "../self-healing.js";
import { releaseFileScopeWaitingContinuations } from "../runtimes/in-process-runtime.js";

const NOW = "2026-11-21T12:00:00.000Z";
const SHARED_SCOPE = ["packages/core/src/store.ts"];

/* The wait reason a parked continuation records, matching `fileScopeContinuationWaitReason` in
   runtimes/in-process-runtime.ts. Inlined because the producer keeps it module-private; if it ever
   changes shape the drain test below fails loudly rather than silently releasing nothing. */
const fileScopeWaitReason = (blockerId: string): string => `file-scope:${blockerId}`;

function card(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    status: null,
    paused: false,
    userPaused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

/** The shape from the board: review lane, checkout retained, no auto-merge, operator-held. */
function reviewHolder(id = "FN-HOLDER"): Task {
  return card(id, {
    worktree: "/wt/fn-holder",
    branch: `fusion/${id.toLowerCase()}`,
    autoMerge: false,
    userPaused: true,
    workspaceWorktrees: undefined,
  });
}

/**
 * The scheduler classifier reads role questions either from literals or from caller-supplied
 * resolved answers. Both forms are exercised: the literal one is what an unresolved-workflow caller
 * uses, the resolved one is what a board whose review lane carries another name answers.
 *
 * The repair boundary's twin (`classifyRepairFileScopeLease` in @fusion/core's store) is NOT reachable
 * from this package — it is not part of the core entry points — so its half of the parity claim is
 * pinned beside it, in `store-overlap-repair-lanes-resolved.test.ts`, together with the controls that
 * keep WIP claiming and a retained hold-lane checkout dormant.
 */
function schedulerAnswer(holder: Task, tasks: Task[], options?: Parameters<typeof classifyFileScopeLease>[2]) {
  return classifyFileScopeLease(holder, tasks, options);
}

describe("RUFU-832 review-lane file-scope lease release", () => {
  describe("both classifiers answer `none` for a review-trait lane", () => {
    /*
    Every status a review-lane card can legitimately carry. The old answer differed per status only by
    accident (the checkout question was asked at different points), which is why "it depends on status"
    is not a legal answer here: the release is about the lane, not about what the card last did.
    */
    it.each([
      ["no status", null],
      ["failed review remediation", "failed"],
      ["queued for the merger", "queued"],
      ["merge in flight metadata", "merging"],
      ["planning bounce", "planning"],
    ])("scheduler classifier: a card in review carrying %s owns no lease", (_label, status) => {
      const holder = reviewHolder();
      holder.status = status as Task["status"];

      expect(schedulerAnswer(holder, [holder])).toEqual({ kind: "none", waivedForTaskIds: [] });
    });

    it("scheduler classifier: a renamed review-role lane answers the same as the literal lane", () => {
      /*
      A caller that resolved its workflow passes role ANSWERS, not column ids, so a board whose review
      lane is called `signoff` reaches the same branch. The card here deliberately does NOT sit in a
      column named `in-review`: only the resolved answer can make it release.
      */
      const holder = card("RUFU-700", { column: "signoff", worktree: "/wt/rufu-700", autoMerge: false });

      expect(classifyFileScopeLease(holder, [holder], { isReviewColumn: true }))
        .toEqual({ kind: "none", waivedForTaskIds: [] });
      // And the same card with the lane unresolved is NOT a release - the answer comes from the lane.
      expect(classifyFileScopeLease(holder, [holder]).kind).not.toBe("none");
    });

    it("a card the scheduler would not move is still no blocker: review releases whatever the row says", () => {
      /*
      The pair of statuses the old answer leaned on hardest. A review card parked by a failed
      remediation, an operator pause, or `autoMerge:false` keeps its checkout and its lane indefinitely
      — that permanence is precisely why its lane may not keep a claim over files another card needs.
      */
      const remediation = reviewHolder();
      remediation.status = "failed";
      const operatorHeld = reviewHolder();
      operatorHeld.paused = true;

      expect(schedulerAnswer(remediation, [remediation]).kind).toBe("none");
      expect(schedulerAnswer(operatorHeld, [operatorHeld]).kind).toBe("none");
    });

    it("controls: WIP claims without being asked, a retained hold-lane checkout stays dormant, landed releases", () => {
      /*
      The half that keeps this card from being "everything releases". WIP answers active with no
      checkout at all (the scheduler moves a card there before a checkout exists), and a hold-lane card
      that still owns unmerged work keeps its dormant claim. Deleting those checkouts stays the
      explicit escape hatch for a dead holder.
      */
      const wip = card("FN-WIP", { column: "in-progress", worktree: undefined });
      const dormant = card("FN-DORMANT", { column: "todo", worktree: "/wt/fn-dormant" });
      const landed = card("FN-LANDED", { column: "in-progress", worktree: "/wt/fn-landed", mergeDetails: { mergeConfirmed: true } });

      expect(schedulerAnswer(wip, [wip]).kind).toBe("active");
      expect(schedulerAnswer(dormant, [dormant]).kind).toBe("dormant");
      expect(schedulerAnswer(landed, [landed]).kind).toBe("none");
    });

    it("release is a scheduling answer only: pause, autoMerge and the retained checkout do not change it", () => {
      const holder = reviewHolder();
      const untouched = JSON.stringify({
        column: holder.column, worktree: holder.worktree, branch: holder.branch,
        userPaused: holder.userPaused, autoMerge: holder.autoMerge,
      });

      expect(schedulerAnswer(holder, [holder]).kind).toBe("none");
      expect(JSON.stringify({
        column: holder.column, worktree: holder.worktree, branch: holder.branch,
        userPaused: holder.userPaused, autoMerge: holder.autoMerge,
      })).toBe(untouched);
    });
  });

  describe("the dispatch door stops refusing work behind a review holder", () => {
    function gateStore(tasks: Task[], scopes: Record<string, string[]>): TaskStore {
      return {
        getSettings: vi.fn(async () => ({ groupOverlappingFiles: true } as Settings)),
        listTasks: vi.fn(async () => tasks),
        parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
        getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
        getRootDir: vi.fn(() => "/nonexistent-fusion-root"),
        transitionQueuedEpisode: vi.fn(async () => ({ appended: true, task: tasks[0] })),
      } as unknown as TaskStore;
    }

    it("admits a planner-lane candidate whose only overlapping holder sits in review (and queues no stamp)", async () => {
      const holder = reviewHolder();
      const candidate = card("FN-CANDIDATE", { column: "todo" });
      const store = gateStore([holder, candidate], {
        [holder.id]: SHARED_SCOPE,
        [candidate.id]: SHARED_SCOPE,
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate))
        .resolves.toBe(false);

      /*
      The half that matters most: no `transitionQueuedEpisode` call means no `queued` status write and
      no "waiting for file-scope lease" History line. Those are exactly what made each parked card look
      like it had a legitimate reason to be waiting, and what made a full planning lane look normal.
      */
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    });

    it("admits a workspace candidate behind a workspace review holder whose repository checkout exists", async () => {
      const holder = card("FN-WS-HOLDER", {
        column: "in-review",
        autoMerge: false,
        workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-ws-holder/repo-a" } } as Task["workspaceWorktrees"],
      });
      const candidate = card("FN-WS-CANDIDATE", { column: "todo" });
      const store = gateStore([holder, candidate], {
        [holder.id]: ["repo-a/src/shared.ts"],
        [candidate.id]: ["repo-a/src/shared.ts"],
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate))
        .resolves.toBe(false);
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    });

    it("control: the same candidate is still held behind a WIP holder and gets exactly one queue stamp", async () => {
      const holder = card("FN-WIP-HOLDER", { column: "in-progress", worktree: "/wt/fn-wip-holder" });
      const candidate = card("FN-CANDIDATE", { column: "todo" });
      const store = gateStore([holder, candidate], {
        [holder.id]: SHARED_SCOPE,
        [candidate.id]: SHARED_SCOPE,
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate))
        .resolves.toBe(true);
      expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
        overlapBlockedBy: holder.id,
      }));
    });

    /*
    FNXC:OverlapScheduling 2026-11-21-10:26 (RUFU-832):
    The dormant tier is the OTHER half of "the lease means a write claim". A card parked in a hold lane
    that still owns an unmerged checkout wrote something and did not land it, so it keeps its claim and
    is arbitrated by queue order rather than by strength. This pair is here because the review release
    must not have quietly dissolved the whole mechanism: the two fixtures differ only in lane.
    */
    it("keeps arbitrating a senior dormant peer by queue order while the identical review peer releases", async () => {
      const candidate = card("FN-CANDIDATE", { column: "todo", createdAt: "2026-01-02T00:00:00.000Z" });
      const dormant = card("FN-DORMANT", {
        column: "todo", worktree: "/wt/fn-dormant", createdAt: "2026-01-01T00:00:00.000Z",
      });
      const dormantStore = gateStore([dormant, candidate], {
        [dormant.id]: SHARED_SCOPE,
        [candidate.id]: SHARED_SCOPE,
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store: dormantStore, getRunContextFor: () => undefined }, candidate))
        .resolves.toBe(true);
      expect(dormantStore.transitionQueuedEpisode).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
        overlapBlockedBy: dormant.id,
      }));

      const reviewPeer = card("FN-REVIEW-PEER", {
        column: "in-review", worktree: "/wt/fn-review-peer", createdAt: "2026-01-01T00:00:00.000Z", autoMerge: false,
      });
      const reviewCandidate = card("FN-CANDIDATE", { column: "todo", createdAt: "2026-01-02T00:00:00.000Z" });
      const reviewStore = gateStore([reviewPeer, reviewCandidate], {
        [reviewPeer.id]: SHARED_SCOPE,
        [reviewCandidate.id]: SHARED_SCOPE,
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store: reviewStore, getRunContextFor: () => undefined }, reviewCandidate))
        .resolves.toBe(false);
      expect(reviewStore.transitionQueuedEpisode).not.toHaveBeenCalled();
    });

    /*
    The candidate-side guards are untouched by this card and are asserted with a WIP holder present, so
    a release could not be mistaken for "the gate stopped asking questions": a candidate with nothing to
    write is never stamped no matter who holds the files.
    */
    it.each([
      ["an empty declared scope", [] as string[]],
      ["a coordination-only scope", ["docs/architecture.md"] as string[]],
    ])("never stamps a candidate whose only work is %s, even behind a WIP holder", async (_label, scope) => {
      const holder = card("FN-WIP-HOLDER", { column: "in-progress", worktree: "/wt/fn-wip-holder" });
      const candidate = card("FN-CANDIDATE", { column: "todo", noCommitsExpected: true });
      const store = gateStore([holder, candidate], {
        [holder.id]: SHARED_SCOPE,
        [candidate.id]: scope,
      });

      await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate))
        .resolves.toBe(false);
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    });
  });

  /*
  FNXC:OverlapScheduling 2026-11-21-10:26 (RUFU-832):
  THE PROTECTED NON-LEASE SURFACE. Base-branch stacking also looks at review-lane predecessors, and it
  must keep doing so: stacking reads the predecessor's BRANCH, which is exactly the artifact this card
  refuses to stop retaining. If a future edit "simplified" the review lane by dropping its worktree or
  branch, this is the assertion that would catch it — the release is about who may edit files, never
  about what the merge is allowed to build on.
  */
  describe("the review-lane branch stays a base for stacking", () => {
    function schedulerProbe(): Scheduler {
      const store = {
        getSettings: vi.fn(async () => ({}) as Settings),
        getRootDir: vi.fn(() => "/nonexistent-fusion-root"),
        listTasks: vi.fn(async () => []),
        // The Scheduler constructor subscribes to the store bus; nothing here emits.
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      } as unknown as TaskStore;
      return new Scheduler(store);
    }

    it("still resolves a review-lane predecessor's branch for its dependent", () => {
      const scheduler = schedulerProbe() as unknown as {
        resolveBaseBranch: (task: Task, all: Task[], isReview: (candidate: Task) => boolean) => string | null;
      };
      const predecessor = reviewHolder();
      const dependent = card("FN-DEPENDENT", { column: "todo", dependencies: [predecessor.id] });
      const isReviewLane = (candidate: Task): boolean => candidate.column === "in-review";

      expect(scheduler.resolveBaseBranch(dependent, [predecessor, dependent], isReviewLane))
        .toBe(predecessor.branch);

      // And the paired negative: an unmerged-less review card supplies nothing, which is unchanged.
      const barePredecessor = { ...predecessor, worktree: undefined };
      expect(scheduler.resolveBaseBranch(
        dependent, [barePredecessor, dependent], isReviewLane,
      )).toBeNull();
    });
  });

  describe("a waiter already parked by the old answer drains without an operator", () => {
    /*
    The recovery half. Releasing the classifier only helps a card that has not been parked yet, so
    these cases start from the parked state the incident left behind: `overlapBlockedBy` naming a
    review-lane holder, the continuation `held` on the `file-scope:` reason. Both production entry
    points run for real — `SelfHealingManager.clearStaleBlockedBy()` for the row marker and
    `releaseFileScopeWaitingContinuations` for the continuation, which is exactly what the runtime
    wires behind `onOverlapBlockersReleased`.
    */
    function drainStore(tasks: Task[], workItems: Array<Record<string, unknown>>) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const store = {
        workflowDefinitionEpoch: () => 0,
        getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, groupOverlappingFiles: true } as Settings)),
        listTasks: vi.fn(async () => [...byId.values()]),
        getTask: vi.fn(async (id: string) => byId.get(id)),
        getTasksDir: vi.fn(() => "/tmp/rufu-832/.fusion/tasks"),
        parseFileScopeFromPrompt: vi.fn(async () => SHARED_SCOPE),
        getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
        updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
          const next = { ...byId.get(id)!, ...patch } as Task;
          byId.set(id, next);
          return next;
        }),
        updateTaskAtomic: vi.fn(async (id: string, build: (live: Task) => Partial<Task> | null) => {
          const patch = build(byId.get(id)!);
          if (!patch) return byId.get(id)!;
          const next = { ...byId.get(id)!, ...patch } as Task;
          byId.set(id, next);
          return next;
        }),
        logEntry: vi.fn(async () => undefined),
        recordRunAuditEvent: vi.fn(async () => undefined),
        listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) => workItems.filter((item) => item.taskId === taskId)),
        transitionWorkflowWorkItem: vi.fn(async (itemId: string, state: string, patch: Record<string, unknown>) => {
          const item = workItems.find((candidate) => candidate.id === itemId);
          if (!item) return null;
          if (patch.expectedState !== undefined && item.state !== patch.expectedState) return item;
          Object.assign(item, patch, { state });
          return item;
        }),
        moveTask: vi.fn(),
        moveTaskIf: vi.fn(),
      };
      return { store: store as unknown as TaskStore, byId, workItems };
    }

    it("clears the row marker for a waiter whose only holder is a review card that kept its checkout", async () => {
      const holder = reviewHolder();
      const waiter = card("FN-WAITER", { column: "todo", status: "queued", overlapBlockedBy: holder.id });
      const { store, byId } = drainStore([holder, waiter], []);
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-832" });

      await manager.clearStaleBlockedBy();

      expect(byId.get(waiter.id)!.overlapBlockedBy).toBeNull();
      // Nothing moved, nothing was fabricated: the holder keeps its lane, checkout, branch and receipt.
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.moveTaskIf).not.toHaveBeenCalled();
      expect(byId.get(holder.id)!.fileScopeLeaseRelease).toBeUndefined();
      expect(byId.get(holder.id)).toMatchObject({ column: "in-review", worktree: "/wt/fn-holder" });
    });

    it("drains the parked continuation once its marker is clear, and refuses while it is not", async () => {
      const holder = reviewHolder();
      const waiter = card("FN-WAITER", { column: "todo", status: "queued", overlapBlockedBy: holder.id });
      const item = {
        id: `${waiter.id}:builtin:coding:plan`,
        taskId: waiter.id,
        kind: "task",
        state: "held",
        leaseOwner: null,
        blockedReason: fileScopeWaitReason(holder.id),
      };
      const { store, workItems } = drainStore([holder, waiter], [item]);
      const releases = [{ taskId: waiter.id, blockerId: holder.id }];

      // Gated on the committed marker clear: a waiter still blocked at row level stays parked.
      await expect(releaseFileScopeWaitingContinuations(store, releases)).resolves.toEqual([]);
      expect(workItems[0].state).toBe("held");

      await store.updateTask(waiter.id, { overlapBlockedBy: null });

      await expect(releaseFileScopeWaitingContinuations(store, releases)).resolves.toEqual([item.id]);
      expect(workItems[0]).toMatchObject({ state: "runnable", leaseOwner: null, blockedReason: null });
    });

    it("control: a continuation waiting on a holder that still claims is not released by the drain", async () => {
      const wipHolder = card("FN-WIP-HOLDER", { column: "in-progress", worktree: "/wt/fn-wip-holder" });
      const waiter = card("FN-WAITER", { column: "todo", status: "queued", overlapBlockedBy: wipHolder.id });
      const item = {
        id: `${waiter.id}:builtin:coding:plan`,
        taskId: waiter.id,
        kind: "task",
        state: "held",
        leaseOwner: null,
        blockedReason: fileScopeWaitReason(wipHolder.id),
      };
      const { store } = drainStore([wipHolder, waiter], [item]);

      await expect(releaseFileScopeWaitingContinuations(store, [{ taskId: waiter.id, blockerId: wipHolder.id }]))
        .resolves.toEqual([]);
      expect(item.state).toBe("held");
    });
  });
});
