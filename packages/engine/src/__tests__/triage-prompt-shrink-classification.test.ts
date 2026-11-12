/*
FNXC:PromptWriteIntegrity 2026-11-11-23:58 (RUFU-534):
RUFU-519's spec fell from 57 814 B to 1 579 B through one accepted prompt write, and the next spec-lock
parse parked the card with `PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)` plus
"Operator description headings are not the cause." and a promise to retry once for changed prompt text.
The parser was right that a section was missing and wrong about why: the whole body was gone. That sentence
was written BEFORE any size measurement existed, so the card reached a 44th planning attempt against a
truncated spec while the exculpation stayed on its History.

The invariant owned here is an ORDERING one: the evidence ladder measures prompt size against the durable
`plan` mirror before any sentence may exculpate heading shape. Asserted as three distinct verdicts on the
same code path, because each is a different claim the operator reads - shrink (name the byte fall and the
recovery revision, blame nothing about headings, offer no retry), no-shrink (heading shape AND a measured
size), and unmeasurable (say it could not be measured, never assert innocence).
*/
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnavailablePlanLockError,
  createCurrentPlanEvidence,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pi.js")>(),
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
}));

import { TriageProcessor } from "../triage.js";

const TASK_ID = "FN-5190";

function sourceHashFor(prompt: string): string {
  return createCurrentPlanEvidence({
    version: 1,
    sourceRevision: 1,
    capturedAt: "2026-10-03T00:00:00.000Z",
    prompt,
  }).sourceHash;
}

/** A spec whose UTF-8 length is exactly `bytes`, so the assertion can name real measured numbers. */
function specOfBytes(bytes: number, marker: string): string {
  const head = `# Task: ${TASK_ID} - ${marker}\n\n## Mission\n\n`;
  const filler = "detail ".repeat(Math.ceil((bytes - head.length) / 7));
  return (head + filler).slice(0, bytes);
}

const ACCEPTED_BYTES = 57814;
const TRUNCATED_BYTES = 1579;
const LARGEST_REVISION = 3;

function createFixture(root: string, options: { durableRevisions?: Array<{ revision: number; content: string }> } = {}) {
  let task: Task = {
    id: TASK_ID,
    description: "Plan the saneca remediation",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const patches: Partial<Task>[] = [];
  const update = async (_id: string, patch: Partial<Task>) => {
    patches.push(patch);
    task = { ...task, ...patch };
    return task;
  };
  const promptPath = join(root, ".fusion", "tasks", TASK_ID, "PROMPT.md");
  const revisions = options.durableRevisions;
  const store = {
    getTask: vi.fn(async () => ({ ...task, attachments: [], comments: [] })),
    isBackendMode: vi.fn(() => true),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10_000, groupOverlappingFiles: false, autoMerge: true,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    updateTask: vi.fn(update),
    updateTaskUnlocked: vi.fn(update),
    updateTaskAtomic: vi.fn(async (_id: string, patcher: (live: Task) => Partial<Task> | null) => {
      const patch = patcher(task);
      if (patch) await update(_id, patch);
      return task;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    withTaskLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    readTaskForMove: vi.fn(async () => task),
    // The parser's own verdict stays exactly as shipped: a required section is unavailable. This task
    // must not make the parser size-aware, so the fixture only ever hands it one string with no prior state.
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      const prompt = await readFile(promptPath, "utf8");
      throw new UnavailablePlanLockError("mission-missing", ["mission"], sourceHashFor(prompt));
    }),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    getTaskDocumentRevisions: vi.fn(async () => revisions ?? []),
    getTaskDocument: vi.fn(async () => null),
    upsertTaskDocument: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    recordActivity: vi.fn(async () => undefined),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
  return { store, task: () => task, patches, promptPath, logged: () => (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1])) };
}

describe("triage measures prompt size before exculpating heading shape (RUFU-534)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-prompt-shrink-"));
    await mkdir(join(root, ".fusion", "tasks", TASK_ID), { recursive: true });
    mockCreateFnAgent.mockResolvedValue({
      session: { prompt: vi.fn(), dispose: vi.fn(), sessionManager: { getLeafId: vi.fn(() => null), navigateTree: vi.fn() } },
    });
  });

  afterEach(async () => {
    mockCreateFnAgent.mockReset();
    mockPromptWithFallback.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it("parks with the measured size fall and never blames heading shape or offers a retry", async () => {
    const fixture = createFixture(root, {
      durableRevisions: [{ revision: LARGEST_REVISION, content: specOfBytes(ACCEPTED_BYTES, "accepted") }],
    });
    // The planner's truncated send is what lands on disk this attempt (RUFU-519's exact shape).
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(fixture.promptPath, specOfBytes(TRUNCATED_BYTES, "truncated"), "utf8");
    });

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const parked = fixture.task();
    expect(parked.status).toBe("failed");
    expect(parked.error).toContain("PLANNING_FAILED_SPEC_PROMPT_SHRUNK");
    // The message must name the MEASURED fall, so assert the numbers against the real artifacts rather
    // than against a fixture constant: the durable mirror size and the byte length actually on disk.
    const liveBytes = Buffer.byteLength(await readFile(fixture.promptPath, "utf8"), "utf8");
    expect(liveBytes).toBeLessThan(ACCEPTED_BYTES);
    expect(parked.error).toContain(`spec fell from ${ACCEPTED_BYTES} B to ${liveBytes} B`);
    expect(parked.error).toContain(`task document "plan" revision ${LARGEST_REVISION}`);
    // A truncated spec is not something a retry can change: the retry budget must not be offered.
    expect(parked.recoveryRetryCount).toBeNull();
    expect(parked.planningFailure?.specLockUnavailable).toBeUndefined();

    const history = fixture.logged().join("\n");
    expect(history).toContain("PLANNING_FAILED_SPEC_PROMPT_SHRUNK");
    expect(history).toContain(String(ACCEPTED_BYTES));
    // The two sentences that made RUFU-519 unreadable must be absent from the shrink verdict entirely.
    expect(history).not.toContain("Operator description headings are not the cause");
    expect(history).not.toContain("retrying once for changed prompt text");
    expect(history).not.toContain("mission-missing");
  });

  it("names a size measurement beside the heading verdict when the spec did NOT shrink", async () => {
    const intact = specOfBytes(ACCEPTED_BYTES, "accepted");
    const fixture = createFixture(root, {
      durableRevisions: [{ revision: LARGEST_REVISION, content: intact }],
    });
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(fixture.promptPath, intact, "utf8");
    });

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    // The genuine shape failure keeps its own diagnostic and its retry budget untouched.
    expect(fixture.task().planningFailure?.specLockUnavailable).toMatchObject({ reason: "mission-missing", sections: ["mission"] });
    const history = fixture.logged().join("\n");
    expect(history).toContain("PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)");
    expect(history).toContain("Operator description headings are not the cause");
    expect(history).toContain(`${ACCEPTED_BYTES} B`);
    expect(history).not.toContain("PLANNING_FAILED_SPEC_PROMPT_SHRUNK");
  });

  it("admits the measurement was impossible instead of asserting heading innocence", async () => {
    // No durable revisions at all: the ladder has nothing to compare against.
    const fixture = createFixture(root, { durableRevisions: [] });
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(fixture.promptPath, specOfBytes(6000, "accepted"), "utf8");
    });

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const history = fixture.logged().join("\n");
    expect(history).toContain("PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)");
    expect(history).toContain("could not be measured");
    expect(history).not.toContain("no prompt-size shrink was detected");
  });

  it("treats a store without the revisions reader as unmeasurable rather than throwing", async () => {
    const fixture = createFixture(root, { durableRevisions: [{ revision: 1, content: specOfBytes(ACCEPTED_BYTES, "accepted") }] });
    delete (fixture.store as unknown as Record<string, unknown>).getTaskDocumentRevisions;
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(fixture.promptPath, specOfBytes(TRUNCATED_BYTES, "truncated"), "utf8");
    });

    await expect(new TriageProcessor(fixture.store, root).specifyTask(fixture.task())).resolves.toBeUndefined();

    const history = fixture.logged().join("\n");
    expect(history).toContain("could not be measured");
    expect(history).not.toContain("PLANNING_FAILED_SPEC_PROMPT_SHRUNK");
  });
});
