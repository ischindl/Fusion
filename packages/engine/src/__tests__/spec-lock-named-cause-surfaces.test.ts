/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
A spec that lacks the spec lock's required section is parked by THREE surfaces — triage finalization, the
graph Plan Review node, and the dashboard human-approve route. Before this card each of them reported the
parser CODE only, so "why can this card never be approved?" had one answer for three different failures.

The fix is deliberately funnel-only: `TaskStore.lockCurrentPlanWhilePlanningLocked` is the single place
that constructs `UnavailablePlanLockError`, so classifying there is what every surface inherits. That
makes TWO claims worth pinning, and they fail in opposite directions:
  - a surface that stops reading the carried verdict silently regresses to the code-only sentence;
  - a NEW throw site that constructs the error without a verdict reintroduces the original defect.
So the named cause is asserted as behavior on the surface that writes operator history, and the funnel's
exclusivity plus each surface's funnel call is asserted as a code-construct guard.

The legacy byte contract is pinned alongside it: RUFU-534's shrink sentence and `task.error` belong to
another card and must come out of this path unchanged, probe or no probe.
*/
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizePlan,
  classifyCanonicalPlan,
  createCurrentPlanEvidence,
  UnavailablePlanLockError,
  type Settings,
  type SpecLockUnavailableVerdict,
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

const TASK_ID = "FN-5350";

const MISSION_LESS_SPEC = `# Task: ${TASK_ID} - A spec whose mission heading was never written

## File Scope

- packages/engine/src/triage.ts

## Steps

### Step 0: Preflight

- Verify the live inputs

## Completion Criteria

- [ ] The card is approvable
`;

/** The legacy History tail, byte-for-byte as RUFU-534 shipped it, so the probe cannot ride on it. */
const LEGACY_RETRY_HISTORY = /^PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing \(mission\); recording deterministic parser evidence and retrying once for changed prompt text\. .*\.$/;

function sourceHashFor(prompt: string): string {
  return createCurrentPlanEvidence({
    version: 1,
    sourceRevision: 1,
    capturedAt: "2026-11-19T00:00:00.000Z",
    prompt,
  }).sourceHash;
}

/** A verdict built the way the funnel builds one: the real parse of the real spec, through the same core classifier. */
function verdictFor(promptPath: string): SpecLockUnavailableVerdict {
  const verdict = classifyCanonicalPlan(canonicalizePlan(MISSION_LESS_SPEC), {
    taskId: TASK_ID,
    promptPath,
    paused: false,
    promptFileMissing: false,
    prompt: MISSION_LESS_SPEC,
  });
  if (verdict.status !== "unavailable") throw new Error("fixture must classify as unavailable");
  return verdict;
}

function createFixture(root: string, options: { withProbe: boolean }) {
  let task: Task = {
    id: TASK_ID,
    description: "Name the cause of an unavailable spec lock",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
  };
  const promptPath = join(root, ".fusion", "tasks", TASK_ID, "PROMPT.md");
  const update = async (_id: string, patch: Partial<Task>) => {
    task = { ...task, ...patch };
    return task;
  };
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
    // The funnel's real throw shape: reason + sections + sourceHash, and (post-RUFU-535) the verdict.
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      const prompt = await readFile(promptPath, "utf8");
      throw new UnavailablePlanLockError(
        "mission-missing",
        ["mission"],
        sourceHashFor(prompt),
        options.withProbe ? verdictFor(promptPath) : undefined,
      );
    }),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    getTaskDocumentRevisions: vi.fn(async () => [{ revision: 1, content: MISSION_LESS_SPEC }]),
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
  return {
    store,
    task: () => task,
    promptPath,
    logged: () => (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1])),
  };
}

/**
 * Every production `.ts` under a package, comment-stripped. The scan decides a CODE fact — is there a
 * second construction site? — and an FNXC note that merely mentions the constructor must not answer it.
 */
function productionSources(packageDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(packageDir);
  return found;
}

/** Comments stripped, so the guard reads code and not the prose that describes it. */
function codeOnly(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the spec-lock named cause is authored once and inherited by every approval surface (RUFU-535)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-spec-lock-surface-"));
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

  it("writes the named cause on the card's History while task.error keeps its legacy bytes", async () => {
    // The identical-parse branch is the one that PARKS, so it is where both halves of the contract meet:
    // the History line may grow, the terminal error may not. The first pass records the parse evidence
    // through the store itself, so the second pass compares against the hash the funnel actually wrote.
    const fixture = createFixture(root, { withProbe: true });
    await writeFile(fixture.promptPath, MISSION_LESS_SPEC, "utf8");
    mockPromptWithFallback.mockImplementation(async () => undefined);
    const triage = new TriageProcessor(fixture.store, root);

    await triage.specifyTask(fixture.task());
    expect(fixture.task().error).toBeNull();

    await triage.specifyTask(fixture.task());

    const history = fixture.logged().join("\n");
    expect(history).toContain("identical prompt parse verdict repeated");
    expect(history).toContain("can never be plan-approved as written");
    expect(history).toContain("## Mission");
    expect(history).toContain(fixture.promptPath);
    // RUFU-534's size clause and the parked error are another card's contract and stay untouched.
    expect(history).toContain("Operator description headings are not the cause");
    expect(fixture.task().error).toBe("PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)");
  });

  it("keeps the History line byte-identical when no verdict is carried", async () => {
    const fixture = createFixture(root, { withProbe: false });
    await writeFile(fixture.promptPath, MISSION_LESS_SPEC, "utf8");
    mockPromptWithFallback.mockImplementation(async () => undefined);

    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const history = fixture.logged().join("\n");
    expect(history).not.toContain("plan-approved");
    expect(history).not.toContain(fixture.promptPath);
    const retryLine = fixture.logged().find((line) => line.includes("retrying once for changed prompt text"));
    expect(retryLine).toBeDefined();
    expect(retryLine!).toMatch(LEGACY_RETRY_HISTORY);
  });

  it("has exactly one construction site, and every approval surface routes through it", () => {
    const workspaceRoot = join(import.meta.dirname, "../../../..");
    const sources = [
      ...productionSources(join(workspaceRoot, "packages/core/src")),
      ...productionSources(join(workspaceRoot, "packages/engine/src")),
      ...productionSources(join(workspaceRoot, "packages/dashboard/src")),
    ];

    const throwSites = sources.filter((path) => codeOnly(path).includes("new UnavailablePlanLockError("));
    expect(throwSites.map((path) => path.slice(workspaceRoot.length + 1))).toEqual([
      join("packages/core/src/store.ts"),
    ]);

    // Three surfaces, one funnel: each approves through `lockCurrentPlanWhilePlanningLocked`, so each
    // inherits the verdict without owning a second opinion about what a spec parse means.
    const surfaces = [
      join("packages/engine/src/triage.ts"),
      join("packages/engine/src/executor/execute-workflow-graph.ts"),
      join("packages/dashboard/src/routes/register-task-workflow-routes.ts"),
    ];
    for (const surface of surfaces) {
      expect(codeOnly(join(workspaceRoot, surface))).toContain("lockCurrentPlanWhilePlanningLocked(");
    }

    // The two surfaces that report the refusal read the carried verdict. The human-approve route is NOT
    // one of them and is asserted as such below: it never inspects the error type, so what reaches its
    // caller is the error text the funnel composes — the honest limit of "inherits without editing".
    for (const surface of surfaces.slice(0, 2)) {
      expect(codeOnly(join(workspaceRoot, surface))).toContain(".probe");
    }
    expect(codeOnly(join(workspaceRoot, surfaces[2]!))).not.toContain(".probe");
  });
});
