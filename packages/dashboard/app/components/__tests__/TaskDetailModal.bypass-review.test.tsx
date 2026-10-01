/*
FNXC:ReviewLaneBypass 2026-09-03-15:05 (RUFU-179):
Symptom Verification for the review-lane bypass affordance. The menu MODEL was covered by
TaskContextMenu.test.tsx, but nothing drove the operator path the bug report is about: opening the
task-detail Actions menu and ACTIVATING the item, which must open the audit-reason prompt and send
the trimmed reason to the store route. RUFU-179's new case (`kind: "absent"`, a required pre-merge
gate that never ran) must be activatable exactly like the historical `kind: "failed"` case, with copy
naming the decision actually being made. Cancel and a blank reason must send nothing: the reason is
mandatory and audit-logged server-side.

Every assertion goes through the rendered menu item, because an affordance that renders but cannot be
activated is the exact defect SANE-387 reported (the card was merge-blocked with no reachable escape).
*/
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReviewBypassTarget, Task } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const failedTarget: ReviewBypassTarget = {
  kind: "failed",
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
};
const unrunTarget: ReviewBypassTarget = {
  kind: "absent",
  workflowStepId: "plan-review",
  workflowStepName: "plan-review",
};

function stubPrompt(value: string | null): void {
  vi.spyOn(window, "prompt").mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskDetailModal review-lane bypass affordance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("activates the unrun-gate bypass from the detail Actions menu with the audit reason", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    const addToast = vi.fn();
    stubPrompt("  gate deadlocked by infra maintenance  ");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: unrunTarget })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={addToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    expect(window.prompt).toHaveBeenCalledWith(
      "Reason for bypassing the review gate that never ran (required, audit-logged):",
    );
    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-179", "gate deadlocked by infra maintenance"));
    expect(addToast).toHaveBeenCalledWith("Bypassed unrun review gate for FN-179", "success");
  });

  it("activates the failed-gate bypass with the verdict-rewrite copy", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    const addToast = vi.fn();
    stubPrompt("reviewer dispatched with no verdict");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: failedTarget })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={addToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass failed review" }));

    expect(window.prompt).toHaveBeenCalledWith(
      "Reason for bypassing the failed pre-merge review step (required, audit-logged):",
    );
    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-179", "reviewer dispatched with no verdict"));
    expect(addToast).toHaveBeenCalledWith("Bypassed failed review lane for FN-179", "success");
  });

  it("sends nothing when the operator cancels the reason prompt", async () => {
    const onBypassReview = vi.fn();
    stubPrompt(null);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: unrunTarget })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    await waitFor(() => expect(window.prompt).toHaveBeenCalled());
    expect(onBypassReview).not.toHaveBeenCalled();
  });

  it("sends nothing when the reason is blank after trimming", async () => {
    const onBypassReview = vi.fn();
    stubPrompt("   ");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: failedTarget })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass failed review" }));

    await waitFor(() => expect(window.prompt).toHaveBeenCalled());
    expect(onBypassReview).not.toHaveBeenCalled();
  });

  it("hides the item when the server withheld the capability", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          id: "FN-179",
          column: "in-review",
          workflowStepResults: [
            { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", phase: "pre-merge" },
          ] as Task["workflowStepResults"],
        })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={vi.fn()}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: /Bypass/ })).not.toBeInTheDocument();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-15:05 (RUFU-179):
  The mobile/popup task-detail path renders `TaskDetailContent` directly. FN-5751/FN-6123 are the
  motivating shape where a desktop-only fix left mobile without the affordance, so the same activation
  is pinned on this host too.
  */
  it("activates the bypass on the embedded mobile/popup detail host", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    stubPrompt("unrun gate cleared by operator");

    render(
      <TaskDetailContent
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: unrunTarget })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-179", "unrun gate cleared by operator"));
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:55 (RUFU-218):
  THE PARKED-CARD FIRE, on the host the operator actually uses. An engine park is the state in which a
  wedged review card MOST needs this escape — the engine froze automation and the card's own stall
  diagnostic tells the operator to "bypass this gate to clear the merge door" — yet every case above
  seeded an UNPAUSED task. That gap is exactly how RUFU-218 survived: the pause gate sat in the store
  and in the read-path hydration, and no UI test ever paired a pause flag with a capability, so the
  menu could have gone silent on parked cards (or stayed loud while the API refused) and nothing here
  would have noticed.

  The row carries `paused: true` with NO `userPaused` key, which is the shape the server actually ships
  for an engine park (`serializeTaskJson` drops a falsy `userPaused`). The client adds no pause gate of
  its own — the pause verdict arrives as the presence or absence of `reviewBypass` — so these cases also
  pin that no future "hide it while paused" edit can slip into a host unopposed.
  */
  it("activates the unrun-gate bypass from an engine-parked card's Actions menu", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    const addToast = vi.fn();
    stubPrompt("  stall deadlock: gate never ran  ");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: unrunTarget, paused: true })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={addToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    expect(window.prompt).toHaveBeenCalledWith(
      "Reason for bypassing the review gate that never ran (required, audit-logged):",
    );
    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-179", "stall deadlock: gate never ran"));
    expect(addToast).toHaveBeenCalledWith("Bypassed unrun review gate for FN-179", "success");
  });

  it("activates the failed-gate bypass from an engine-parked card's Actions menu", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    const addToast = vi.fn();
    stubPrompt("stall deadlock: reviewer dispatched with no verdict");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: failedTarget, paused: true })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={addToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass failed review" }));

    expect(window.prompt).toHaveBeenCalledWith(
      "Reason for bypassing the failed pre-merge review step (required, audit-logged):",
    );
    await waitFor(() =>
      expect(onBypassReview).toHaveBeenCalledWith("FN-179", "stall deadlock: reviewer dispatched with no verdict"),
    );
    expect(addToast).toHaveBeenCalledWith("Bypassed failed review lane for FN-179", "success");
  });

  it("activates the bypass on the embedded host for an engine-parked card", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-179" }) as Task);
    stubPrompt("parked gate cleared by operator");

    render(
      <TaskDetailContent
        task={makeTask({ id: "FN-179", column: "in-review", reviewBypass: unrunTarget, paused: true })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-179", "parked gate cleared by operator"));
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:55 (RUFU-218):
  THE WITHHELD MIRROR, and it must distinguish the two pause states the fire above cannot. A hand-set
  OPERATOR HOLD ships no capability, so the parked card that still shows the item and the held card
  that shows nothing are decided by the server's `isOperatorPausedForOperatorEscapeHatch` (RUFU-219
  gave it this hatch-neutral name) — the menu just
  renders the answer. Asserting the ABSENCE of every substitute (menuitem, disabled button shell,
  `role="note"` span, dangling `aria-label`) is mandatory: FN-7720's affordance first shipped as dead
  informational text, and a "this card is paused" note would be actively wrong advice here — a parked
  card may still be bypassable, which only the server knows.
  */
  it("renders no bypass affordance of any kind for an operator hold, even with a failed carrier in the payload", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          id: "FN-179",
          column: "in-review",
          paused: true,
          userPaused: true,
          workflowStepResults: [
            { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", phase: "pre-merge" },
          ] as Task["workflowStepResults"],
        })}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={vi.fn()}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));

    expect(screen.queryByRole("menuitem", { name: /Bypass/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bypass/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("note", { name: /Bypass/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Bypass/)).not.toBeInTheDocument();
  });
});
