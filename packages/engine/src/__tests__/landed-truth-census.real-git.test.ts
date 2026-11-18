/*
FNXC:LandedTruthCensus 2026-11-05-17:20 (RUFU-702):
Sweep-level pin for the census that re-proves every complete-role card's delivery claim, executed against
REAL git repositories. Canned git mocks cannot pin this arm: the whole point of the census is that it must
leave a genuinely squash-delivered card alone while naming a card whose recorded sha never reached `main`,
and only real `merge-base` / `cherry` / `ls-tree` behaviour distinguishes those two shapes (RUFU-450's
erratum measured `git cherry` reporting every commit `+` on an already-delivered branch, which is precisely
the false positive a mock would happily invent).

The arm is report-only by project policy — lifecycle containment (FN-207/FN-217) forbids an automatic move
backward out of a terminal lane — so the assertions here are the finding's three surfaces (row-unmoving,
History line, bounded audit row, mailbox notice) plus the one automatic repair that IS allowed: clearing a
stale unproven-landing hold the moment the repository agrees the commit is on the default branch.
*/
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MergeDetails, Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { LANDING_PROOF_UNPROVEN_ERROR_PREFIX } from "@fusion/core";

const NOW = "2026-11-05T17:20:00.000Z";

let repo = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

/** Commit on `main` directly, returning the new sha. */
function commitOnMain(file: string, body: string): string {
  writeFileSync(join(repo, file), body, "utf-8");
  git("add", "-A");
  git("commit", "-m", `chore: seed ${file}`);
  return git("rev-parse", "HEAD");
}

/** Build a task branch with one commit of its own and return its tip sha. */
function buildTaskBranch(branch: string, file: string, stamp: string): string {
  git("checkout", "-B", branch, "main");
  writeFileSync(join(repo, file), `content of ${stamp}\n`, "utf-8");
  git("add", "-A");
  git("commit", "-m", `feat(${branch}): deliver ${stamp}\n\nFusion-Task-Id: ${branch.replace("fusion/", "").toUpperCase()}`);
  const sha = git("rev-parse", "HEAD");
  git("checkout", "main");
  return sha;
}

function mergeDetailsFor(sha: string): MergeDetails {
  return { commitSha: sha, mergedAt: NOW, insertions: 3, deletions: 0 } as MergeDetails;
}

function card(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "delivery claim under census",
    column: "done",
    status: null,
    paused: false,
    userPaused: false,
    branch: `fusion/${id.toLowerCase()}`,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

function createStore(initialTasks: Task[], prEntities: Record<string, unknown> = {}) {
  const tasks = new Map(initialTasks.map((task) => [task.id, { ...task }]));
  const settings = {
    globalPause: false,
    enginePaused: false,
    autoMerge: true,
    maintenanceIntervalMs: 0,
  } as Settings;

  const logEntry = vi.fn(async () => undefined);
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const updateTaskAtomic = vi.fn(async (id: string, mutate: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
    const current = tasks.get(id);
    if (!current) return null;
    const patch = await mutate({ ...current } as Task);
    if (!patch) return null;
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      const values = [...tasks.values()].filter((task) => !task.deletedAt);
      return column ? values.filter((task) => task.column === column) : values;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    /*
    The census stamps its "already announced in this episode" marker through `sourceMetadataPatch`, which the
    real store merges at KEY level (RUFU-246) — the other provenance keys on the same jsonb survive. A fake
    that spread the patch over the whole column would make every episode write look like a clobber, and the
    dedupe it is supposed to prove could never be observed.
    */
    updateTask: vi.fn(async (id: string, patch: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const { sourceMetadataPatch, ...rest } = patch;
      const next = {
        ...current,
        ...rest,
        ...(sourceMetadataPatch
          ? {
            sourceMetadata: {
              ...((current as { sourceMetadata?: Record<string, unknown> }).sourceMetadata ?? {}),
              ...sourceMetadataPatch,
            },
          }
          : null),
      } as Task;
      tasks.set(id, next);
      return next;
    }),
    // The authoritative PR surface the census consults before the legacy `prInfo` mirror (RUFU-702 P1).
    getActivePrEntityBySource: vi.fn(async (_source: string, id: string) => prEntities[id] ?? null),
    updateTaskAtomic,
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id)!;
      const next = { ...current, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry,
    recordRunAuditEvent,
    parseFileScopeFromPrompt: vi.fn(async () => [] as string[]),
    recordAgentActivity: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
  }) as unknown as TaskStore & EventEmitter;

  return { store, tasks, logEntry, recordRunAuditEvent, updateTaskAtomic };
}

function managerFor(store: TaskStore & EventEmitter, rootDir: string, messageStore?: unknown) {
  return new SelfHealingManager(store, {
    rootDir,
    messageStore: messageStore as never,
    getExecutingTaskIds: () => new Set<string>(),
  });
}

function auditRows(recordRunAuditEvent: ReturnType<typeof vi.fn>, mutationType: string) {
  return recordRunAuditEvent.mock.calls
    .map((call) => (call[0] ?? call[1]) as { mutationType?: string; metadata?: Record<string, unknown> })
    .filter((event) => event?.mutationType === mutationType);
}

function messagesFor(logEntry: ReturnType<typeof vi.fn>): string[] {
  return logEntry.mock.calls.map((call) => String(call[1] ?? ""));
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "fusion-landed-truth-"));
  git("init", "-b", "main");
  git("config", "user.email", "census@test.invalid");
  git("config", "user.name", "Census Test");
  commitOnMain("README.md", "seed\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("reconcileLandedTruth — the default branch is the yardstick for a done card", () => {
  it("names a done card whose recorded commit never reached main, and leaves its lane untouched", async () => {
    // RUFU-294's shape: a real commit on a real task branch, recorded as landed, never merged into main.
    const foreignSha = buildTaskBranch("fusion/rufu-700", "unlanded.ts", "RUFU-700");
    const task = card("RUFU-700", { mergeDetails: mergeDetailsFor(foreignSha) });
    const { store, tasks, logEntry, recordRunAuditEvent } = createStore([task]);
    const sendMessageOnce = vi.fn(async () => true);
    const manager = managerFor(store, repo, { sendMessageOnce });
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue({
      hasVerifiedOwnLandedCommit: false,
      scopeNeverDelivered: true,
      stampedBaseCommitCount: 0,
      ownLandedCommitCount: 0,
      scopePathCount: 1,
    });

    const findings = await manager.reconcileLandedTruth();

    expect(findings).toBe(1);
    const rows = auditRows(recordRunAuditEvent, "task:done-landing-unproven");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      taskId: "RUFU-700",
      integrationBranch: "main",
      recordedSha: foreignSha,
      refusalCode: "commit-not-on-integration-branch",
      landedShaOnIntegration: 0,
      // Report-only: lifecycle containment refuses an automatic move backward out of a terminal lane.
      repairExecuted: false,
      repair: "reported",
    });
    // The refusal sentence reaches the operator through History and the mailbox, never through run-audit.
    expect(messagesFor(logEntry).some((line) => line.includes("[landed-truth-census]"))).toBe(true);
    // The row's key set is closed, so a refusal SENTENCE is unrepresentable in run-audit rather than merely
    // absent today — the sentence itself lives on the History line and the mailbox notice above.
    expect(Object.keys(rows[0]!.metadata!).sort()).toEqual([
      "branchRef", "conflictCount", "integrationBranch", "landedShaOnIntegration",
      "proofKind", "recordedSha", "refusalCode", "repair", "repairExecuted", "suppressionReason", "taskId",
    ]);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    // And the card did not move.
    expect(tasks.get("RUFU-700")!.column).toBe("done");
  });

  it("leaves a genuinely squash-delivered card alone — the mass-reopen control", async () => {
    // Squash-safe control: the branch head differs from the landed squash commit, which is the NORMAL
    // shape under the project default `always-squash`. A census that keyed on ancestry of the branch tip
    // would report every delivered card on this board.
    const branchSha = buildTaskBranch("fusion/rufu-701", "squashed.ts", "RUFU-701");
    git("merge", "--squash", branchSha);
    git("commit", "-m", "feat: squash RUFU-701\n\nFusion-Task-Id: RUFU-701");
    const squashSha = git("rev-parse", "HEAD");
    expect(squashSha).not.toBe(branchSha);

    const task = card("RUFU-701", { mergeDetails: mergeDetailsFor(squashSha), branch: "fusion/rufu-701" });
    const { store, recordRunAuditEvent, logEntry } = createStore([task]);
    const manager = managerFor(store, repo);

    await expect(manager.reconcileLandedTruth()).resolves.toBe(0);
    expect(auditRows(recordRunAuditEvent, "task:done-landing-unproven")).toHaveLength(0);
    expect(messagesFor(logEntry)).toHaveLength(0);
  });

  it("clears a stale unproven-landing hold once the repository agrees the commit is on main", async () => {
    const landedSha = commitOnMain("late-landed.ts", "landed after the refusal\n");
    const task = card("RUFU-702", {
      mergeDetails: mergeDetailsFor(landedSha),
      error: `${LANDING_PROOF_UNPROVEN_ERROR_PREFIX} commit-not-on-integration-branch — checked against \`main\`.`,
    });
    const { store, tasks, logEntry, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store, repo);

    const findings = await manager.reconcileLandedTruth();

    expect(tasks.get("RUFU-702")!.error).toBeNull();
    expect(findings).toBe(1);
    const rows = auditRows(recordRunAuditEvent, "task:done-landing-unproven");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      repairExecuted: true,
      repair: "stale-hold-cleared",
      refusalCode: null,
      integrationBranch: "main",
    });
    expect(messagesFor(logEntry).some((line) => line.includes("Landed-truth census"))).toBe(true);
  });

  it("defers rather than accuses when the delivery evidence itself cannot be read", async () => {
    // A sha the repository has never heard of is an incomplete claim, not a proven absence. Accusing the
    // card would be the inverse of the defect: a bare or half-fetched checkout manufacturing a finding.
    const task = card("RUFU-703", {
      mergeDetails: mergeDetailsFor("0000000000000000000000000000000000000000"),
    });
    const { store, tasks, recordRunAuditEvent, logEntry } = createStore([task]);
    const sendMessageOnce = vi.fn(async () => true);
    const manager = managerFor(store, repo, { sendMessageOnce });

    await expect(manager.reconcileLandedTruth()).resolves.toBe(0);
    expect(auditRows(recordRunAuditEvent, "task:done-landing-unproven")).toHaveLength(0);
    expect(messagesFor(logEntry)).toHaveLength(0);
    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(tasks.get("RUFU-703")!.column).toBe("done");
  });

  it("holds a workspace card, whose landing happened in member checkouts this pass cannot enumerate", async () => {
    const foreignSha = buildTaskBranch("fusion/rufu-704", "workspace-unlanded.ts", "RUFU-704");
    const task = card("RUFU-704", {
      mergeDetails: mergeDetailsFor(foreignSha),
      workspaceWorktrees: { "members/api": { branch: "fusion/rufu-704", path: "/tmp/does-not-matter" } },
    } as Partial<Task>);
    const { store, recordRunAuditEvent, logEntry } = createStore([task]);
    const manager = managerFor(store, repo);

    await expect(manager.reconcileLandedTruth()).resolves.toBe(0);
    expect(auditRows(recordRunAuditEvent, "task:done-landing-unproven")).toHaveLength(0);
    expect(messagesFor(logEntry)).toHaveLength(0);
  });

  it("publishes null, not zero, when the ownership proof could not be read", async () => {
    // RUFU-690's measured failure was 211 findings that read "zero delivered commits" off an unreadable
    // probe. `null` means "not probed"; collapsing it into 0 is what made that flood un-triageable.
    const foreignSha = buildTaskBranch("fusion/rufu-705", "unowned.ts", "RUFU-705");
    const task = card("RUFU-705", { mergeDetails: mergeDetailsFor(foreignSha) });
    const { store, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store, repo);
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue(null);

    await manager.reconcileLandedTruth();

    const rows = auditRows(recordRunAuditEvent, "task:done-landing-unproven");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata!.landedShaOnIntegration).toBeNull();
  });

  it("announces one card per episode window across EVERY surface, not just the mailbox", async () => {
    /*
    FNXC:LandedTruthCensus 2026-11-17-21:05 (RUFU-702, code-review P1):
    This case used to assert `sendMessageOnce` called TWICE over two passes, which was the defect stated as
    expected behaviour: the notice was idempotent per window while the History row and the audit row were
    written on every pass that re-measured the same refusal, so a `done` lane produced rows per tick forever
    with no event behind them. The widened contract is one report per episode over all three surfaces, and the
    negative half matters as much as the positive one — clearing the marker must make the card announce again
    with the same idempotent key, or the bound would just be a silent suppression.
    */
    const foreignSha = buildTaskBranch("fusion/rufu-706", "repeat.ts", "RUFU-706");
    const task = card("RUFU-706", { mergeDetails: mergeDetailsFor(foreignSha) });
    const { store, tasks, logEntry, recordRunAuditEvent } = createStore([task]);
    const sendMessageOnce = vi.fn(async () => true);
    const manager = managerFor(store, repo, { sendMessageOnce });
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue({
      hasVerifiedOwnLandedCommit: false,
      scopeNeverDelivered: true,
      stampedBaseCommitCount: 0,
      ownLandedCommitCount: 0,
      scopePathCount: 0,
    });
    const findingsFor = () => auditRows(recordRunAuditEvent, "task:done-landing-unproven")
      .filter((row) => row.metadata?.repair === "reported");
    const censusLines = () => messagesFor(logEntry).filter((line) => line.includes("[landed-truth-census]"));

    expect(await manager.reconcileLandedTruth()).toBe(1);
    // Second pass, same window: nothing new is said, and the card is not counted as a fresh finding.
    expect(await manager.reconcileLandedTruth()).toBe(0);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(findingsFor()).toHaveLength(1);
    expect(censusLines()).toHaveLength(1);

    const episode = (tasks.get("RUFU-706")!.sourceMetadata as Record<string, any>).landedTruthCensus;
    // The signature carries the refusal code, so a changed diagnosis re-announces instead of being swallowed.
    expect(episode.signature).toBe("reported:commit-not-on-integration-branch");
    expect(episode.reportCount).toBe(1);
    expect(Date.parse(episode.firstAt)).not.toBeNaN();

    // Erase the marker and the bound is gone — the card is announced again, not quietly dropped.
    tasks.set("RUFU-706", { ...tasks.get("RUFU-706")!, sourceMetadata: undefined } as Task);
    expect(await manager.reconcileLandedTruth()).toBe(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(2);
    expect(findingsFor()).toHaveLength(2);
    expect(new Set(sendMessageOnce.mock.calls.map((call) => String(call[2]))).size).toBe(1);
  });
});

/*
FNXC:LandedTruthCensus 2026-11-17-21:05 (RUFU-702, code-review P1):
The classes the census must REFUSE to judge. Each is a card whose "the default branch does not hold this
commit" is true and is not a finding: a human-terminal card (`autoMerge: false`, FN-5147) is closed by a
person, an operator-held card is frozen mid-flight under that person's judgement, and a PR-backed card's
content is owed by the HOST on its base branch — which this pass never fetches, because a census that
measures an unfetched clone manufactures findings. Judging any of them is the mass false alarm the sweep's
squash-safety rule exists to prevent, so the contract is: classified BEFORE any git runs, recorded once as a
fixed-enum `suppressed` row, and never written to the card's History or the mailbox as an accusation.
*/
describe("reconcileLandedTruth suppression — cards the census may describe but never accuse", () => {
  const prEntity = (prNumber: number) => ({
    id: `pre-${prNumber}`,
    sourceType: "task",
    sourceId: "unused",
    prNumber,
    state: "open",
    unverified: false,
  });

  function censusLines(logEntry: ReturnType<typeof vi.fn>): string[] {
    return messagesFor(logEntry).filter((line) => line.includes("[landed-truth-census]"));
  }

  function suppressedCard(id: string, sha: string, overrides: Partial<Task> = {}) {
    return card(id, { mergeDetails: mergeDetailsFor(sha), branch: `fusion/${id.toLowerCase()}`, ...overrides });
  }

  /** A complete legacy PR mirror — every required field, so no case rests on a half-built fixture. */
  function prInfoStub(number: number, status: "open" | "merged", headBranch: string) {
    return {
      url: `https://host.invalid/pull/${number}`,
      number,
      status,
      title: `PR ${number}`,
      headBranch,
      baseBranch: "main",
      commentCount: 0,
    } as Task["prInfo"];
  }

  it("suppresses a human-terminal card, an operator-held card, and a PR-backed card, with no accusation", async () => {
    const humanTerminalSha = buildTaskBranch("fusion/rufu-820", "suppress-auto-merge.ts", "RUFU-820");
    const operatorHeldSha = buildTaskBranch("fusion/rufu-821", "suppress-held.ts", "RUFU-821");
    const prBackedSha = buildTaskBranch("fusion/rufu-822", "suppress-pr.ts", "RUFU-822");
    const tasks = [
      suppressedCard("RUFU-820", humanTerminalSha, { autoMerge: false }),
      suppressedCard("RUFU-821", operatorHeldSha, { paused: true }),
      suppressedCard("RUFU-822", prBackedSha, { prInfo: prInfoStub(42, "open", "fusion/rufu-822") }),
    ];
    const { store, recordRunAuditEvent, logEntry } = createStore(tasks, { "RUFU-822": prEntity(42) });
    const sendMessageOnce = vi.fn(async () => true);
    const manager = managerFor(store, repo, { sendMessageOnce });
    const probe = vi.spyOn(manager as any, "baseDeliveryEvidence");

    await expect(manager.reconcileLandedTruth()).resolves.toBe(0);

    const rows = auditRows(recordRunAuditEvent, "task:done-landing-unproven");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.metadata?.suppressionReason).sort()).toEqual([
      "human-terminal-auto-merge-off", "operator-held", "pr-backed",
    ]);
    for (const row of rows) {
      // Nothing was measured, so every measurement key answers `null` rather than going missing, and nothing
      // was repaired or moved: `suppressed` is a description of the card, never a verdict on its delivery.
      expect(row.metadata).toMatchObject({
        repair: "suppressed",
        repairExecuted: false,
        refusalCode: null,
        proofKind: null,
        conflictCount: null,
        landedShaOnIntegration: null,
      });
    }
    // The closed key set of a suppressed row — the refusal SENTENCE has nowhere to live.
    expect(Object.keys(rows[0]!.metadata!).sort()).toEqual([
      "branchRef", "conflictCount", "integrationBranch", "landedShaOnIntegration", "proofKind",
      "recordedSha", "refusalCode", "repair", "repairExecuted", "suppressionReason", "taskId",
    ]);
    // No accusation reaches the card or the operator, and no ownership probe ran at all.
    expect(censusLines(logEntry)).toHaveLength(0);
    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("reads the legacy prInfo mirror when no PR entity exists, and never treats a closed PR as a vehicle", async () => {
    // Two cards, one difference: an open PR mirror is the host's obligation, a merged one is a finished
    // claim that must go back to being measured like any direct merge.
    const openSha = buildTaskBranch("fusion/rufu-823", "pr-open.ts", "RUFU-823");
    const closedSha = buildTaskBranch("fusion/rufu-824", "pr-closed.ts", "RUFU-824");
    const openCard = suppressedCard("RUFU-823", openSha, { prInfo: prInfoStub(7, "open", "fusion/rufu-823") });
    const closedCard = suppressedCard("RUFU-824", closedSha, { prInfo: prInfoStub(8, "merged", "fusion/rufu-824") });
    const { store, recordRunAuditEvent } = createStore([openCard, closedCard]);
    const manager = managerFor(store, repo);
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue(null);

    await manager.reconcileLandedTruth();

    const rowsFor = (id: string) => auditRows(recordRunAuditEvent, "task:done-landing-unproven")
      .filter((row) => row.metadata?.taskId === id);
    expect(rowsFor("RUFU-823")[0]!.metadata).toMatchObject({
      repair: "suppressed", suppressionReason: "pr-backed",
    });
    // A merged PR is not a live vehicle, so this card is measured — and its sha really is absent from main.
    expect(rowsFor("RUFU-824")[0]!.metadata).toMatchObject({
      repair: "reported", suppressionReason: null, refusalCode: "commit-not-on-integration-branch",
    });
  });

  it("suppresses once per (card, reason) instead of re-recording the same class every pass", async () => {
    const sha = buildTaskBranch("fusion/rufu-825", "suppress-repeat.ts", "RUFU-825");
    const { store, recordRunAuditEvent } = createStore([suppressedCard("RUFU-825", sha, { autoMerge: false })]);
    const manager = managerFor(store, repo);

    await manager.reconcileLandedTruth();
    await manager.reconcileLandedTruth();
    await manager.reconcileLandedTruth();

    expect(auditRows(recordRunAuditEvent, "task:done-landing-unproven")).toHaveLength(1);
  });
});

/*
FNXC:LandedTruthCensus 2026-11-17-21:05 (RUFU-702, code-review P1):
The write bound. The probe budget caps what a pass can LEARN; this caps what it can SAY, because the first
pass after the census ships walks every card in the complete lane and each finding costs a History row, an
audit row, and a notice. The property that makes the cap honest is the rewind: a card that ran out of budget
is re-walked by a later pass, so a bounded pass cannot silently drop the tail of the lane.
*/
describe("reconcileLandedTruth report budget — bounded speech, unbounded coverage", () => {
  it("writes at most the budget per pass and reaches the remainder on the next one", async () => {
    const shas = {
      "RUFU-830": buildTaskBranch("fusion/rufu-830", "report-a.ts", "RUFU-830"),
      "RUFU-831": buildTaskBranch("fusion/rufu-831", "report-b.ts", "RUFU-831"),
      "RUFU-832": buildTaskBranch("fusion/rufu-832", "report-c.ts", "RUFU-832"),
    };
    const tasks = Object.entries(shas).map(([id, sha]) => card(id, { mergeDetails: mergeDetailsFor(sha) }));
    const { store, recordRunAuditEvent } = createStore(tasks);
    const manager = managerFor(store, repo);
    (manager as unknown as { options: { landedTruthReportBudget?: number } }).options.landedTruthReportBudget = 2;
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue(null);

    expect(await manager.reconcileLandedTruth()).toBe(2);
    const rowsFor = (id: string) => auditRows(recordRunAuditEvent, "task:done-landing-unproven")
      .filter((row) => row.metadata?.taskId === id);
    expect(rowsFor("RUFU-830")).toHaveLength(1);
    expect(rowsFor("RUFU-831")).toHaveLength(1);
    // Deferred, not acquitted: the third card is silent because it was never given a voice, not because it
    // was measured and cleared.
    expect(rowsFor("RUFU-832")).toHaveLength(0);

    // A card that costs no report costs no budget: its siblings already told their story, so the next pass
    // reaches it. The rewind of the rotating cursor is what covers the larger-than-budget lanes; this lane is
    // smaller than the probe budget, and both mechanisms have to hold or a bounded pass drops the tail.
    expect(await manager.reconcileLandedTruth()).toBe(1);
    expect(rowsFor("RUFU-832")).toHaveLength(1);
    expect(rowsFor("RUFU-830")).toHaveLength(1);
  });
});

/*
FNXC:LandedTruthProbeBudget 2026-11-06-11:05 (RUFU-702):
The census runs on the SAME checkout every other lane is using, and one measurement is several bounded git
subprocesses, so a pass may probe only `landedTruthProbeBudget` cards. The property worth pinning is not the
number — it is that the budget is a COST bound and not a verdict: a card the budget never reached must stay
UNMEASURED (no finding, no notice, no audit row), and the rotating cursor must eventually reach it, or a
large `done` lane would keep an unbounded head slice under the microscope forever and starve the tail.
*/
describe("reconcileLandedTruth probe budget — a cost bound that still walks the whole lane", () => {
  it("defers the cards past the budget and reaches them on a later pass", async () => {
    const shas = {
      "RUFU-800": buildTaskBranch("fusion/rufu-800", "budget-a.ts", "RUFU-800"),
      "RUFU-801": buildTaskBranch("fusion/rufu-801", "budget-b.ts", "RUFU-801"),
      "RUFU-802": buildTaskBranch("fusion/rufu-802", "budget-c.ts", "RUFU-802"),
    };
    const tasks = Object.entries(shas).map(([id, sha]) => card(id, { mergeDetails: mergeDetailsFor(sha) }));
    const { store, recordRunAuditEvent, logEntry } = createStore(tasks);
    const manager = managerFor(store, repo);
    (manager as unknown as { options: { landedTruthProbeBudget?: number } }).options.landedTruthProbeBudget = 2;
    vi.spyOn(manager as any, "baseDeliveryEvidence").mockResolvedValue(null);

    await manager.reconcileLandedTruth();

    const rowsFor = (id: string) => auditRows(recordRunAuditEvent, "task:done-landing-unproven")
      .filter((row) => row.metadata?.taskId === id);
    // Two measured, one untouched — and the untouched one is silent, not accused.
    expect(rowsFor("RUFU-800")).toHaveLength(1);
    expect(rowsFor("RUFU-801")).toHaveLength(1);
    expect(rowsFor("RUFU-802")).toHaveLength(0);
    expect(messagesFor(logEntry).some((line) => line.includes("RUFU-802"))).toBe(false);

    await manager.reconcileLandedTruth();
    expect(rowsFor("RUFU-802")).toHaveLength(1);
  });
});

/*
FNXC:LandedTruthReopen 2026-11-06-11:05 (RUFU-702):
The operator's half of the census. Lifecycle containment (FN-207/FN-217) means the automatic sweep may only
report, so this seam — driven by an explicit `fn task reconcile <id> --reopen` — is the ONLY way a card in a
terminal lane gets back onto a path where its work can land, and it is the only backward move the landing
door authorizes. What has to hold: it acts on exactly the card named; it acts only on a positive refusal
(`proven` and `deferred` both refuse, because an unreadable repository is not evidence of a false landing);
the move carries the operator's attribution rather than an engine's; and the reason survives the move, which
the reopen's own entry effects wipe out of `mergeDetails`.
*/
describe("reopenUnprovenLandedTask — one named card, only on a positive refusal", () => {
  it("moves the refused card into its planning lane and records the reopen on both operator surfaces", async () => {
    const foreignSha = buildTaskBranch("fusion/rufu-810", "reopen-unlanded.ts", "RUFU-810");
    const task = card("RUFU-810", { mergeDetails: mergeDetailsFor(foreignSha) });
    const { store, tasks, logEntry, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store, repo);

    const result = await manager.reopenUnprovenLandedTask("RUFU-810");

    expect(result.outcome).toBe("reopened");
    // The transition contract's only backward edge out of a terminal lane is to the planning lane; naming
    // review would have meant widening that contract, so the seam resolves it instead of inventing it.
    const target = result.outcome === "reopened" ? result.toColumn : null;
    expect(tasks.get("RUFU-810")!.column).toBe(target);
    expect(target).not.toBe("done");
    // Human attribution is what makes the move legal at all, and RELEASE intent is what the operator asked
    // for: run the work again, do not park it (RUFU-261's distinction).
    const moveCall = (store.moveTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(moveCall?.[0]).toBe("RUFU-810");
    expect(moveCall?.[2]).toMatchObject({ moveSource: "user", parkOnHold: false });
    // The reason outlives the row it describes, because the reopen clears the false `mergeDetails`.
    expect(messagesFor(logEntry).some((line) => line.includes("[landing-proof-reopen]") && line.includes("main"))).toBe(true);
    const rows = auditRows(recordRunAuditEvent, "task:landing-unproven-reopened");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      taskId: "RUFU-810",
      fromColumn: "done",
      integrationBranch: "main",
      recordedSha: foreignSha,
      refusalCode: "commit-not-on-integration-branch",
      outcome: "reopened",
    });
    // Closed key set: a refusal SENTENCE has nowhere to live in this row, so it cannot leak here.
    expect(Object.keys(rows[0]!.metadata!).sort()).toEqual([
      "branchRef", "conflictCount", "fromColumn", "integrationBranch", "outcome",
      "recordedSha", "refusalCode", "taskId", "toColumn",
    ]);
  });

  it("will not reopen a card whose work IS on the default branch", async () => {
    const landedSha = commitOnMain("reopen-proven.ts", "genuinely delivered\n");
    const task = card("RUFU-811", { mergeDetails: mergeDetailsFor(landedSha) });
    const { store, tasks, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store, repo);

    const result = await manager.reopenUnprovenLandedTask("RUFU-811");

    expect(result.outcome).toBe("proven");
    expect(tasks.get("RUFU-811")!.column).toBe("done");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows(recordRunAuditEvent, "task:landing-unproven-reopened")).toHaveLength(0);
  });

  it("will not reopen a card it cannot measure — a deferral is not a refutation", async () => {
    const task = card("RUFU-812", { mergeDetails: mergeDetailsFor("0000000000000000000000000000000000000000") });
    const { store, tasks, recordRunAuditEvent } = createStore([task]);
    const manager = managerFor(store, repo);

    const result = await manager.reopenUnprovenLandedTask("RUFU-812");

    expect(result.outcome).toBe("deferred");
    expect(tasks.get("RUFU-812")!.column).toBe("done");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(auditRows(recordRunAuditEvent, "task:landing-unproven-reopened")).toHaveLength(0);
  });

  it("refuses a card outside the terminal lane and one that never claimed a commit", async () => {
    const foreignSha = buildTaskBranch("fusion/rufu-813", "reopen-review.ts", "RUFU-813");
    const reviewCard = card("RUFU-813", { column: "in-review", mergeDetails: mergeDetailsFor(foreignSha) });
    const claimless = card("RUFU-814", { mergeDetails: undefined });
    const { store } = createStore([reviewCard, claimless]);
    const manager = managerFor(store, repo);

    await expect(manager.reopenUnprovenLandedTask("RUFU-813")).resolves.toMatchObject({
      outcome: "refused", reason: "not-in-complete-lane",
    });
    await expect(manager.reopenUnprovenLandedTask("RUFU-814")).resolves.toMatchObject({
      outcome: "refused", reason: "no-landing-claim",
    });
    await expect(manager.reopenUnprovenLandedTask("RUFU-815")).resolves.toMatchObject({
      outcome: "refused", reason: "not-found",
    });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("answers the read-only question with the same verdict the reopen would have acted on", async () => {
    // The CLI prints this sentence for a card in a terminal lane. If the two classifier paths drifted, an
    // operator would read one verdict and `--reopen` would act on another.
    const foreignSha = buildTaskBranch("fusion/rufu-816", "describe-unlanded.ts", "RUFU-816");
    const task = card("RUFU-816", { mergeDetails: mergeDetailsFor(foreignSha) });
    const { store } = createStore([task]);
    const manager = managerFor(store, repo);

    const verdict = await manager.describeLandedTruth("RUFU-816");

    expect(verdict.state).toBe("refused");
    if (verdict.state !== "refused") return;
    expect(verdict.refusalCode).toBe("commit-not-on-integration-branch");
    expect(verdict.sentence).toContain("main");
    expect(verdict.recordedSha).toBe(foreignSha);
    // The sentence is prose meant for a human, so it must NOT also be a metadata field anywhere upstream.
    expect(verdict.sentence.length).toBeGreaterThan(20);
  });
});
