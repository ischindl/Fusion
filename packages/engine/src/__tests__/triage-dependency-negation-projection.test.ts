/*
 * Finalizer-seam tests for the `## Dependencies` projection (RUFU-750).
 *
 * FNXC:DependencyProjection 2026-11-13-19:11:
 * The reported defect is not in the parser alone: the planning finalizer is what writes the projected
 * ids onto the row, and the store turns a newly appearing id into `hasNewDeps` -> lane move plus the
 * history line "Re-seeded for re-specification - new dependency added". A card whose own specification
 * wrote "not a dependency" therefore blocked behind a card it never waits for, and every later planning
 * pass restored the edge, so the card re-planned itself forever (RUFU-747, passes 17:07:31->17:07:48 and
 * 17:33:10->17:33:26).
 *
 * These cases drive the REAL planning entry (`recoverApprovedTask`) over a fixture `PROMPT.md` that
 * carries the actual bullet shapes, and capture the patch off the store's `updateTask` calls. The store's
 * dependency reader delegates to the same pure projection production uses, so no mocked verdict can
 * disagree with the fixture text the finalizer also reads. They pin both halves of the invariant: a
 * denied bullet contributes no edge, and an edge an earlier prose-blind pass already stamped on the row
 * converges on the next pass WITHOUT the finalizer ever clearing an edge the specification does not deny.
 *
 * The harness deliberately leaves `updateTaskAtomic` off the store fixture, as the FN-513 finalizer
 * harness does, so `updatePlanningStateIfStillCurrent` takes its compatibility branch and materializes
 * the function patch through `store.updateTask`. Production stores take the atomic branch; what is proved
 * here is the patch CONTENT, which both branches compute from the same callback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskStore, Task, Settings } from "@fusion/core";
import { projectDependencyBindingsFromPromptText } from "@fusion/core";
import { TriageProcessor } from "../triage.js";
import { join } from "node:path";
import { mkdir, writeFile, rm, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const CARD_ID = "FN-501";

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fusion-triage-dep-negation-"));
}

/** The RUFU-747 bullets, hand-typed into the fixture: one long positive parent plus two denials. */
const POSITIVE_AND_DENIED = [
  "- **Task:** FN-293 (parent, `in-review`; source of the commits on its branch). Its Code Review gate is",
  "  already approved, so this card carries that verdict and does not re-resolve any of it.",
  "- **Task:** FN-281 - **not a dependency**, despite the board listing. Same defect class, different",
  "  exemplar; the operator keeps it untouched.",
].join("\n");

const WHOLLY_DENIED = [
  "- **Task:** FN-281 - **not a dependency**, despite the board listing.",
  "- **Task:** FN-294 - already landed inside the parent range. Not a blocker to start.",
].join("\n");

/** A specification section where every bullet states a real wait. */
const ALL_POSITIVE = [
  "- **Task:** FN-293 (blocked by its landing) - the migration slot is only free once it lands.",
  "- **Task:** FN-294 - prerequisite for the reader that consumes the new column.",
].join("\n");

function promptWith(body: string): string {
  return [
    `# Task: ${CARD_ID} - dependency projection fixture`,
    "",
    "**Size:** M",
    "**No commits expected:** true",
    "",
    "## Review Level: 2",
    "",
    "## What This Delivers",
    "",
    "- A dependency edge only where the specification waits for another card.",
    "",
    "## Dependencies",
    "",
    body,
    "",
    "## Context to Read First",
    "",
    "- `packages/core/src/task-store/dependency-projection.ts`",
    "",
  ].join("\n");
}

describe("RUFU-750 planning finalizer dependency projection", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createFixtureRoot();
    await mkdir(join(rootDir, ".fusion", "tasks", CARD_ID), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  /**
   * Runs the real planning entry over a real fixture and returns the last patch that carried a
   * `dependencies` key, or undefined when no write carried one.
   */
  async function finalize(input: {
    promptBody: string;
    dependencies: string[];
    /** Rows returned by successive `getTask` reads; models a writer landing an edge mid-run. */
    liveRows?: Partial<Task>[];
    sourceType?: string;
    sourceParentTaskId?: string;
    sourceMetadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const promptPath = join(rootDir, ".fusion", "tasks", CARD_ID, "PROMPT.md");
    await writeFile(promptPath, promptWith(input.promptBody), "utf-8");

    const row: Task = {
      id: CARD_ID,
      description: "Dependency projection fixture",
      column: "triage",
      status: "planning",
      dependencies: input.dependencies,
      sourceType: input.sourceType,
      sourceParentTaskId: input.sourceParentTaskId,
      sourceMetadata: input.sourceMetadata,
      steps: [],
      currentStep: 0,
      log: [
        { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review requested" },
        { timestamp: "2026-01-01T00:01:00.000Z", action: "Spec review: APPROVE" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    } as Task;

    const store: Partial<TaskStore> = {
      getTask: vi.fn(async () => row),
      listTasks: vi.fn().mockResolvedValue([]),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordActivity: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10_000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      isBackendMode: vi.fn(() => false),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      withTaskLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
      readTaskForMove: vi.fn(async (id: string) => ({ id, column: "triage", status: "planning" } as Task)),
      updateTask: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      emit: vi.fn(),
      // Same decision production's store reader makes, over the same bytes the finalizer reads.
      parseDependenciesFromPrompt: vi.fn(async () =>
        projectDependencyBindingsFromPromptText(await readFile(promptPath, "utf-8")).projected),
    };

    if (input.liveRows) {
      // Successive reads see successive rows: the finalizer re-reads once for its own fence, and the
      // write seam re-reads under the task lock. Handing the two reads different rows is what models a
      // concurrent writer landing an edge in between.
      const rows = input.liveRows;
      let read = 0;
      store.getTask = vi.fn(async () => {
        const override = rows[Math.min(read, rows.length - 1)] ?? {};
        read += 1;
        return { ...row, ...override } as Task;
      });
    }

    await new TriageProcessor(store as TaskStore, rootDir).recoverApprovedTask(row);

    return (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .filter(([id, patch]) => id === CARD_ID && patch && Object.prototype.hasOwnProperty.call(patch, "dependencies"))
      .map(([, patch]) => patch as Record<string, unknown>)
      .at(-1);
  }

  it("writes no edge for a denied bullet while keeping the waited-for one", async () => {
    const patch = await finalize({
      promptBody: POSITIVE_AND_DENIED,
      dependencies: [],
    });

    expect(patch?.dependencies).toEqual(["FN-293"]);
  });

  it("shrinks the row to the projected set when the section is wholly denied and the row carries a false edge", async () => {
    const patch = await finalize({
      promptBody: WHOLLY_DENIED,
      dependencies: ["FN-281", "FN-294"],
    });

    expect(patch?.dependencies).toEqual([]);
    // A shrink is not a status change: the patch carries the finalizer's ordinary fields and nothing
    // that pretends to be a lifecycle move.
    expect(patch).not.toHaveProperty("column");
    expect(patch).not.toHaveProperty("status");
  });

  it("writes no dependencies key at all when the denial matches nothing on the row", async () => {
    const patch = await finalize({
      promptBody: WHOLLY_DENIED,
      dependencies: ["FN-999"],
    });

    expect(patch).toBeUndefined();
  });

  it("keeps an id whose bullet is both denied and positive, because the wait is the deliberate statement", async () => {
    const patch = await finalize({
      promptBody: [
        "- **Task:** FN-293 - **not a dependency** for the release lane itself.",
        "- **Task:** FN-293 (blocked by its landing) - the migration slot is only free once it lands.",
      ].join("\n"),
      dependencies: [],
    });

    expect(patch?.dependencies).toEqual(["FN-293"]);
  });

  it("never prunes a follow-up's parent edge, which the lineage states more deliberately than prose", async () => {
    const patch = await finalize({
      promptBody: "- **Task:** FN-293 - informational only, its commits are already in my range.",
      dependencies: ["FN-293"],
      sourceType: "task_refine",
      sourceParentTaskId: "FN-293",
      sourceMetadata: { followUp: { version: 1 } },
    });

    expect(patch).toBeUndefined();
  });

  it("keeps an edge another writer added while the planner ran, because the shrink bases on the live row", async () => {
    // Read 1 is the finalizer's own re-read (no FN-777 yet); read 2 is the row inside the task lock,
    // after a concurrent writer added FN-777. A shrink computed from the cached row would drop it.
    const patch = await finalize({
      promptBody: WHOLLY_DENIED,
      dependencies: ["FN-281"],
      liveRows: [{ dependencies: ["FN-281"] }, { dependencies: ["FN-281", "FN-777"] }],
    });

    expect(patch?.dependencies).toEqual(["FN-777"]);
  });

  it("still writes every edge when no bullet denies anything", async () => {
    const patch = await finalize({
      promptBody: ALL_POSITIVE,
      dependencies: [],
    });

    expect(patch?.dependencies).toEqual(["FN-293", "FN-294"]);
  });
});
