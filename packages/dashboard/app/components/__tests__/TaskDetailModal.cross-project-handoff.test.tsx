import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02:
RUFU-203 modal-surface contract:
- TARGET card (`sourceType:"cross_project_handoff"` + `handoffFrom` pointer) reads
  "From <projectName> · <source id>" — NOT the "Created via … of <id>" shape, because the id
  click must deep-link into the SOURCE project (an in-current-project fetch dead-ends).
- SOURCE card (`transferredTo` pointer) shows the transferred chip in its metadata section.
*/

const handoffPointer = {
  projectId: "proj-stash",
  projectName: "STASH",
  taskId: "STAS-042",
  transferredAt: "2026-09-01T10:00:00.000Z",
};

async function renderModal(task: ReturnType<typeof makeTask>) {
  // The modal re-reads its task via fetchTaskDetail on mount; without this the helper's default
  // fixture (no sourceType/pointers) would overwrite the surface under test.
  const api = await import("../../api");
  vi.mocked(api.fetchTaskDetail).mockResolvedValue(task as never);
  return render(
    <TaskDetailModal
      task={task}
      initialTab="details"
      onClose={noop}
      onDeleteTask={vi.fn(async () => makeTask())}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskDetailModal cross-project handoff surfaces", () => {
  it("target card reads From <project> · <source id> and deep-links the id click", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:4040/?project=proj-fusion", assign });
    const user = userEvent.setup();
    await renderModal(
      makeTask({
        sourceType: "cross_project_handoff" as never,
        sourceParentTaskId: "STAS-042",
        sourceMetadata: { handoffFrom: handoffPointer } as never,
      }),
    );

    expect(screen.getByText(/From/)).toBeTruthy();
    expect(screen.getByText("STASH")).toBeTruthy();
    expect(screen.queryByText(/Created via/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "STAS-042" }));
    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(assign.mock.calls[0][0] as string);
    expect(url.searchParams.get("project")).toBe("proj-stash");
    expect(url.searchParams.get("task")).toBe("STAS-042");
  });

  it("non-handoff provenance keeps the Created via shape (control)", async () => {
    await renderModal(makeTask({ sourceType: "task_duplicate" as never, sourceParentTaskId: "FN-098" }));
    expect(screen.getByText(/Created via/)).toBeTruthy();
    expect(screen.queryByText(/From/)).toBeNull();
    expect(screen.queryByText("STASH")).toBeNull();
  });

  it("source card shows the transferred chip with one chip per pointer", async () => {
    await renderModal(
      makeTask({
        sourceMetadata: {
          transferredTo: [handoffPointer, { ...handoffPointer, projectId: "proj-keel", projectName: "KEEL", taskId: "KEE-007" }],
        } as never,
      }),
    );
    expect(screen.getByTestId("transferred-badge-STAS-042")).toBeTruthy();
    expect(screen.getByTestId("transferred-badge-KEE-007")).toBeTruthy();
  });

  it("card without pointers shows neither the clause nor a chip (absent state)", async () => {
    await renderModal(makeTask());
    expect(screen.queryByTestId(/transferred-badge-/)).toBeNull();
    expect(screen.queryByText("STASH")).toBeNull();
  });
});
