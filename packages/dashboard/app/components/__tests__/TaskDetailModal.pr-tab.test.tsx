import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../PrPanel", () => ({
  PrPanel: () => <div data-testid="pr-panel-stub">PR Panel</div>,
}));

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal Pull Request tab", () => {
  it("shows Pull Request tab only for in-review tasks", () => {
    const { rerender } = render(
      <TaskDetailModal
        task={makeTask({ column: "todo" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Pull Request" })).toBeNull();

    rerender(
      <TaskDetailModal
        task={makeTask({ column: "in-review" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Pull Request" })).toBeInTheDocument();
  });

  it("shows a failed review reason even without top-level status", () => {
    render(<TaskDetailModal task={makeTask({ column: "in-review", status: undefined,
      enabledWorkflowSteps: ["code-review"], workflowStepResults: [{
        workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
        status: "failed", startedAt: "2026-09-20T00:00:00Z", output: "review-input-unprovable",
      }], inReviewStall: { code: "merge-blocker", reason: "failed gate", observedAt: "2026-09-20T00:00:00Z" },
    })} onClose={noop} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }));
    expect(screen.getByText("Code Review blocked")).toBeInTheDocument();
    expect(screen.getByText("review-input-unprovable")).toBeInTheDocument();
  });

  it("renders PrPanel and in-review stall badge in Pull Request tab, not Definition tab", () => {
    /*
    FNXC:TaskDetailStall 2026-08-22-03:12:
    The fixture must use a VISIBLE stall code: `merge-blocker` is in BADGE_SUPPRESSED_CODES (the
    badge is deliberately hidden for it), and the legacy `merge-failed` code plus signal-level
    retry counters were removed from InReviewStallSignal. `merge-retries-exhausted` is the valid
    visible code matching this fixture's "merge failed" story.
    */
    const inReviewStall = {
      code: "merge-retries-exhausted" as const,
      reason: "merge failed",
      observedAt: "2026-01-01T00:00:00Z",
    };

    const { container } = render(
      <TaskDetailModal
        task={makeTask({ column: "in-review", inReviewStall })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("pr-panel-stub")).toBeNull();
    expect(document.querySelector(".detail-in-review-stall")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }));

    expect(screen.getByTestId("pr-panel-stub")).toBeInTheDocument();
    expect(document.querySelector(".detail-in-review-stall")).toBeTruthy();
  });
});
