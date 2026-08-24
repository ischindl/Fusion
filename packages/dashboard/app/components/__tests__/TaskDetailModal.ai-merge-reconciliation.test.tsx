/*
FNXC:AIMergeReviewReconciliation 2026-08-23-22:25:
RUFU-152 migrates the AI merge review reconciliation copy to the taskDetail.aiMergeReviewReconciliation
i18n keys (title / approvedPending / candidate / dismissFinding / terminalHint) so the hardcoded-copy
lint gate passes. This regression pins the migrated copy through the app namespace — the test i18n
instance resolves the inline English defaults — and keeps the dismiss affordance's visibility rule
(terminal or still-present findings only) covered on the shared Definition surface.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AiMergeReviewReconciliation } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

/*
FNXC:AIMergeReviewReconciliation 2026-08-23-22:45:
The component imports dismissAiMergeReviewFinding directly from the tasks-lifecycle submodule (bypassing
the app/api barrel the shared harness mocks), so this file mocks that submodule seam with an
importOriginal spread to observe the endpoint call without touching the shared harness.
*/
vi.mock("../../api/tasks/tasks-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tasks/tasks-lifecycle")>();
  return {
    ...actual,
    dismissAiMergeReviewFinding: vi.fn().mockResolvedValue({}),
  };
});

afterEach(async () => {
  const { fetchTaskDetail } = await import("../../api");
  vi.mocked(fetchTaskDetail).mockReset();
  vi.restoreAllMocks();
});

const baseReconciliation: AiMergeReviewReconciliation = {
  sourceSha: "source-sha-1",
  integrationTipSha: "tip-sha-1",
  candidateSha: "candidate-sha-1",
  findings: [
    { id: "finding-1", text: "First reviewer finding", disposition: "pending" },
    { id: "finding-2", text: "Second reviewer finding", disposition: "still-present" },
  ],
  consecutiveCleanApprovals: 0,
  correctivePasses: 1,
};

async function renderReconciliation(overrides: Partial<AiMergeReviewReconciliation> = {}) {
  // Slim props hydrate the Definition surface via fetchTaskDetail; keep the fetched snapshot
  // consistent with the fixture so the reconciliation section renders on either code path.
  const { fetchTaskDetail } = await import("../../api");
  const task = makeTask({ aiMergeReviewReconciliation: { ...baseReconciliation, ...overrides } });
  vi.mocked(fetchTaskDetail).mockResolvedValue(task);
  return render(
    <TaskDetailContent
      initialTab="definition"
      active
      task={task}
      onRequestClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={vi.fn()}
      onTaskUpdated={vi.fn()}
    />,
  );
}

const SECTION_NAME = "AI merge review reconciliation";
const TERMINAL_HINT = "Rebase or re-push the branch, dismiss a finding with justification, or land manually.";

describe("TaskDetailModal AI merge review reconciliation copy", () => {
  it("renders the reconciliation heading, candidate line, and dismiss affordance only for eligible findings", async () => {
    await renderReconciliation();

    const section = await screen.findByRole("region", { name: SECTION_NAME });
    expect(within(section).getByRole("heading", { level: 3, name: SECTION_NAME })).toBeInTheDocument();
    expect(section).toHaveTextContent("Candidate: candidate-sha-1");
    expect(section.querySelector("code")).toHaveTextContent("candidate-sha-1");
    expect(within(section).getByText("First reviewer finding")).toBeInTheDocument();
    // terminal=false: the pending finding has no dismiss button; the still-present one does
    expect(within(section).getAllByRole("button", { name: "Dismiss this finding" })).toHaveLength(1);
    expect(section).not.toHaveTextContent(TERMINAL_HINT);
  });

  it("reports the approved-pending count through interpolation and shows the terminal hint", async () => {
    await renderReconciliation({ terminal: true, consecutiveCleanApprovals: 2 });

    const section = await screen.findByRole("region", { name: SECTION_NAME });
    expect(
      within(section).getByRole("heading", { level: 3, name: "Approved — 2 prior finding(s) unconfirmed" }),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent(TERMINAL_HINT);
    // terminal: both eligible findings expose the dismiss affordance
    expect(within(section).getAllByRole("button", { name: "Dismiss this finding" })).toHaveLength(2);
  });

  it("collects an audited reason before dismissing through the reconciliation endpoint", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("audited reason");
    await renderReconciliation({ terminal: true });

    const section = await screen.findByRole("region", { name: SECTION_NAME });
    const [dismiss] = within(section).getAllByRole("button", { name: "Dismiss this finding" });
    fireEvent.click(dismiss);

    expect(promptSpy).toHaveBeenCalledOnce();
    const { dismissAiMergeReviewFinding } = await import("../../api/tasks/tasks-lifecycle");
    await waitFor(() => expect(vi.mocked(dismissAiMergeReviewFinding)).toHaveBeenCalledTimes(1));
    const [taskIdArg, findingArg, reasonArg] = vi.mocked(dismissAiMergeReviewFinding).mock.calls[0];
    expect(taskIdArg).toBe("FN-099");
    expect(findingArg).toBe("finding-1");
    expect(reasonArg).toBe("audited reason");
  });
});
