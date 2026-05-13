import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("TaskDetailModal GitHub tracking CTA", () => {
  it("disables create tracking issue when task has no usable title", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    const button = screen.getByRole("button", { name: "Create tracking issue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Add a title or description so a tracking issue can be created.");
    expect(screen.getByText("Tracking issue will be created once this task has a title or description to summarize.")).toBeInTheDocument();
  });

  it("enables create tracking issue when task title is present", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "Real title",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });

  it("enables create tracking issue when task description has a non-empty first line", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "A meaningful first line.\nMore text.",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });
});
