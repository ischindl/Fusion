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

/*
FNXC:PostMergeGateOperatorWaiver 2026-11-14-02:10 (RUFU-599 Step 7, reproductions 1 and 2 / RUFU-474):
The carrier the reported cards actually had: a REQUIRED POST-MERGE gate whose row ended `skipped` owing a verdict.
Steps 2-3 made the server offer a waiver for it, and the surfaces still spelled their copy from `kind === "absent"`,
so the only escape hatch on such a card was reached by a menu row and an audit prompt that both described a failed
PRE-merge step. This fixture is what the offer looks like on the wire.
*/
const postMergeCarrierTarget = {
  kind: "verdictless-skipped",
  workflowStepId: "post-merge-verification",
  workflowStepName: "Post-merge Verification",
  phase: "post-merge",
} as ReviewBypassTarget;

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

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-11-14-02:10 (RUFU-599 Step 7, reproductions 1 and 2 / RUFU-474):
  The operator path this card exists for: the only remaining action on a card blocked by a required post-merge
  gate that never reported is this waiver, and it has to be activatable with words that match the row. Pinned as
  the real three-step interaction (menu item -> audit prompt -> trimmed reason to the store route) plus a toast that
  never claims a pre-merge step, because the toast is what the operator reads after clicking and the audit reason
  is what the card's history quotes afterwards.
  */
  it("activates the post-merge carrier waiver with copy that never claims a failed pre-merge step", async () => {
    const onBypassReview = vi.fn().mockResolvedValue(makeTask({ id: "FN-474" }) as Task);
    const addToast = vi.fn();
    stubPrompt("  delivery proven by recorded workspace evidence  ");

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-474", column: "in-review", reviewBypass: postMergeCarrierTarget })}
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Waive post-merge gate that never reported" }));

    const promptMessage = (window.prompt as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(promptMessage).toContain("post-merge");
    expect(promptMessage).toContain("without a verdict");
    expect(promptMessage).not.toContain("pre-merge");

    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-474", "delivery proven by recorded workspace evidence"));
    const toast = addToast.mock.calls.find((call) => call[1] === "success");
    expect(toast?.[0]).toContain("post-merge");
    expect(toast?.[0]).not.toMatch(/pre-merge|failed/);
  });

  it("sends nothing when the operator cancels the reason prompt", async () => {
    const onBypassReview = vi.fn();    stubPrompt(null);

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
  FNXC:ReviewBypassDecline 2026-11-17-18:35 (RUFU-583, folded from RUFU-243):
  THE WITHHELD MIRROR, REVISED: it still must distinguish the two pause states the fire above cannot, but the
  contract it pins is no longer "nothing is said". A hand-set OPERATOR HOLD ships no capability, so no affordance
  may appear - and RUFU-243's measured complaint was precisely that this was indistinguishable from a card whose
  server read broke, or from one whose gates had all passed: no item, no sentence, and a POST that answered
  `task is paused`. The server now ships `reviewBypassDecline`, and this card says WHY in one line.

  The three absences stay mandatory and are the reason this is not just a new-text test: FN-7720's affordance
  first shipped as dead informational text inside the action list, so an explanation that arrived as a
  `tone: "note"` descriptor, a disabled button, or an empty shell would re-create that defect while looking
  fixed. Hence: the sentence exists, and nothing carrying it is a menuitem or a button.

  The engine-park half is kept on purpose. `paused: true` with no `userPaused` is the shape the server ships for
  an engine park, and it still gets the capability - so a future edit that explains a hold must not start
  explaining (or hiding the offer on) a parked card, which is the RUFU-218 bug seen from the copy side.
  */
  it("names the operator hold instead of refusing in silence, without shipping a dead affordance", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          id: "FN-179",
          column: "in-review",
          paused: true,
          userPaused: true,
          reviewBypassDecline: { reason: "operator-task-hold" },
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

    const hint = screen.getByTestId("task-bypass-review-decline-hint");
    expect(hint.textContent).toMatch(/hold this card by hand/i);
    // Named by the refusal class, not by a generic "something went wrong".
    expect(hint.textContent).toMatch(/Unpause/i);

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));

    // No affordance of any shape: no item, no button shell, no note-styled row inside the item list.
    expect(screen.queryByRole("menuitem", { name: /Bypass|Waive/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bypass|Waive/ })).not.toBeInTheDocument();
    // The explanation is a note the container owns; it must never be reachable as an action.
    expect(hint.closest("button")).toBeNull();
    expect(hint.getAttribute("role")).toBe("note");
  });

  it("explains the hold on the phone sheet too, and inside the Actions menu that withheld the item", () => {
    /*
    FNXC:ReviewBypassDecline 2026-11-17-18:35 (RUFU-583): the mobile half of the same contract. `TaskDetailContent
    embedded` is the host the phone sheet and the drawer render, and the menu line is a second surface: an
    operator scanning the open menu should not have to close it to learn why the row is missing.
    */
    render(
      <TaskDetailContent
        task={makeTask({
          id: "FN-243",
          column: "in-review",
          paused: true,
          userPaused: true,
          reviewBypassDecline: { reason: "operator-task-hold" },
        })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={vi.fn()}
        addToast={noop}
      />,
    );

    expect(screen.getByTestId("task-bypass-review-decline-hint").textContent).toMatch(/hold this card by hand/i);

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const menuHint = screen.getByTestId("task-actions-menu-bypass-decline-hint");
    expect(menuHint.textContent).toMatch(/hold this card by hand/i);
    expect(menuHint.tagName.toLowerCase()).toBe("p");
    expect(screen.queryByRole("menuitem", { name: /Bypass|Waive/ })).not.toBeInTheDocument();
  });

  it("says something DIFFERENT for each refusal class, including the one the workflow read causes", () => {
    /*
    FNXC:ReviewBypassDecline 2026-11-17-18:35 (RUFU-583): the classes must not collapse into one sentence. The
    `workflow-ir-unreadable` case is the one that matters most - it is the class a board can only learn by
    failing to read a definition, and until RUFU-583 it reached the operator as "nothing is refusing".
    */
    const renderDecline = (reason: "operator-task-hold" | "workflow-ir-unreadable" | "no-refusing-gate") => {
      const view = render(
        <TaskDetailContent
          task={makeTask({ id: "FN-583", column: "in-review", reviewBypassDecline: { reason } })}
          initialTab="definition"
          embedded
          onRequestClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onBypassReview={vi.fn()}
          addToast={noop}
        />,
      );
      const text = view.getByTestId("task-bypass-review-decline-hint").textContent ?? "";
      view.unmount();
      return text;
    };

    const held = renderDecline("operator-task-hold");
    const unreadable = renderDecline("workflow-ir-unreadable");
    const nothingRefusing = renderDecline("no-refusing-gate");

    expect(held).not.toBe("");
    expect(unreadable).not.toBe("");
    expect(nothingRefusing).not.toBe("");
    expect(new Set([held, unreadable, nothingRefusing]).size).toBe(3);
    expect(unreadable).toMatch(/workflow/i);
    expect(unreadable).not.toMatch(/hold this card by hand/i);
  });

  it("says nothing on a card the server declined for no reason at all, and on an engine park that keeps its offer", () => {
    /*
    The absence half, so this cannot become ambient copy on every card: a healthy payload carries no decline, and
    an engine park carries the capability instead. Neither renders a line.
    */
    const { unmount } = render(
      <TaskDetailContent
        task={makeTask({ id: "FN-583", column: "in-review" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={vi.fn()}
        addToast={noop}
      />,
    );
    expect(screen.queryByTestId("task-bypass-review-decline-hint")).not.toBeInTheDocument();
    unmount();

    render(
      <TaskDetailContent
        task={makeTask({ id: "FN-218", column: "in-review", paused: true, reviewBypass: unrunTarget })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={vi.fn()}
        addToast={noop}
      />,
    );
    expect(screen.queryByTestId("task-bypass-review-decline-hint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-actions-menu-bypass-decline-hint")).not.toBeInTheDocument();
  });
});
