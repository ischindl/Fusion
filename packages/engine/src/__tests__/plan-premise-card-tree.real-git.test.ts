import { afterEach, describe, expect, it, vi } from "vitest";
import { exec } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { admitTaskToWip } from "../execution/hold-release.js";
import { checkPlanPremises } from "../execution/plan-premise-check.js";
import {
  TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION,
  TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION,
} from "../execution/plan-premise-ladder.js";

/*
FNXC:PlanPremiseCardTree 2026-09-27 (STAS-282):
Measured production defect: release evaluated a card's premises against `TaskStore.getRootDir()`'s
working tree. That checkout is whatever the machine happens to hold — verified on disk for STAS-264:
a detached HEAD at another open card's tip, so premises read a stranger's tree. Two consequences: a
card whose work had already landed could not be released, and — worse — the engine could not tell
"my plan is false" from "my plan came true", so it could re-plan and re-implement finished work.

These tests are the wallclock reproduction of both directions, in throwaway real repositories:
  • the fact must come from the CARD's own committed identity, never the shared checkout or any
    uncommitted or unrelated directory (a premise source that an operator's `git checkout` can move
    is not a fact source);
  • falsification by the card's OWN commit set is `premise-invalidated-by-delivery` — promotable,
    logged once, no episode, no replan, because a replan of delivered work duplicates the delivery;
  • falsification by an UPSTREAM commit stays loudly `stale` and names the commit, because that plan
    really is false and the ladder's hold → replan → park rungs exist for it.
The two verdicts must not look alike: a self-refuting premise is the only kind no executor retry can
fix, and a genuinely stale plan must never be laundered into a release.
*/

const execAsync = promisify(exec);
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = async (args: string, cwd: string): Promise<string> =>
  (await execAsync(`git ${args}`, { cwd, encoding: "utf-8" })).stdout.trim();

async function write(root: string, relative: string, text: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf-8");
}

async function commit(root: string, message: string): Promise<string> {
  await git("add -A", root);
  await git(`commit -qm ${JSON.stringify(message)}`, root);
  return await git("log -1 --format=%s", root);
}

/** A real repository on `main` carrying `files`, so the shared checkout has a committed baseline. */
async function createRepo(files: Record<string, string>, message = "chore: base"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "stas282-card-tree-"));
  tempDirs.push(root);
  await git("init -q -b main .", root);
  await git("config user.email test@example.com", root);
  await git("config user.name Test User", root);
  for (const [relative, text] of Object.entries(files)) await write(root, relative, text);
  await commit(root, message);
  return root;
}

const ALPHA_PRESENT = '{"kind":"text-present","path":"src/App.tsx","literal":"alphaUpdatesEnabled"}';
const FLAG_ON = "export const alphaUpdatesEnabled = true;\n";
const FLAG_OFF = "export const footer = true;\n";

function premiseTask(bullets: string[], fields: Partial<Task> = {}): Task {
  const now = new Date("2026-09-27T00:00:00.000Z").toISOString();
  return {
    id: "FN-282-T",
    title: "planned card",
    description: "planned card",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    prompt: `# Task\n\n## Plan Premises\n\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}\n\n## Steps\n\n1. do the thing\n`,
    ...fields,
  } as Task;
}

/* The release door reads column traits, so the target column must really count toward WIP — a
   premise-less ir would make every door below release vacuously. */
const ir = {
  version: "v2", id: "test", name: "test",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
  ],
  nodes: [], edges: [],
} as unknown as WorkflowIr;

/** The release door's store surface: atomic move + the two History writers the ladder uses. */
function releaseDoor(task: Task, root: string) {
  const storeMirror = { _value: task };
  const reserve = vi.fn(() => ({ release: vi.fn() }));
  const allocate = vi.fn(() => path.join(root, ".worktrees", "fn-282"));
  const moveTaskIf = vi.fn(async (_id: string, target: string, predicate: (candidate: Task) => Promise<boolean> | boolean, options?: { allocateWorktree?: (names: Set<string>) => string }) => {
    if (!(await predicate(storeMirror._value))) return { task: storeMirror._value, moved: false };
    options?.allocateWorktree?.(new Set());
    storeMirror._value.column = target;
    return { task: storeMirror._value, moved: true };
  });
  const store = {
    getRootDir: () => root,
    getSettings: async () => ({ maxConcurrent: 3 }),
    updateTaskAtomic: async (id: string, updater: (candidate: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      if (storeMirror._value.id !== id) return null;
      const patch = await updater(storeMirror._value);
      if (!patch) return null;
      const metadata = patch.sourceMetadataPatch;
      if (metadata) {
        const merged = { ...(storeMirror._value.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(metadata)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        storeMirror._value.sourceMetadata = merged;
      }
      const { sourceMetadataPatch: _patch, ...fields } = patch;
      Object.assign(storeMirror._value, fields);
      return storeMirror._value;
    },
    logEntry: vi.fn(async (_id: string, message: string) => {
      task.log.push({ timestamp: new Date().toISOString(), message } as never);
    }),
    // Mirrors the real store's once-seam: the same dedupeKey within windowMs appends nothing.
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => {
      const cutoff = Date.now() - input.windowMs;
      const duplicate = task.log.some((entry: { dedupeKey?: string; timestamp?: string }) =>
        entry.dedupeKey === input.dedupeKey && Date.parse(entry.timestamp ?? "") >= cutoff);
      if (duplicate) return;
      task.log.push({ timestamp: new Date().toISOString(), action: input.action, outcome: input.outcome, dedupeKey: input.dedupeKey } as never);
    }),
    moveTaskIf,
  } as unknown as TaskStore;
  const deps = { now: Date.now, reserveSlot: reserve, allocateWorktree: allocate };
  const logActions = (action: string) => task.log.filter((entry: { action?: string }) => entry.action === action).length;
  return { store, deps, moveTaskIf, logActions };
}

describe("premise truth is the card's committed identity, never the shared checkout", () => {
  it("verifies a premise that is true at the card's branch tip while the project checkout disagrees", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_OFF });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/App.tsx", FLAG_ON);
    await commit(root, "feat: alpha flag");
    await git("checkout -q main", root);

    const card = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const door = releaseDoor(card, root);
    expect(await checkPlanPremises(door.store, card)).toMatchObject({ outcome: "satisfied", premiseViolations: [] });
    expect(await admitTaskToWip(door.store, door.deps, card, "doing", ir)).toMatchObject({ released: true, task: { column: "doing" } });

    // The same premise on the tree the old code read: the shared checkout really does disagree, so
    // this release can only come from the card's own identity — and a card with no commits of its
    // own still legitimately evaluates against its declared base.
    const baseCard = premiseTask([ALPHA_PRESENT]);
    const baseDoor = releaseDoor(baseCard, root);
    const baseVerdict = await checkPlanPremises(baseDoor.store, baseCard);
    expect(baseVerdict).toMatchObject({ outcome: "stale" });
    expect(baseVerdict.detail).toContain("literal not found in file");
  }, 30_000);

  it("reads the card's own worktree HEAD when the card owns that worktree", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_OFF });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/App.tsx", FLAG_ON);
    await commit(root, "feat: alpha flag");
    const worktree = `${root}-wt`;
    tempDirs.push(worktree);
    // The card's checkout frozen at the commit it is actually running (a detached linked worktree is
    // exactly what the engine provisions), then the branch pointer moves past it.
    await git(`worktree add -q --detach ${JSON.stringify(worktree)} fusion/fn-282`, root);
    await git("checkout -q main", root);
    await write(root, "src/flag.ts", "export const alphaFlagRemoved = true;\n");
    await commit(root, "feat: retire the alpha flag");
    await git("branch -f fusion/fn-282 main", root);

    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282", worktree });
    const door = releaseDoor(task, root);
    // Worktree HEAD carries the fact; the moved branch pointer does not. Only the worktree answer is
    // "satisfied", so this pins WHICH commit was read, not just that a read happened.
    expect(await checkPlanPremises(door.store, task)).toMatchObject({ outcome: "satisfied" });

    const withoutCheckout = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const branchVerdict = await checkPlanPremises(releaseDoor(withoutCheckout, root).store, withoutCheckout);
    expect(branchVerdict).toMatchObject({ outcome: "stale" });
    expect(branchVerdict.detail).toContain("card branch fusion/fn-282");
  }, 30_000);

  it("treats an uncommitted working-tree edit as no evidence at all", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_OFF });
    // The exact production accident: somebody edits the shared checkout (or forgets a dirty file)
    // and a filesystem read would call that a verified fact.
    await write(root, "src/App.tsx", FLAG_ON);

    const task = premiseTask([ALPHA_PRESENT]);
    const door = releaseDoor(task, root);
    const verdict = await checkPlanPremises(door.store, task);
    expect(verdict).toMatchObject({ outcome: "stale" });
    expect(verdict.detail).toContain("literal not found in file");
  }, 30_000);

  it("refuses a worktree path that is not a linked worktree of the project repository", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_OFF });
    const unrelated = await createRepo({ "src/App.tsx": FLAG_ON }, "chore: somebody else's repository");

    const task = premiseTask([ALPHA_PRESENT], { worktree: unrelated });
    const door = releaseDoor(task, root);
    const verdict = await checkPlanPremises(door.store, task);
    expect(verdict).toMatchObject({ outcome: "stale" });
    expect(verdict.detail).toContain("literal not found in file");
  }, 30_000);
});

describe("delivery-invalidated premises are a distinct verdict and never a replan", () => {
  it("reports premise-invalidated-by-delivery when the card's own commit removes the assumed fact", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_ON });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/App.tsx", FLAG_OFF);
    const culprit = await commit(root, "feat: retire the alpha flag");

    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const door = releaseDoor(task, root);
    const verdict = await checkPlanPremises(door.store, task);
    expect(verdict.outcome).toBe("premise-invalidated-by-delivery");
    // Names the invalidating commit so the operator can see WHY the plan and the delivery disagree.
    expect(verdict.detail).toContain(culprit);
    expect(verdict.detail).toMatch(/[0-9a-f]{7,40}/);
    expect(verdict.premiseViolations).toHaveLength(1);
    // The fingerprint is the prompt hash: the episode identity must not churn across evaluations.
    expect(verdict.promptFingerprint).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("releases and logs once: no episode, no needs-replan, no refusal History entry", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_ON });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/App.tsx", FLAG_OFF);
    const culprit = await commit(root, "feat: retire the alpha flag");

    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const door = releaseDoor(task, root);
    const result = await admitTaskToWip(door.store, door.deps, task, "doing", ir);
    expect(result).toMatchObject({ released: true, task: { column: "doing" } });
    // The card is promotable and was never bounced back for re-implementation.
    expect(task.column).toBe("doing");
    expect(task.status).toBeNull();
    expect(task.error ?? null).toBeNull();
    expect(task.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(door.logActions(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION)).toBe(0);
    expect(door.logActions(TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION)).toBe(1);
    expect(task.log.some((entry: { outcome?: string }) => (entry.outcome ?? "").includes(culprit))).toBe(true);
    expect(door.deps.reserveSlot).toHaveBeenCalledOnce();
    expect(door.deps.allocateWorktree).toHaveBeenCalledOnce();
  }, 30_000);

  it("keeps the evidence at one History entry and the episode absent across repeated door passes", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_ON });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/App.tsx", FLAG_OFF);
    await commit(root, "feat: retire the alpha flag");

    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const door = releaseDoor(task, root);
    // A lost move race keeps the card in `todo`, so the door evaluates the same verdict again; the
    // evidence must not stack and the ladder must never see this card.
    door.moveTaskIf.mockImplementation(async (_id: string, _target: string, predicate: (candidate: Task) => Promise<boolean> | boolean) =>
      (await predicate(task)) ? { task, moved: false } : { task, moved: false });
    await expect(admitTaskToWip(door.store, door.deps, task, "doing", ir)).resolves.toMatchObject({ released: false });
    await expect(admitTaskToWip(door.store, door.deps, task, "doing", ir)).resolves.toMatchObject({ released: false });
    expect(door.logActions(TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION)).toBe(1);
    expect(door.logActions(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION)).toBe(0);
    expect(task.sourceMetadata?.planPremiseRejection).toBeUndefined();
  }, 30_000);
});

describe("upstream falsification stays loudly plan-stale", () => {
  it("reports stale for a premise a foreign upstream commit destroyed, naming that commit, and keeps the ladder", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_ON });
    await git("checkout -qb fusion/fn-282", root);
    await write(root, "src/other.ts", "export const other = 1;\n");
    await commit(root, "feat: unrelated card work");
    await git("checkout -q main", root);
    await write(root, "src/App.tsx", FLAG_OFF);
    const upstream = await commit(root, "chore: upstream retires the alpha flag");
    await git("checkout -q fusion/fn-282", root);
    await git("merge -q main --no-edit -m 'Merge main'", root);

    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/fn-282" });
    const door = releaseDoor(task, root);
    const verdict = await checkPlanPremises(door.store, task);
    // The tip the card is evaluated at DOES lack the fact, but the destroying commit sits below the
    // merge-base: the card never claimed that change, so its plan is genuinely false.
    expect(verdict.outcome).toBe("stale");
    expect(verdict.detail).toContain(upstream);
    expect(verdict.premiseViolations).toEqual([
      { premise: { kind: "text-present", path: "src/App.tsx", literal: "alphaUpdatesEnabled" }, reason: expect.stringContaining("literal not found") },
    ]);

    const result = await admitTaskToWip(door.store, door.deps, task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(task.column).toBe("todo");
    expect(task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold" });
    expect(door.logActions(TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION)).toBe(1);
    expect(door.logActions(TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION)).toBe(0);
  }, 30_000);
});

describe("an unresolvable card identity fails closed", () => {
  it("reports unavailable when neither a worktree, a branch, nor the declared base resolves", async () => {
    const root = await createRepo({ "src/App.tsx": FLAG_ON });
    const task = premiseTask([ALPHA_PRESENT], { branch: "fusion/ghost-card", baseBranch: "ghost/base" });
    const door = releaseDoor(task, root);
    const verdict = await checkPlanPremises(door.store, task);
    expect(verdict.outcome).toBe("unavailable");
    expect(verdict.detail).toContain("git identity");

    const result = await admitTaskToWip(door.store, door.deps, task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(task.sourceMetadata?.planPremiseRejection).toBeUndefined();
    expect(task.column).toBe("todo");
  }, 30_000);
});
