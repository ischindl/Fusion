import { describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  mergePartialBoardWorkflows,
  useBoardWorkflows,
  type UseBoardWorkflowsParams,
  type UseBoardWorkflowsResult,
} from "../hooks/useBoardWorkflows";

/*
FNXC:BoardWorkflows 2026-10-01-21:51:
`GET /tasks/board-workflows` used to answer a NAMED-id request by scanning the whole current-task table,
so the lazy "map these visible cards" repair cost as much as asking for everything — measured 14.2 s to
return 241 mappings when ONE card was named. `?taskIds=…&partial=1` answers exactly the named ids, and the
price of that bound is a merge contract: a partial response describes only the ids asked about, so applying
it like a full response would DELETE lanes that still hold cards.

These cases pin the merge contract at the level the operator would feel: the lane set survives a partial
answer, a card's mapping is refreshed, lane ORDER does not move, and the partial path neither clears nor
overwrites the cached payload the next reload hydrates from.
*/

const LANE_A = { id: "builtin:coding", name: "Coding", columns: [] } as never;
const LANE_B = { id: "custom:research", name: "Research", columns: [] } as never;

function fullPayload() {
  return {
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [LANE_A, LANE_B],
    taskWorkflowIds: { "RUFU-1": "builtin:coding" },
  };
}

function partialPayload() {
  return {
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    // Only the workflow the requested card belongs to — a subset of the lanes on screen.
    workflows: [LANE_B],
    taskWorkflowIds: { "RUFU-2": "custom:research" },
  };
}

describe("mergePartialBoardWorkflows", () => {
  it("adds the named mapping without shrinking or reordering the lane set", () => {
    const merged = mergePartialBoardWorkflows(fullPayload() as never, partialPayload() as never);
    expect(merged.workflows.map((w: { id: string }) => w.id)).toEqual(["builtin:coding", "custom:research"]);
    expect(merged.taskWorkflowIds).toEqual({ "RUFU-1": "builtin:coding", "RUFU-2": "custom:research" });
  });

  it("refreshes a card's lane rather than keeping the stale one", () => {
    const stale = { ...fullPayload(), taskWorkflowIds: { "RUFU-2": "builtin:coding" } } as never;
    const merged = mergePartialBoardWorkflows(stale, partialPayload() as never);
    expect(merged.taskWorkflowIds["RUFU-2"]).toBe("custom:research");
  });

  it("treats a flag-off answer as authoritative in both directions", () => {
    const off = { flagEnabled: false } as never;
    expect(mergePartialBoardWorkflows(fullPayload() as never, off).flagEnabled).toBe(false);
    expect(mergePartialBoardWorkflows(off, fullPayload() as never).flagEnabled).toBe(true);
  });
});

function Harness({ deps, onResult }: { deps: UseBoardWorkflowsParams; onResult: (r: UseBoardWorkflowsResult) => void }) {
  const result = useBoardWorkflows(deps);
  useEffect(() => {
    onResult(result);
  });
  return null;
}

describe("useBoardWorkflows partial refresh", () => {
  it("applies a partial answer as a patch: lanes survive, mapping grows, cache is not cleared", async () => {
    const fetchBoardWorkflows = vi.fn(async (_projectId?: string, options?: { taskIds?: readonly string[]; partial?: boolean }) =>
      options?.partial ? partialPayload() : fullPayload(),
    ) as never;
    const subscribeSse = vi.fn(() => () => {}) as never;
    const readBoardWorkflowsCache = vi.fn(() => null) as never;
    const writeBoardWorkflowsCache = vi.fn() as never;
    const clearBoardWorkflowsCache = vi.fn() as never;
    const persistBoardWorkflowSelection = vi.fn() as never;

    let latest: UseBoardWorkflowsResult | undefined;
    render(
      <Harness
        deps={{
          projectId: "proj-1",
          fetchBoardWorkflows,
          subscribeSse,
          readBoardWorkflowsCache,
          writeBoardWorkflowsCache,
          clearBoardWorkflowsCache,
          persistBoardWorkflowSelection,
        }}
        onResult={(r) => {
          latest = r;
        }}
      />,
    );

    await waitFor(() => expect(latest?.boardWorkflows?.workflows).toHaveLength(2));

    await act(async () => {
      await latest?.refreshBoardWorkflows({ taskIds: ["RUFU-2"], partial: true });
    });

    expect(latest?.boardWorkflows?.workflows).toHaveLength(2);
    expect(latest?.boardWorkflows?.taskWorkflowIds).toEqual({ "RUFU-1": "builtin:coding", "RUFU-2": "custom:research" });
    expect(fetchBoardWorkflows).toHaveBeenLastCalledWith("proj-1", { taskIds: ["RUFU-2"], partial: true });
    // The cached payload a reload hydrates from must be the merged one, not the subset.
    expect(writeBoardWorkflowsCache).toHaveBeenLastCalledWith(
      "proj-1",
      expect.objectContaining({ workflows: expect.arrayContaining([LANE_A, LANE_B]) }),
    );
    // forceFresh semantics must not be reachable from the partial path, or the merge would have nothing to keep.
    expect(clearBoardWorkflowsCache).not.toHaveBeenCalled();
  });

  it("keeps replacing on the unbounded path, so a card that moved workflow does not inherit a stale lane", async () => {
    const moved = {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [LANE_A],
      taskWorkflowIds: { "RUFU-1": "custom:research" },
    };
    const fetchBoardWorkflows = vi
      .fn(async () => fullPayload())
      .mockResolvedValueOnce(moved) as never;
    const subscribeSse = vi.fn(() => () => {}) as never;
    const readBoardWorkflowsCache = vi.fn(() => null) as never;
    const writeBoardWorkflowsCache = vi.fn() as never;
    const clearBoardWorkflowsCache = vi.fn() as never;
    const persistBoardWorkflowSelection = vi.fn() as never;

    let latest: UseBoardWorkflowsResult | undefined;
    render(
      <Harness
        deps={{
          projectId: "proj-1",
          fetchBoardWorkflows,
          subscribeSse,
          readBoardWorkflowsCache,
          writeBoardWorkflowsCache,
          clearBoardWorkflowsCache,
          persistBoardWorkflowSelection,
        }}
        onResult={(r) => {
          latest = r;
        }}
      />,
    );

    await waitFor(() => expect(latest?.boardWorkflows?.taskWorkflowIds?.["RUFU-1"]).toBe("custom:research"));

    await act(async () => {
      await latest?.refreshBoardWorkflows();
    });

    expect(latest?.boardWorkflows?.workflows).toHaveLength(2);
    // The unbounded answer REPLACES: RUFU-1 returns to the default lane the server actually reports.
    expect(latest?.boardWorkflows?.taskWorkflowIds).toEqual({ "RUFU-1": "builtin:coding" });
  });
});
