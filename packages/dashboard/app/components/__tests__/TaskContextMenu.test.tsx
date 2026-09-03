import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskContextMenu, buildTaskActionMenuModel } from "../TaskContextMenu";

const t = ((key: string, fallback: string, vars?: Record<string, string>) => {
  if (!vars) return fallback;
  return fallback.replace(/{{(\w+)}}/g, (_, name: string) => vars[name] ?? "");
}) as any;
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7255",
    title: "Context menu task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

function actionIds(task: Task, overrides: Partial<Parameters<typeof buildTaskActionMenuModel>[0]> = {}): string[] {
  return buildTaskActionMenuModel({ task, t, ...overrides }).actions.map((action) => action.id);
}

describe("TaskContextMenu shared task action model", () => {
  it("mirrors Retry, Reset, and Delete availability across lifecycle states", () => {
    const onRetry = vi.fn();
    expect(actionIds(makeTask({ column: "triage" }), { onRetry })).toEqual(["retry", "pause", "delete"]);
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, onRetry }).shouldShowActionsMenu).toBe(true);
    expect(actionIds(makeTask({ column: "in-review" }), { onRetry, onReset: vi.fn(), onOpenRefine: vi.fn() })).toEqual(["refine", "retry", "pause", "reset", "delete"]);
    expect(actionIds(makeTask({ column: "done" }), { onRetry, onReset: vi.fn(), onOpenRefine: vi.fn() })).toEqual(["refine", "delete"]);
    expect(actionIds(makeTask({ column: "archived" }), { onRetry, onReset: vi.fn() })).toEqual(["delete"]);
  });

  it("offers exactly the supported recovery actions", () => {
    const supported = buildTaskActionMenuModel({
      task: makeTask({ column: "in-progress" }),
      t,
      onRetry: vi.fn(),
      onReset: vi.fn(),
    });
    expect(supported.actions.map((action) => action.id)).toEqual(["retry", "pause", "reset", "delete"]);
  });

  it("offers Retry for every mutable live column, including pending recovery", () => {
    const onRetry = vi.fn();
    const onReset = vi.fn();
    for (const task of [makeTask(), makeTask({ status: null as any, nextRecoveryAt: new Date(Date.now() + 60_000).toISOString() })]) {
      expect(actionIds(task, { onRetry, onReset })).toEqual(["retry", "pause", "reset", "delete"]);
    }
    expect(actionIds(makeTask({ column: "done" }), { onRetry, onReset })).toEqual(["delete"]);
    expect(actionIds(makeTask({ column: "archived" }), { onRetry, onReset, currentColumnFlags: { archived: true } })).toEqual(["delete"]);
  });

  it("exposes Plan only for pre-execution hold columns with a host callback", () => {
    const onPlan = vi.fn();
    const eligibleCases: Array<[string, Partial<Parameters<typeof buildTaskActionMenuModel>[0]>]> = [
      ["triage", {}],
      ["custom intake", { currentColumnFlags: { intake: true } }],
      ["custom hold", { currentColumnFlags: { hold: true } }],
    ];

    for (const [label, overrides] of eligibleCases) {
      const column = label === "triage" ? "triage" : label;
      const model = buildTaskActionMenuModel({
        task: makeTask({ column: column as any }),
        t,

        onPlan,
        ...overrides,
      });
      expect(model.actions.map((action) => action.id), label).toContain("plan");
      expect(model.actions.find((action) => action.id === "plan")?.label).toBe("Plan");
    }

    for (const column of ["todo", "in-progress", "in-review", "done"] as const) {
      expect(actionIds(makeTask({ column }), { onPlan })).not.toContain("plan");
    }
    expect(actionIds(makeTask({ column: "complete" as any }), { onPlan, currentColumnFlags: { hold: true, complete: true } })).not.toContain("plan");
    expect(actionIds(makeTask({ column: "cold-storage" as any }), { onPlan, currentColumnFlags: { hold: true, archived: true } })).not.toContain("plan");
    expect(actionIds(makeTask({ column: "triage" }))).not.toContain("plan");

    buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, onPlan }).actions.find((action) => action.id === "plan")?.onSelect?.();
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it("exposes GitHub tracking enablement only for untracked tasks with a host callback", () => {
    const onEnableGithubTracking = vi.fn();
    const untracked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: undefined }),
      t,

      onEnableGithubTracking,
    });
    const disabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: false } as any }),
      t,

      onEnableGithubTracking,
    });
    const enabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true } as any }),
      t,

      onEnableGithubTracking,
    });
    const linked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } as any }),
      t,

      onEnableGithubTracking,
    });
    const noCallback = buildTaskActionMenuModel({ task: makeTask(), t });

    expect(untracked.actions.find((action) => action.id === "enable-github-tracking")?.label).toBe("Enable GitHub tracking");
    expect(untracked.actions.map((action) => action.id)).toEqual(["enable-github-tracking", "pause", "delete"]);
    expect(disabled.actions.map((action) => action.id)).toContain("enable-github-tracking");
    expect(enabled.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(linked.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(noCallback.actions.map((action) => action.id)).not.toContain("enable-github-tracking");

    untracked.actions.find((action) => action.id === "enable-github-tracking")?.onSelect?.();
    expect(onEnableGithubTracking).toHaveBeenCalledTimes(1);
  });

  it("exposes pause, unpause, and paused-by-agent note with detail labels", () => {
    const active = buildTaskActionMenuModel({ task: makeTask(), t });
    expect(active.actions.map((action) => action.id)).toEqual(["pause", "delete"]);
    expect(active.actions.find((action) => action.id === "pause")?.label).toBe("Pause");

    const paused = buildTaskActionMenuModel({
      task: makeTask({ paused: true, pausedByAgentId: "agent-1" } as Partial<Task>),
      t,

    });
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "unpause",
      "Unpause",
      undefined,
    ]);
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "paused-by-agent",
      "Paused by agent",
      "note",
    ]);
  });

  it("does not expose move transitions in lifecycle action models", () => {
    for (const column of ["in-progress", "in-review"] as const) {
      const model = buildTaskActionMenuModel({ task: makeTask({ column }), t });
      expect(model).not.toHaveProperty("moveTransitions");
      expect(model.actions.map((action) => action.id)).not.toContainEqual(expect.stringMatching(/^move-/));
    }
  });

  it("mirrors in-review merge and manual PR status actions", () => {
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "in-review" }), t }).reviewAction).toMatchObject({
      id: "merge",
      label: "Merge & Close",
    });

    const onMerge = vi.fn();
    const onStartPrReview = vi.fn();
    const startPrReviewAction = buildTaskActionMenuModel({
      task: makeTask({ column: "in-review" }),
      t,

      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      onMerge,
      onStartPrReview,
    }).reviewAction;
    expect(startPrReviewAction).toMatchObject({ id: "start-pr-review", label: "Start PR Review" });
    startPrReviewAction?.onSelect?.();
    expect(onStartPrReview).toHaveBeenCalledTimes(1);
    expect(onMerge).not.toHaveBeenCalled();

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", prInfo: { status: "open" } as any }),
      t,

      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      isCheckingPrStatus: true,
    }).reviewAction).toMatchObject({ id: "check-pr-status", label: "Check PR Status", disabled: true });

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", status: "merging-pr" as any }),
      t,

      prAutomationLabel: "Merging PR…",
    }).reviewAction).toMatchObject({ id: "pr-automation", label: "Merging PR…", disabled: true });
  });

  it("keeps archived delete available without live-only destructive shells", () => {
    const onDelete = vi.fn();
    const archivedModel = buildTaskActionMenuModel({
      task: makeTask({ column: "archived" }),
      t,

      hasResetHandler: true,
      onReset: vi.fn(),
      onTogglePause: vi.fn(),
      onDelete,
    });

    expect(archivedModel.actions.map((action) => action.id)).toEqual(["delete"]);
    expect(archivedModel.actions.map((action) => action.id)).not.toContain("pause");
    expect(archivedModel.actions.map((action) => action.id)).not.toContain("reset");
    archivedModel.actions.find((action) => action.id === "delete")?.onSelect?.();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders descriptors and delegates selection to injected host handlers", () => {
    const onDelete = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[{ id: "delete", label: "Delete", tone: "danger", onSelect: onDelete }]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("selects enabled touch menu items on pointer release exactly once", () => {
    const onPause = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[
          { id: "pause", label: "Pause", onSelect: onPause },
          { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { id: "note", label: "Paused by agent", tone: "note", disabled: true, onSelect: vi.fn() },
        ]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Pause" }), { pointerType: "touch", pointerId: 1 });

    expect(onActionSelect).toHaveBeenCalledTimes(1);
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "Disabled" })).toBeDisabled();
    expect(screen.getByText("Paused by agent")).toHaveAttribute("role", "note");
  });

  it("focuses the first enabled action and supports arrow-key roving", () => {
    render(
      <TaskContextMenu
        actions={[
          { id: "disabled", label: "Disabled", disabled: true },
          { id: "pause", label: "Pause" },
          { id: "delete", label: "Delete", tone: "danger" },
        ]}
      />,
    );

    const pause = screen.getByRole("menuitem", { name: "Pause" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(pause).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(del).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(pause).toHaveFocus();
  });

  it("renders generic submenus without coupling them to task movement", () => {
    const onSelect = vi.fn();
    render(<TaskContextMenu actions={[{ id: "more", label: "More", items: [{ id: "nested", label: "Nested", onSelect }] }]} />);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "More" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Nested" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-10:20 (PR #2626 review — greptile P2):
The intake-only vs intake+hold distinction, covered per workflow SHAPE rather than per column id.

`shouldShowActionsMenu` follows the generated action list, so a pure intake lane remains an
operator-recoverable planning stage rather than a hidden menu special case. Cover both trait and
legacy fallbacks so first paint never withdraws the shared actions.
*/
describe("shouldShowActionsMenu by workflow shape (not by column id)", () => {
  const model = (column: string, flags: Record<string, boolean>) =>
    buildTaskActionMenuModel({
      task: makeTask({ column: column as never }),
      t,
      currentColumnFlags: flags as never,
    }).shouldShowActionsMenu;

  it("SHOWS the menu on a Coding (Ideas) capture — intake with no hold, non-legacy id", () => {
    expect(model("ideas", { intake: true })).toBe(true);
  });

  it("SHOWS the menu on a merged Planning column — intake AND hold", () => {
    // Post-U11 the default Planning column carries both traits. Cards rest here waiting for
    // capacity and do have real actions, so suppressing would remove affordances that existed
    // when this was the separate `todo` lane.
    expect(model("todo", { intake: true, hold: true })).toBe(true);
  });

  it("SHOWS the menu on a hold-only lane, as the pre-merge `todo` column did", () => {
    expect(model("todo", { hold: true })).toBe(true);
  });

  it("SHOWS on a RENAMED pure-intake lane, proving no id is consulted", () => {
    expect(model("backlog", { intake: true })).toBe(true);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:00 (U12 — the last `triage` column guard):
THE INVERSION. `isPreExecutionHoldColumn` ORed the legacy id with the traits unconditionally, so a
resolved column merely NAMED `triage` answered true even when its own traits said work was underway
— offering Plan, which re-plans, on a card that is already executing.

The existing cases here all pass a column with no flags or with hold/intake set, so every one of them
agrees under both the old and new form. That is why this defect survived the file's earlier
conversion: nothing exercised a resolved column whose name and traits disagree.

REVERT CHECK: restore the `column === "triage" ||` prefix and the first case fails — Plan reappears
on a mid-flight card.
*/
describe("pre-execution hold resolves traits, not the column's name", () => {
  it("does NOT treat a mid-flight column NAMED `triage` as a planning target", () => {
    const model = buildTaskActionMenuModel({
      task: makeTask({ column: "triage" }),
      t,

      currentColumnFlags: { intake: false, hold: false, countsTowardWip: true } as any,
      onPlan: vi.fn(),
    } as never);
    expect(model.actions.map((a: { id: string }) => a.id)).not.toContain("plan");
  });

  it("still offers Plan on a RENAMED hold column", () => {
    // The narrowing guard: traits decide, so a board that never uses the legacy name still works.
    const model = buildTaskActionMenuModel({
      task: makeTask({ column: "backlog" as never }),
      t,

      currentColumnFlags: { intake: true, hold: true } as any,
      onPlan: vi.fn(),
    } as never);
    expect(model.actions.map((a: { id: string }) => a.id)).toContain("plan");
  });

  it("keeps the flagless degraded answer for `triage` and withholds it for flagless `todo`", () => {
    /*
    The asymmetry the file documents: with no flags, `triage` is the only pre-execution hold. A
    flagless `todo` must NOT offer Plan, because re-planning an already-planned card is not
    recoverable by the operator.
    */
    const forColumn = (column: string) =>
      buildTaskActionMenuModel({ task: makeTask({ column: column as never }), t, onPlan: vi.fn() } as never)
        .actions.map((a: { id: string }) => a.id);
    expect(forColumn("triage")).toContain("plan");
    expect(forColumn("todo")).not.toContain("plan");
  });
});

/*
FNXC:ReviewLaneBypass 2026-09-03-13:15 (RUFU-179):
The bypass item renders from the server-derived `task.reviewBypass` capability — hydrated by the
same `deriveReviewBypassTarget` the store's `bypassFailedPreMergeReviewStep` applies to itself —
not from the deleted local failed-result predicate. This pins: both kinds label by kind; the
capability's ABSENCE hides the item even when a failed result still sits in the payload (the store's
paused/lane refusals now propagate to the menu); and the client lane-belt drops a stale capability
on a card that left the review lane.

The tone is asserted as actionable because `tone: "note"` is the NON-interactive style: it renders a
`<span role="note">` and `selectAction` short-circuits, which is how FN-7720's affordance shipped
dead. A model-level tone assertion plus the render-level click below are what keep it reachable.
*/
describe("bypass-review renders from the server capability, not a local predicate", () => {
  const failedTarget = { kind: "failed", workflowStepId: "code-review", workflowStepName: "Code Review" };
  const unrunTarget = { kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" };

  const bypassItem = (task: Task) =>
    buildTaskActionMenuModel({ task, t, onBypassReview: vi.fn() }).actions.find((a) => a.id === "bypass-review");

  it("labels the verdict rewrite with the failed copy and stays actionable", () => {
    expect(bypassItem(makeTask({ column: "in-review", reviewBypass: failedTarget }))).toMatchObject({
      label: "Bypass failed review",
      tone: "default",
    });
  });

  it("labels the unrun-gate approval with the unrun copy and stays actionable", () => {
    expect(bypassItem(makeTask({ column: "in-review", reviewBypass: unrunTarget }))).toMatchObject({
      label: "Bypass unrun review gate",
      tone: "default",
    });
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-12:58 (RUFU-179):
  Render-level activation for every host of this shared component (board card menu, list view, detail
  Actions menu, right dock). A descriptor that carries onSelect but renders as a note span is the
  dead-affordance shape this task exists to eliminate, so the click — not just the model — is pinned.
  */
  it("activates the rendered item so every host can fire the bypass", () => {
    const onBypassReview = vi.fn();
    const { actions } = buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", reviewBypass: unrunTarget }),
      t,
      onBypassReview,
    });
    render(<TaskContextMenu actions={actions} />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass unrun review gate" }));

    expect(onBypassReview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("note", { name: /Bypass/ })).not.toBeInTheDocument();
  });

  it("hides the item when the server withheld the capability, even with a failed result in the payload", () => {
    /*
    The flipped shape: the old `some(failed)` predicate would have rendered here even for a paused
    card the store refuses. The server answer is the only authority, so a payload with results but
    no capability means "the store would say no".
    */
    const task = makeTask({
      column: "in-review",
      workflowStepResults: [
        { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", phase: "pre-merge" },
      ] as Task["workflowStepResults"],
    });
    expect(bypassItem(task)).toBeUndefined();
  });

  it("drops a stale capability on a card that left the review lane (render-time lane belt)", () => {
    expect(bypassItem(makeTask({ column: "in-progress", reviewBypass: failedTarget }))).toBeUndefined();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-15:11 (RUFU-179 code-review remediation):
  The belt must admit EVERY lane the store's `resolveReviewBypassLanes` admits —
  `mergeOrchestration ∪ mergeBlocker ∪ humanReview` (#2718). `isReviewColumnRole` answers only the
  latter two, so on a board whose review orchestration lives on a mergeOrchestration-only lane the
  store accepted the bypass while the menu stayed silent: the "API accepts, menu silent" half of the
  dead-affordance class RUFU-179 deletes. The WIP-lane sibling is the non-vacuous control — it proves
  the widened belt still suppresses a stale capability on a card that really left review, not that the
  gate stopped suppressing anything.
  */
  it("offers the capability on a mergeOrchestration-only review lane the store admits", () => {
    const item = buildTaskActionMenuModel({
      task: makeTask({ column: "merging", reviewBypass: unrunTarget }),
      t,
      currentColumnFlags: { mergeOrchestration: true },
      onBypassReview: vi.fn(),
    }).actions.find((a) => a.id === "bypass-review");
    expect(item).toMatchObject({ label: "Bypass unrun review gate", tone: "default" });
  });

  it("still drops a stale capability on a flagged WIP lane (belt is widened, not disabled)", () => {
    expect(
      buildTaskActionMenuModel({
        task: makeTask({ column: "building", reviewBypass: failedTarget }),
        t,
        currentColumnFlags: { countsTowardWip: true },
        onBypassReview: vi.fn(),
      }).actions.find((a) => a.id === "bypass-review"),
    ).toBeUndefined();
  });

  it("renders nothing when the host did not wire a bypass handler", () => {
    const { actions } = buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", reviewBypass: failedTarget }),
      t,
    });
    expect(actions.map((a) => a.id)).not.toContain("bypass-review");
  });
});
