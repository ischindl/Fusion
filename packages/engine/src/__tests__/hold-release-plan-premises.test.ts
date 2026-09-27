import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { admitTaskToWip } from "../execution/hold-release.js";
import { checkPlanPremises } from "../execution/plan-premise-check.js";
import { TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION } from "../execution/plan-premise-ladder.js";

const roots: string[] = [];
const ir: WorkflowIr = {
  version: "v2", id: "test", name: "test",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
  ],
  nodes: [], edges: [],
};

/*
The premise gate reads committed git objects at the card's own identity, so this fixture's project is a
real repository whose integration branch carries `fileText`. A premise's truth is the committed content
— an uncommitted edit is not a fact — which is why the file is committed here rather than just written.
*/
async function fixture(premise: string | string[], fileText = "export const alphaUpdatesEnabled = true;") {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn-375-"));
  roots.push(root);
  await writeFile(join(root, "App.tsx"), fileText);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "chore: baseline"]);
  const bullets = (Array.isArray(premise) ? premise : [premise]).map((one) => `- ${one}`).join("\n");
  const task = {
    id: "FN-375-T", title: "planned", description: "planned", column: "todo", status: null,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    prompt: `# Task\n\n## Plan Premises\n\n${bullets}\n\n## Steps\n`,
  } as Task;
  const reserve = vi.fn(() => ({ release: vi.fn() }));
  const allocate = vi.fn(() => join(root, "worktree"));
  const moveTaskIf = vi.fn(async (_id: string, target: string, predicate: (live: Task) => boolean | Promise<boolean>, options?: { allocateWorktree?: (names: Set<string>) => string | null }) => {
    if (!(await predicate(task))) return { task, moved: false };
    options?.allocateWorktree?.(new Set());
    task.column = target;
    return { task, moved: true };
  });
  const store = {
    getRootDir: () => root,
    getSettings: vi.fn(async () => ({ maxConcurrent: 3 })),
    updateTaskAtomic: vi.fn(async (_id, mutate) => {
      const patch = await mutate(task);
      if (patch) {
        // Mirror the real store's key-preserving sourceMetadataPatch merge semantics so the
        // RUFU-246 refusal episode persists across gate calls exactly like production.
        const { sourceMetadataPatch, ...rest } = patch as Record<string, unknown> & { sourceMetadataPatch?: Record<string, unknown> };
        if (sourceMetadataPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...sourceMetadataPatch };
        Object.assign(task, rest);
      }
      return task;
    }),
    logEntry: vi.fn(async (_id, message) => { task.log.push({ timestamp: new Date().toISOString(), message } as never); }),
    // Mirrors the real store's once-seam: same dedupeKey within windowMs appends nothing.
    logEntryOnce: vi.fn(async (_id, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => {
      const cutoff = Date.now() - input.windowMs;
      const dup = task.log.some((e: { dedupeKey?: string; timestamp?: string }) =>
        e.dedupeKey === input.dedupeKey && Date.parse(e.timestamp ?? "") >= cutoff);
      if (dup) return;
      task.log.push({ timestamp: new Date().toISOString(), action: input.action, outcome: input.outcome, dedupeKey: input.dedupeKey } as never);
    }),
    moveTaskIf,
  } as unknown as TaskStore;
  return { root, task, store, reserve, allocate, moveTaskIf };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/*
A premise's truth is the card's COMMITTED content, so a test that wants a premise to change has to move
the repository's history — editing the working tree is deliberately invisible to the gate.
*/
function commitTreeChange(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", message], { cwd: root, stdio: "ignore" });
}

/** Stages the path as a mode-040000 tree entry — the committed shape of "a path that is a directory". */
function commitPathAsDirectory(root: string, relative: string, message: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).toString().trim();
  // A commit holds a directory at a path only when the working tree agrees, so the file is removed and a
  // directory holding a child is committed in its place — the ordinary shape of "a path that is a directory".
  git(["rm", "-f", "-q", "--", relative]);
  git(["commit", "-qm", `chore: drop ${relative} before replacing it with a directory`]);
  mkdirSync(join(root, relative), { recursive: true });
  writeFileSync(join(root, relative, "inner.tsx"), "export const inner = true;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
  const entry = git(["ls-tree", "-l", "HEAD", "--", relative]);
  if (!entry.startsWith("040000 ")) throw new Error(`Fixture cannot commit ${relative} as a directory entry; HEAD lists: ${entry || "<nothing>"}`);
}

describe("stateless plan premise release gate", () => {
  it("admits a true premise and preserves reservation/allocation", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: true, task: { column: "doing" } });
    expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.allocate).toHaveBeenCalledOnce();
  });

  it("holds the card with a durable episode on the first stale refusal, before reserve, allocation, or move", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale", detail: expect.stringContaining("alphaUpdatesEnabled") });
    // Ladder refusal #1: no status change — the card simply stays held, episode recorded durably.
    expect(f.task).toMatchObject({ column: "todo", status: null });
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({
      refusalCount: 1,
      escalation: "hold",
      lastDetail: expect.stringContaining("alphaUpdatesEnabled"),
    });
    expect(f.task.log.at(-1)).toMatchObject({
      action: TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION,
      outcome: expect.stringContaining("alphaUpdatesEnabled"),
      dedupeKey: expect.stringMatching(/^plan-premise-refusal:[0-9a-f]{64}$/),
    });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.moveTaskIf).not.toHaveBeenCalled();
  });

  /*
  FNXC:PlanPremises 2026-09-16-03:20:
  RUFU-246 escalation ladder at the release door: refusal 1 holds without a status change, refusal
  2 (same rejection identity) sets needs-replan, refusal 3 parks failed with the exhaustion
  sentinel. None of the refusals may reserve capacity, allocate a worktree, or move the card.
  */
  it("replans on the second identical stale refusal", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const deps = { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const second = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    expect(second).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(f.task).toMatchObject({ column: "todo", status: "needs-replan", error: null });
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 2, escalation: "replan" });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.moveTaskIf).not.toHaveBeenCalled();
  });

  it("parks failed with the exhaustion sentinel on the third identical stale refusal", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const deps = { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const third = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    expect(third).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(f.task).toMatchObject({ column: "todo", status: "failed" });
    expect(f.task.error).toMatch(/^PLAN PREMISE CONTRACT EXHAUSTED: .*alphaUpdatesEnabled/);
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 3, escalation: "park" });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.moveTaskIf).not.toHaveBeenCalled();
    // One action-keyed History entry covers the whole hold→replan→park walk (identical detail).
    const premiseLogEntries = f.task.log.filter((e: { action?: string }) => e.action === TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION);
    expect(premiseLogEntries).toHaveLength(1);
    // A fourth refusal on the sticky park must not re-log or mutate the terminal park.
    const writesBefore = f.store.updateTaskAtomic.mock.calls.length;
    const onceLogsBefore = f.store.logEntryOnce.mock.calls.length;
    const fourth = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    expect(fourth).toMatchObject({ released: false, rejection: "plan-premise-exhausted" });
    expect(f.task.status).toBe("failed");
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 3, escalation: "park" });
    expect(f.task.log.filter((e: { action?: string }) => e.action === TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION)).toHaveLength(1);
    // RUFU-246 Step 4: the refusal is a refuse-to-touch short-circuit — no store write, no new record.
    expect(f.store.updateTaskAtomic.mock.calls.length).toBe(writesBefore);
    expect(f.store.logEntryOnce.mock.calls.length).toBe(onceLogsBefore);
  });

  it("resets the episode when the prompt revision changes the rejection identity", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const deps = { now: Date.now };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const firstEpisode = f.task.sourceMetadata?.planPremiseRejection as { signature: string; refusalCount: number };
    // A replan that rewrites PROMPT.md (here: an added section) changes the prompt fingerprint even
    // though the same premise still fails — that is a fresh episode, not refusal #2.
    f.task.prompt = `${f.task.prompt}\n## Notes\nreplanned once\n`;
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const secondEpisode = f.task.sourceMetadata?.planPremiseRejection as { signature: string; refusalCount: number; escalation: string };
    expect(secondEpisode.signature).not.toBe(firstEpisode.signature);
    expect(secondEpisode.refusalCount).toBe(1);
    expect(secondEpisode.escalation).toBe("hold");
  });

  it("keeps the episode untouched when a release succeeds after the premises became true", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const deps = { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const episode = f.task.sourceMetadata?.planPremiseRejection;
    await writeFile(join(f.root, "App.tsx"), "export const alphaUpdatesEnabled = true;");
    commitTreeChange(f.root, "feat: restore the alpha flag");
    const result = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    expect(result).toMatchObject({ released: true });
    // A successful release never clears episode state — only signature drift or operator action does.
    expect(f.task.sourceMetadata?.planPremiseRejection).toEqual(episode);
  });

  it("fails closed for malformed contracts and unavailable reads", async () => {
    const invalid = await fixture('{"kind":"shell","path":"App.tsx"}');
    await expect(admitTaskToWip(invalid.store, { now: Date.now }, invalid.task, "doing", ir)).resolves.toMatchObject({ released: false, rejection: "plan-premise-invalid" });
    // Ladder refusal #1 also applies to invalid contracts: held, episode recorded, no status change.
    expect(invalid.task.status).toBeNull();
    expect(invalid.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold" });

    const unavailable = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    (unavailable.store as unknown as { getRootDir(): string }).getRootDir = () => join(unavailable.root, "missing-root");
    await expect(admitTaskToWip(unavailable.store, { now: Date.now }, unavailable.task, "doing", ir)).resolves.toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(unavailable.task).toMatchObject({ column: "todo", status: null });
    // Transient unavailable reads never count against the escalation ladder.
    expect(unavailable.task.sourceMetadata?.planPremiseRejection).toBeUndefined();
  });

  it("rechecks the live premise after reservation and rejects a race", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    f.moveTaskIf.mockImplementationOnce(async (_id, _target, predicate) => {
      await writeFile(join(f.root, "App.tsx"), "export const footer = true;");
      commitTreeChange(f.root, "feat: retire the alpha flag mid-flight");
      await predicate(f.task);
      return { task: f.task, moved: false };
    });
    const reservationRelease = vi.fn();
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: () => ({ release: reservationRelease }), allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    // The under-lock live rejection is this card's first refusal: held with an episode, no status change.
    expect(f.task).toMatchObject({ column: "todo", status: null });
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold" });
    expect(reservationRelease).toHaveBeenCalledOnce();
    expect(f.allocate).not.toHaveBeenCalled();
  });

  it("requires regular files and detects a file replaced by a directory", async () => {
    const fileExists = await fixture('{"kind":"file-exists","path":"App.tsx"}');
    await expect(checkPlanPremises(fileExists.store, fileExists.task)).resolves.toMatchObject({ outcome: "satisfied", premiseViolations: [], promptFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    commitPathAsDirectory(fileExists.root, "App.tsx", "chore: App.tsx becomes a directory");
    await expect(checkPlanPremises(fileExists.store, fileExists.task)).resolves.toMatchObject({
      outcome: "stale",
      premiseViolations: [{ premise: { kind: "file-exists", path: "App.tsx" }, reason: "path exists but is not a regular file" }],
    });

    const textAbsent = await fixture('{"kind":"text-absent","path":"App.tsx","literal":"removedSetting"}');
    await expect(checkPlanPremises(textAbsent.store, textAbsent.task)).resolves.toMatchObject({ outcome: "satisfied", premiseViolations: [] });
    commitPathAsDirectory(textAbsent.root, "App.tsx", "chore: App.tsx becomes a directory");
    await expect(checkPlanPremises(textAbsent.store, textAbsent.task)).resolves.toMatchObject({
      outcome: "stale",
      premiseViolations: [{ premise: { kind: "text-absent", path: "App.tsx", literal: "removedSetting" }, reason: "path exists but is not a regular file" }],
    });

    const absentPath = await fixture('{"kind":"file-absent","path":"App.tsx"}');
    commitPathAsDirectory(absentPath.root, "App.tsx", "chore: App.tsx becomes a directory");
    await expect(checkPlanPremises(absentPath.store, absentPath.task)).resolves.toMatchObject({ outcome: "stale" });
  });

  /*
  FNXC:PlanPremises 2026-09-16-02:49:
  RUFU-246 Step 1 pinned two checker contracts that prose alone did not prove:
  - `file-absent` evaluates both ways against the card's committed tree under the SAME containment rule
    as the other kinds, so a release gate can never report "unsupported" for a kind the planner grammar
    advertises;
  - containment is enforced where the premise is written, not where it is read: a path that escapes the
    repository is refused as a contract violation before any commit is opened, which is why no evaluated
    path can ever name another directory;
  - a stale verdict reports the ENTIRE violated set with each premise's JSON, reason, and the commit it
    was evaluated at, not only the first violation.
  */
  it("evaluates file-absent both ways under the containment rule", async () => {
    const trulyAbsent = await fixture('{"kind":"file-absent","path":"Ghost.tsx"}');
    await expect(checkPlanPremises(trulyAbsent.store, trulyAbsent.task)).resolves.toMatchObject({ outcome: "satisfied", premiseViolations: [] });

    const wronglyAbsent = await fixture('{"kind":"file-absent","path":"App.tsx"}');
    await expect(checkPlanPremises(wronglyAbsent.store, wronglyAbsent.task)).resolves.toMatchObject({
      outcome: "stale",
      detail: expect.stringMatching(/file-absent.*App\.tsx.*path exists at the evaluated commit.*Evaluated at declared base main at [0-9a-f]{8}/s),
      premiseViolations: [{ premise: { kind: "file-absent", path: "App.tsx" }, reason: "path exists at the evaluated commit" }],
    });

    const escaping = await fixture('{"kind":"file-absent","path":"../secrets/Ghost.tsx"}');
    await expect(checkPlanPremises(escaping.store, escaping.task)).resolves.toMatchObject({ outcome: "invalid-contract" });
  });

  it("satisfies every premise kind together and reports the full violated set with its commit", async () => {
    const allKinds = await fixture([
      '{"kind":"file-exists","path":"App.tsx"}',
      '{"kind":"file-absent","path":"Ghost.tsx"}',
      '{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}',
      '{"kind":"text-absent","path":"App.tsx","literal":"removedSetting"}',
    ]);
    await expect(checkPlanPremises(allKinds.store, allKinds.task)).resolves.toMatchObject({ outcome: "satisfied", premiseViolations: [] });

    const multiStale = await fixture([
      '{"kind":"text-present","path":"App.tsx","literal":"goneSetting"}',
      '{"kind":"file-exists","path":"Ghost.tsx"}',
      '{"kind":"text-absent","path":"App.tsx","literal":"alphaUpdatesEnabled"}',
    ]);
    const result = await checkPlanPremises(multiStale.store, multiStale.task);
    expect(result.outcome).toBe("stale");
    if (result.outcome !== "stale") return;
    expect(result.premiseViolations).toEqual([
      { premise: { kind: "text-present", path: "App.tsx", literal: "goneSetting" }, reason: "literal not found in file" },
      { premise: { kind: "file-exists", path: "Ghost.tsx" }, reason: "path does not exist at the evaluated commit" },
      { premise: { kind: "text-absent", path: "App.tsx", literal: "alphaUpdatesEnabled" }, reason: "literal found in file" },
    ]);
    for (const fragment of ['"goneSetting"', '"Ghost.tsx"', '"alphaUpdatesEnabled"', "literal not found in file", "path does not exist at the evaluated commit", "literal found in file"]) {
      expect(result.detail).toContain(fragment);
    }
    // The detail names the COMMIT, not a directory: the operator has to be able to re-check the exact
    // object the verdict came from, and a path would let the same wording mean a different tree tomorrow.
    expect(result.detail).toMatch(/Evaluated at declared base main at [0-9a-f]{8}/);
    expect(result.detail).not.toContain(multiStale.root);
  });

  /*
  The old gate refused a working-tree symlink that pointed out of the project root. The committed gate
  cannot be escaped that way at all — it never opens a path, only objects inside one commit — and this
  test is the proof: the link is answered as the entry it is, its target is never opened, and no path
  reached through it exists.
  */
  it("reads a committed symlink as an entry and never follows it out of the tree", async () => {
    const f = await fixture('{"kind":"file-exists","path":"outside"}');
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc", join(f.root, "outside"));
    commitTreeChange(f.root, "chore: commit a symlink pointing outside the repository");
    // Every premise kind describes a regular file, so the link is answered as the non-regular entry it is.
    await expect(checkPlanPremises(f.store, f.task)).resolves.toMatchObject({
      outcome: "stale",
      premiseViolations: [{ premise: { kind: "file-exists", path: "outside" }, reason: "path exists but is not a regular file" }],
    });

    const throughLink = await fixture('{"kind":"file-exists","path":"outside/passwd"}');
    await symlink("/etc", join(throughLink.root, "outside"));
    commitTreeChange(throughLink.root, "chore: commit a symlink pointing outside the repository");
    await expect(checkPlanPremises(throughLink.store, throughLink.task)).resolves.toMatchObject({
      outcome: "stale",
      premiseViolations: [{ premise: { kind: "file-exists", path: "outside/passwd" }, reason: "path does not exist at the evaluated commit" }],
    });

    const readThroughLink = await fixture('{"kind":"text-present","path":"outside","literal":"etc"}');
    await symlink("/etc", join(readThroughLink.root, "outside"));
    commitTreeChange(readThroughLink.root, "chore: commit a symlink pointing outside the repository");
    await expect(checkPlanPremises(readThroughLink.store, readThroughLink.task)).resolves.toMatchObject({
      outcome: "stale",
      premiseViolations: [{ premise: { kind: "text-present", path: "outside", literal: "etc" }, reason: "path exists but is not a regular file" }],
    });
  });

  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 Step 4 pins the WIP-door contracts the escalation ladder depends on at every release
  surface: the terminal park is honored at the single release choke point WITHOUT any premise
  re-evaluation, History write, or store mutation; operator Retry (which clears the episode) is the
  only lift and restarts the ladder from refusal 1; Fast-lane cards verify premises like every other
  card (FN-8304's exemptions stay confined to planning-requiredness readiness); and a plan with no
  `## Plan Premises` section releases vacuously — only authored premises can refuse a release.
  */
  it("refuses a parked card at the door with the terminal code, detail, and zero re-evaluation", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const deps = { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    const parkedError = f.task.error;
    const parkedMetadata = structuredClone(f.task.sourceMetadata);
    const parkedLogLen = f.task.log.length;
    const fourth = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    // The terminal vocabulary is distinct from the retryable plan-premise codes and carries the
    // park sentence as its operator-facing detail.
    expect(fourth).toMatchObject({ released: false, rejection: "plan-premise-exhausted", detail: parkedError });
    expect(fourth.rejection).not.toBe("plan-premise-stale");
    // Refuse-to-touch: the row keeps the park byte-identical and no door surface touched it.
    expect(f.task.status).toBe("failed");
    expect(f.task.error).toBe(parkedError);
    expect(f.task.sourceMetadata).toEqual(parkedMetadata);
    expect(f.task.log).toHaveLength(parkedLogLen);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.moveTaskIf).not.toHaveBeenCalled();
  });

  it("lifts the park on operator Retry and restarts the ladder from refusal 1", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export the footer = true;");
    const deps = { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) };
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    expect(f.task.status).toBe("failed");
    /*
    Operator Retry as buildManualRetryResetPatch implements it: the key-preserving
    sourceMetadataPatch clears ONLY the premise episode while unrelated provenance keys survive.
    */
    f.task.status = null;
    f.task.error = null;
    f.task.sourceMetadata = { owner: "keep-me", planPremiseRejection: null };
    const afterRetry = await admitTaskToWip(f.store, deps, f.task, "doing", ir);
    // Premises are still stale: the Retry restarts the episode at refusal 1 instead of re-parking.
    expect(afterRetry).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(f.task).toMatchObject({ column: "todo", status: null });
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold" });
  });

  it("refuses a Fast-lane card whose premises are stale", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    // FN-8304 fast mode no longer short-circuits premise evaluation at any door.
    f.task.executionMode = "fast";
    const result = await admitTaskToWip(f.store, { now: Date.now }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(f.task).toMatchObject({ column: "todo", status: null });
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold" });
  });

  it("releases a plan with no ## Plan Premises section (vacuous satisfaction)", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    // A spec authored without the section is valid and must not be premise-refused.
    f.task.prompt = "# Task\n\n## Steps\n\n1. do the thing\n";
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task: Task, names: Set<string>) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: true, task: { column: "doing" } });
    expect(f.task.sourceMetadata?.planPremiseRejection).toBeUndefined();
  });

  it("preserves a park that lands under the move lock without recording a new refusal", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    const detail = "premise refused elsewhere";
    f.moveTaskIf.mockImplementationOnce(async (_id, _target, predicate) => {
      // A concurrent surface terminally parked this card after the pre-move check passed.
      f.task.status = "failed";
      f.task.error = `PLAN PREMISE CONTRACT EXHAUSTED: ${detail}`;
      f.task.sourceMetadata = {
        planPremiseRejection: { signature: "other-surface", refusalCount: 3, lastDetail: detail, lastAt: new Date().toISOString(), escalation: "park", detailHash: "0000000000000000000000000000000000000000000000000000000000000000" },
      };
      const ok = await predicate(f.task);
      return { task: f.task, moved: false };
    });
    const result = await admitTaskToWip(f.store, { now: Date.now }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-exhausted" });
    // Park preservation never re-evaluates: no premise refusal was logged for this door's pass.
    expect(f.task.log.filter((e: { action?: string }) => e.action === TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION)).toHaveLength(0);
    expect(f.task.sourceMetadata?.planPremiseRejection).toMatchObject({ signature: "other-surface", refusalCount: 3, escalation: "park" });
  });
});
