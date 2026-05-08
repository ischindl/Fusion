import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";

const apiMocks = vi.hoisted(() => ({
  refreshTaskReview: vi.fn(),
  reviseTaskReviewItems: vi.fn(),
}));

vi.mock("../../api", () => ({
  refreshTaskReview: apiMocks.refreshTaskReview,
  reviseTaskReviewItems: apiMocks.reviseTaskReviewItems,
}));

describe("TaskReviewTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when review is missing", () => {
    render(<TaskReviewTab task={makeTask({ review: undefined })} addToast={vi.fn()} />);
    expect(screen.getByText("No review items yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  });

  it("calls refresh endpoint", async () => {
    const task = makeTask({ review: { mode: "direct", source: "reviewer-agent", decision: "pending", items: [] } });
    apiMocks.refreshTaskReview.mockResolvedValue({ review: task.review, automationStatus: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(apiMocks.refreshTaskReview).toHaveBeenCalledWith(task.id, undefined);
  });

  it("renders PR decision and status modifiers", () => {
    const task = makeTask({
      review: {
        mode: "pull-request",
        source: "github-pr",
        decision: "changes-requested",
        summary: "Needs updates",
        items: [
          {
            id: "ri-1",
            source: "github-pr",
            status: "failed",
            summary: "Fix null handling",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(screen.getByText("changes requested")).toBeInTheDocument();
    expect(screen.getByText("failed").className).toContain("task-review-tab__status--failed");
  });

  it("renders review items and queues revision for selected entries", async () => {
    const task = makeTask({
      review: {
        mode: "pull-request",
        source: "github-pr",
        decision: "changes-requested",
        summary: "Needs updates",
        items: [
          {
            id: "ri-1",
            source: "github-pr",
            status: "queued",
            summary: "Fix null handling",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    apiMocks.reviseTaskReviewItems.mockResolvedValue({ task, review: task.review });
    apiMocks.refreshTaskReview.mockResolvedValue({ review: task.review, automationStatus: null });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, ["ri-1"], undefined);
  });
});
