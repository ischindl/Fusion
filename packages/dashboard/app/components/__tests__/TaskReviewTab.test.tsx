import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";

const apiMocks = vi.hoisted(() => ({
  fetchTaskReview: vi.fn(),
  refreshTaskReview: vi.fn(),
  reviseTaskReviewItems: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchTaskReview: apiMocks.fetchTaskReview,
  refreshTaskReview: apiMocks.refreshTaskReview,
  reviseTaskReviewItems: apiMocks.reviseTaskReviewItems,
}));

describe("TaskReviewTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders direct-mode empty state when no reviewer feedback exists", async () => {
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: { source: "reviewer-agent", items: [], addressing: [] },
      automationStatus: null,
      emptyMessage: "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.",
    });

    render(<TaskReviewTab task={makeTask({ reviewState: undefined })} addToast={vi.fn()} />);
    expect(await screen.findByText("No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  });

  it("calls refresh endpoint", async () => {
    const task = makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.refreshTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(apiMocks.refreshTaskReview).toHaveBeenCalledWith(task.id, undefined);
  });

  it("renders PR decision and status modifiers", async () => {
    const task = makeTask({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [
          {
            id: "ri-1",
            body: "Fix null handling",
            author: { login: "reviewer" },
            createdAt: new Date().toISOString(),
          },
        ],
        addressing: [{ itemId: "ri-1", status: "failed", selectedAt: new Date().toISOString() }],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    await screen.findByText("CHANGES_REQUESTED");
    expect(screen.getByText("failed").className).toContain("task-review-tab__status--failed");
  });

  it("renders review items and queues revision for selected entries", async () => {
    const task = makeTask({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [
          {
            id: "ri-1",
            body: "Fix null handling",
            author: { login: "reviewer" },
            createdAt: new Date().toISOString(),
          },
        ],
        addressing: [{ itemId: "ri-1", status: "queued", selectedAt: new Date().toISOString() }],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.reviseTaskReviewItems.mockResolvedValue({ task, reviewState: task.reviewState });
    apiMocks.refreshTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, ["ri-1"], undefined);
  });

  it("renders reviewer-agent entries in direct mode", async () => {
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-code-1",
            body: "## Code Review:\n\n### Verdict:\nREVISE",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            reviewType: "code",
            verdict: "REVISE",
            step: 2,
            summary: "code review Step 2: REVISE",
            addressingStatus: "in-progress",
          },
        ],
        addressing: [],
      },
      automationStatus: null,
      emptyMessage: null,
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByText("reviewer-agent")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.getAllByText("REVISE").length).toBeGreaterThan(0);
  });
});
