import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTask, noop, noopDelete, noopMerge, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg />" }) },
}));

describe("TaskDetailModal Alpha mobile drawer", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width") || query.includes("max-height"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  /*
  FNXC:ApprovalDestroyingRetry 2026-11-14-02:10 (RUFU-599 Step 7, reproduction 4 / RUFU-472 / RUFU-474):
  Le refus est serveur, mais l'opérateur le voit ici. Sur mobile only le tiroir est la seule surface du card, donc
  l'échappatoire refusée doit disparaître ICI aussi : le bouton Retry retiré (et non grisé), sans coquille vide ni
  aria-label pendant, et la phrase du serveur affichée à la place. `onRetryTask` est passé exprès : sans le refus,
  ce même fixture rendrait les deux boutons, ce qui prouve que c'est le champ qui les retire et non l'absence d'un
  handler. Le bandeau d'échec ne se rend que sous l'onglet definition, d'où `initialTab`.
  */
  it("affiche le refus du Retry serveur et aucune commande Retry dans le tiroir mobile", () => {
    const refusal = {
      destroyedApproval: { workflowStepId: "code-review", workflowStepName: "Code Review" },
      waiver: {
        kind: "verdictless-skipped",
        workflowStepId: "post-merge-verification",
        workflowStepName: "Post-merge Verification",
        phase: "post-merge",
      },
      sentence: "Retry is refused here: `Code Review` already approved this work; the remaining blocker waits on an operator waiver on `post-merge-verification`.",
    };

    render(
      <TaskDetailModal
        task={makeTask({
          id: "FN-474",
          column: "in-review",
          status: "failed",
          error: "required post-merge gate has not reported",
          retryRefusal: refusal,
        })}
        mobileDrawer
        initialTab="definition"
        onClose={noop}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onRetryTask={vi.fn()}
        addToast={noop}
      />,
    );

    const alert = document.querySelector(".detail-error-alert");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("operator waiver on `post-merge-verification`");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/Retry with a different model/)).toBeNull();
  });

  it("réutilise le contenu Task Detail dans le shell partagé sans FloatingWindow", () => {
    const close = vi.fn();
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-DRAWER" })}
        mobileDrawer
        onClose={close}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    expect(dialog).toHaveClass("mobile-drawer__panel", "mobile-drawer__panel--content-header", "mobile-drawer__panel--content-scroll");
    expect(dialog.querySelector(".task-detail-modal--native-drawer .task-detail-content")).toBeInTheDocument();
    expect(dialog.querySelector(".task-detail-modal--mobile-transition")).toBeNull();
    expect(dialog.closest(".mobile-drawer--open")).toBeInTheDocument();
    expect(dialog.querySelectorAll(":scope > .mobile-drawer__header")).toHaveLength(0);
    expect(dialog.querySelectorAll(".task-detail-content > .modal-header")).toHaveLength(1);
    expect(dialog.querySelectorAll(":scope > .mobile-drawer__close")).toHaveLength(0);
    /*
    FNXC:StandardizedDrawers 2026-09-15-16:33:
    FN-427: this drawer used to render a ChevronLeft wired to dismissal. Task Detail has no list→detail navigation, and
    the handle, backdrop and Escape below already dismiss the drawer, so that control was duplicated chrome and is gone.
    */
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(dialog.querySelector(".view-back-button")).toBeNull();
    expect(dialog.querySelector(".task-detail-header-back-btn")).toBeNull();
    expect(dialog.querySelectorAll(":scope > .mobile-drawer__handle-target.view-drawer__handle-target")).toHaveLength(1);
    expect(document.querySelector(".floating-window--task-detail")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ferme exactement une fois le Task Detail Alpha par drag de poignée", () => {
    const close = vi.fn();
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-DRAWER-DRAG" })}
        mobileDrawer
        onClose={close}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    const handle = dialog.querySelector(".mobile-drawer__handle-target")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0, button: 0, isPrimary: true });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 200 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("conserve le FloatingWindow existant hors du contrat Alpha", () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-STANDARD" })}
        onClose={noop}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    expect(document.querySelector(".floating-window--task-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-drawer-task-detail")).toBeNull();
  });
});
