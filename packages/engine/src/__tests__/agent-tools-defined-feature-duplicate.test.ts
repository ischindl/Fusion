/**
 * FNXC:TombstoneDuplicateGuard 2026-11-17-16:16 (RUFU-583):
 * A CONSUMER OF THE FORENSIC READ MUST PROVE IT IGNORES WHAT THE READ RETURNED.
 *
 * `findDefinedFeatureBootstrapDuplicate` in `agent-tools.ts` calls
 * `store.listTasks({ includeDeleted: true })`, so the read hands it soft-deleted siblings, and the ONLY
 * thing standing between a deleted card and being adopted as a defined Feature's canonical is the
 * explicit `task.deletedAt` guard in that `flatMap`. Step 1 of RUFU-583 restored `includeDeleted` on the
 * list read, which makes that consumer reachable again through the path a spec could only describe as
 * "unproven but restored" — an assertion-free consumer sitting on a freshly re-opened fire hose.
 *
 * The pair below is what turns that into a proven guard: the same sibling fixture, with exactly one
 * field flipped (`deletedAt` present or absent), producing opposite verdicts. Delete the guard and the
 * tombstone case starts adopting a deleted card as canonical; weaken the fixture and the live case
 * stops adopting, and neither failure is silent.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskCreateTool, createTaskDeleteTool } from "../agent-tools.ts";

const LINEAGE = { mission_id: "M-001", slice_id: "SL-001", feature_id: "F-001" };
const DESCRIPTION = "Add the deterministic bootstrap probe";
const AGENT_ID = "agent-001";

/**
 * One sibling candidate, `deleted` flipping the single field the guard reads. Recent `createdAt` keeps
 * it inside the duplicate guard's 24-hour window, so the ONLY thing that can exclude it is the guard.
 */
function sibling(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "FN-SIBLING",
    title: DESCRIPTION,
    description: DESCRIPTION,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    sourceAgentId: AGENT_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as Task;
}

function bootstrapStore(candidate: Task): { store: TaskStore; claimCanonical: ReturnType<typeof vi.fn> } {
  const claimCanonical = vi.fn().mockResolvedValue({ id: "F-001", taskId: candidate.id, status: "triaged" });
  const missionStore = {
    getFeature: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "defined" }),
    getSlice: vi.fn().mockResolvedValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
    getMilestone: vi.fn().mockResolvedValue({ id: "MS-001", missionId: "M-001", status: "active" }),
    getMission: vi.fn().mockResolvedValue({ id: "M-001", status: "active" }),
    claimDefinedFeatureTaskInTransaction: vi.fn().mockResolvedValue({ id: "F-001", taskId: "FN-NEW" }),
    claimDefinedFeatureTask: claimCanonical,
    deleteDefinedFeatureBootstrapDuplicate: vi.fn().mockResolvedValue(undefined),
  };
  const created = {
    id: "FN-NEW",
    description: DESCRIPTION,
    dependencies: [],
    column: "triage" as const,
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
  const store = {
    getMissionStore: vi.fn().mockReturnValue(missionStore),
    getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    getDefaultWorkflowId: vi.fn().mockResolvedValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({ id: "proj-1" }),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    findRecentTasksByContentFingerprint: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([candidate]),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    createTask: vi.fn().mockImplementation(async (input: Task) => {
      await (input as unknown as {
        afterTaskInsert?: (tx: object, task: Task) => Promise<void>;
      }).afterTaskInsert?.({}, created);
      return created;
    }),
  } as unknown as TaskStore;
  return { store, claimCanonical };
}

async function runBootstrap(store: TaskStore) {
  return createTaskCreateTool(store, { sourceType: "agent", sourceAgentId: AGENT_ID }).execute(
    "call-1",
    { description: DESCRIPTION, mission_lineage: LINEAGE },
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

describe("defined-feature bootstrap duplicate guard and soft-deleted candidates (RUFU-583)", () => {
  it("refuses to adopt a soft-deleted sibling returned by the forensic read as canonical", async () => {
    const { store, claimCanonical } = bootstrapStore(
      sibling({ deletedAt: "2026-10-06T09:02:00.000Z" }),
    );

    const result = await runBootstrap(store);

    expect(result).not.toMatchObject({ isError: true });
    // The forensic read DID hand the guard this row; the guard is what rejected it.
    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeDeleted: true }));
    expect(claimCanonical).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "FN-SIBLING" }),
    );
    expect((result.details as { taskId?: string } | undefined)?.taskId).toBe("FN-NEW");
  });

  it("adopts the identical sibling when it is live, proving the guard and not the fixture decides", async () => {
    const { store, claimCanonical } = bootstrapStore(sibling());

    const result = await runBootstrap(store);

    expect(result).not.toMatchObject({ isError: true });
    expect(claimCanonical).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-SIBLING" }));
    expect((result.details as { taskId?: string } | undefined)?.taskId).toBe("FN-SIBLING");
    // Adopting the canonical means no second task row was created.
    expect(store.createTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:RefusedDeleteEnvelope 2026-11-17-16:16 (RUFU-583):
  A PIN on pre-existing tool wording, not a change to it. `fn_task_delete` reports a lineage refusal
  through the shared store-failure shape, and the thing RUFU-583 depends on is narrow: the refusal text
  reaches the caller and the tool does NOT report a deletion. Whether that sentence should read as a
  refusal rather than an unreachable store is a separate question about `storeErrorResult` and is
  deliberately not answered here (no schema change, no new tool parameter).
  */
  it("surfaces a lineage refusal as an error result instead of reporting a deletion", async () => {
    const lineageError = Object.assign(new Error("Task FN-583P has live lineage children"), {
      name: "TaskHasLineageChildrenError",
      childIds: ["FN-583C"],
    });
    const deleteTask = vi.fn().mockRejectedValue(lineageError);
    const store = { deleteTask } as unknown as TaskStore;

    const result = await createTaskDeleteTool(store).execute(
      "call-1",
      { id: "FN-583P" },
      undefined as never,
      undefined as never,
      undefined as never,
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("Task FN-583P has live lineage children");
    expect(result.details).not.toMatchObject({ taskId: "FN-583P" });
    // Default call carries no reference-removal waiver, which is what keeps the parent live.
    expect(deleteTask).toHaveBeenCalledWith("FN-583P", expect.objectContaining({
      removeLineageReferences: false,
    }));
  });
});
