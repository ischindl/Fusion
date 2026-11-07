import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { GridlockDetector } from "../healing/gridlock-detector.js";
import { lifecycleIr, RENAMED_VOCAB } from "./_workflow-vocabulary-fixture.js";

/*
FNXC:WorkflowSelectionBatching 2026-11-07-10:35 (RUFU-871):
The gridlock sweep resolved lifecycle for every card and IR for every card again, sharing an IR cache but
passing NO selection cache — so a pass over N cards issued N single `task_workflow_selection` SELECTs. The
production read-attribution seam had `workflowSelection` as its top seam at 72,309 reads in a 15-minute
window (≈80/s) on a board with zero running cards.

The assertion is on query COUNT, which is the only thing that separates a batched fill from an N+1: both
warm the same per-pass cache and both keep the contract that the next pass observes a selection write.
A `fields`/`slim` projection change would not fix this, and neither can a memo — a pass-level cache is
supposed to miss on the next pass.
*/

const WF = "gridlock-batching";
const SELECTION = { workflowId: WF, stepIds: [] };

function card(id: string, column: string): Task {
  return {
    id,
    title: `${id} card`,
    description: "",
    column,
    paused: false,
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

describe("gridlock sweep batches its workflow-selection reads (RUFU-871)", () => {
  it("reads a 12-card board in one batched query and never per card", async () => {
    const ir = lifecycleIr(RENAMED_VOCAB, WF);
    const board = [
      ...Array.from({ length: 6 }, (_, i) => card(`FN-${i}`, RENAMED_VOCAB.hold)),
      ...Array.from({ length: 6 }, (_, i) => card(`FN-1${i}`, RENAMED_VOCAB.complete)),
    ];

    const batch = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, SELECTION])));
    const singles = vi.fn(async () => SELECTION);
    const store = {
      listTasks: vi.fn(async () => board),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      parseFileScopeFromPrompt: vi.fn(async () => []),
      getTaskWorkflowSelectionsAsync: batch,
      getTaskWorkflowSelectionAsync: singles,
      getTaskWorkflowSelection: () => SELECTION,
      getWorkflowDefinition: vi.fn(async (id: string) => (id === WF ? { ir } : undefined)),
    } as unknown as TaskStore;

    // The sweep may return null (no gridlock); this test is about query counts, not the verdict.
    await new GridlockDetector(store, {}).detectGridlock();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(12);
    // The single reader must not be used by the sweep once the pass cache is warm.
    expect(singles).not.toHaveBeenCalled();
  });

  it("still resolves correctly when the store has no batch reader", async () => {
    const ir = lifecycleIr(RENAMED_VOCAB, WF);
    const board = [card("FN-1", RENAMED_VOCAB.hold), card("FN-2", RENAMED_VOCAB.complete)];
    const singles = vi.fn(async () => SELECTION);
    const store = {
      listTasks: vi.fn(async () => board),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      parseFileScopeFromPrompt: vi.fn(async () => []),
      getTaskWorkflowSelectionAsync: singles,
      getTaskWorkflowSelection: () => SELECTION,
      getWorkflowDefinition: vi.fn(async (id: string) => (id === WF ? { ir } : undefined)),
    } as unknown as TaskStore;

    await new GridlockDetector(store, {}).detectGridlock();

    // The fallback is the previous behaviour, not a crash and not a silent zero.
    expect(singles).toHaveBeenCalled();
  });
});
