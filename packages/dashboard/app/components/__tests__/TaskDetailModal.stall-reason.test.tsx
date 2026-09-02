/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
The detail view is the one surface that must answer "why isn't this card moving?" for a PAUSED card
independent of its column — every pre-existing banner there (failure alert, ExternalBlockNotice, the
review-lane stall banners) is keyed to a specific column or state, so a paused todo-column card showed
nothing. These tests pin the new generic stall banner: it names the reason for the codes the shared
face-visibility predicate assigns to the detail, and it stays silent wherever a dedicated affordance
already owns the code (failed -> failure alert, external-block -> notice, a flowing card -> nothing).
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Match the rendering suite: keep the shared markdown pipeline's MermaidDiagram resolvable.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mock-mermaid-svg'></svg>" }),
  },
}));

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import type { Task } from "@fusion/core";

setupTaskDetailModalHooks();

function renderDetail(task: Task) {
  return render(
    <TaskDetailContent
      embedded
      active
      task={task}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal generic stall banner", () => {
  it("names a paused card's reason with no column dependency (symptom b/d)", () => {
    renderDetail(
      makeTask({ id: "FN-PAUSE", column: "todo", status: "paused", paused: true, pausedReason: "heartbeat-unresponsive" }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-PAUSE");
    expect(banner).toHaveTextContent("Heartbeat unresponsive");
    expect(banner.getAttribute("data-stall-code")).toBe("engine-paused");
  });

  it("explains a dependency block on the detail face (headline + action)", () => {
    renderDetail(
      makeTask({ id: "FN-DEP", column: "in-progress", status: "queued", blockedBy: "FN-BLOCK" }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-DEP");
    expect(banner).toHaveTextContent("Waiting on dependency FN-BLOCK");
    expect(banner.getAttribute("data-stall-code")).toBe("dependency-block");
  });

  it("stays silent for a plain resting card (undefined stall)", () => {
    renderDetail(makeTask({ id: "FN-FLOW", column: "todo", status: "pending" }));
    expect(screen.queryByTestId("task-detail-stall-reason-FN-FLOW")).toBeNull();
  });

  it("defers to the failure alert for a failed card instead of stacking a generic banner", () => {
    renderDetail(
      makeTask({ id: "FN-FAIL", column: "in-progress", status: "failed", error: "compile failed" }),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-stall-reason-FN-FAIL")).toBeNull();
  });

  it("defers to the ExternalBlockNotice for an externally blocked card", () => {
    const task = makeTask({
      id: "FN-BLK",
      column: "in-progress",
      status: "blocked",
      paused: true,
      pausedReason: "external-block",
      externalBlock: {
        origin: "credentials",
        code: "AUTH_REQUIRED",
        message: "credentials expired",
        source: "session-failure",
        blockedAt: "2026-08-28T00:00:00.000Z",
        resume: { column: "in-progress", currentStep: 0 },
      },
    }) as Task;
    renderDetail(task);
    // The shared notice owns this code; the generic banner must not coexist with it.
    expect(screen.getByTestId("external-block-detail-FN-BLK")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-stall-reason-FN-BLK")).toBeNull();
  });

  /*
  FNXC:StallReason 2026-09-02-18:21 (RUFU-175 review):
  Same complete-lane suppression the card and list rows already apply: landing proof ignores `paused`,
  so a done card can be opened still carrying a stale park, an unresolved dependency edge, or an active
  wedge. The detail view must not advertise a stall with a "resume" suggestion on a completed card, so
  the generic banner follows `isDoneColumn`. Each case keeps a matching non-complete control below to
  prove the gate is what suppresses the banner, not that the field never produces one.
  */
  it.each([
    ["a stale pause", { status: "paused", paused: true, pausedReason: "budget-exhausted" }],
    ["an unresolved dependency edge", { status: "queued", blockedBy: "FN-BLOCK" }],
    ["an active wedge", { status: "in-progress", wedgeNotification: { reasonKey: "pending-wedge", episodeId: "e1", status: "active", transitionedAt: "2026-09-01T00:00:00.000Z" } }],
  ] as const)("suppresses the generic banner on a landed card carrying %s", (_label, staleField) => {
    renderDetail(makeTask({ id: "FN-LANDED", column: "done", ...staleField }));
    expect(screen.queryByTestId("task-detail-stall-reason-FN-LANDED")).toBeNull();
  });

  it.each([
    ["a paused card", { status: "paused", paused: true, pausedReason: "budget-exhausted" }, "Output budget exhausted"],
    ["a dependency wait", { status: "queued", blockedBy: "FN-BLOCK" }, "Waiting on dependency FN-BLOCK"],
    ["a wedge hold", { status: "in-progress", wedgeNotification: { reasonKey: "pending-wedge", episodeId: "e1", status: "active", transitionedAt: "2026-09-01T00:00:00.000Z" } }, null],
  ] as const)("still names the reason for %s in a non-complete lane", (_label, staleField, text) => {
    renderDetail(makeTask({ id: "FN-LIVE", column: "todo", ...staleField }));
    const banner = screen.getByTestId("task-detail-stall-reason-FN-LIVE");
    if (text) expect(banner).toHaveTextContent(text);
  });
});
