import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Column, MergeResult, PrInfo, Task, TaskDetail } from "@fusion/core";
import { clearAuthToken } from "../../auth";
import { PrCreateModal } from "../PrCreateModal";
import { TaskDetailModal } from "../TaskDetailModal";
import { FloatingWindow } from "../FloatingWindow";
import { useDashboardKeyboardShortcuts } from "../../hooks/useDashboardKeyboardShortcuts";

/*
FNXC:ModalEscapeOwnership 2026-09-10-15:20:
RUFU-205 pins the one-claim-one-layer Escape invariant for Create PR. Create PR answered Escape from
a bubble-phase `document` listener with no ownership guard, so it reacted to every Escape keystroke in
the dashboard: one aimed at its own host (Task Detail is itself a modal FloatingWindow), one aimed at
an overlay stacked over it, and one the app-wide popup arbiter already owned. Every case below
dispatches a real KeyboardEvent at the node the user was actually aiming at and asserts exactly one
layer reacts. Nothing is mocked away: the host and the sibling overlays are real components, and the
only test-authored listeners are recorders that observe propagation without deciding anything.
*/

const CREATE_PR_OVERLAY = "floating-window-overlay-pr-create";
const HOST_OVERLAY = "floating-window-overlay-task-detail";

const apiMocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  fetchPrPreflight: vi.fn(),
  fetchPrOptions: vi.fn(),
  createPr: vi.fn(),
  pushPrBranch: vi.fn(),
  resolvePrConflicts: vi.fn(),
  fetchTaskDetail: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    generatePrMetadata: apiMocks.generatePrMetadata,
    fetchPrPreflight: apiMocks.fetchPrPreflight,
    fetchPrOptions: apiMocks.fetchPrOptions,
    createPr: apiMocks.createPr,
    pushPrBranch: apiMocks.pushPrBranch,
    resolvePrConflicts: apiMocks.resolvePrConflicts,
    fetchTaskDetail: apiMocks.fetchTaskDetail,
    fetchTaskReview: vi.fn(async () => ({ reviewState: undefined, automationStatus: null })),
    fetchWorkflowResults: vi.fn(async () => []),
    fetchWorkflowSteps: vi.fn(async () => []),
    fetchAgents: vi.fn(async () => []),
    fetchAgent: vi.fn(async () => null),
    fetchModels: vi.fn(async () => ({ models: [], favoriteProviders: [] })),
    fetchSettings: vi.fn(async () => ({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {}, autoMerge: false })),
    fetchGlobalSettings: vi.fn(async () => ({})),
    fetchAgentLogs: vi.fn(async () => []),
    updateTask: vi.fn(async () => ({})),
    updateGlobalSettings: vi.fn(async () => ({})),
  });
});

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: () => ({
    entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false,
  }),
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: () => ({ slots: [], getSlotsForId: vi.fn(() => []), loading: false, error: null }),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true), confirmWithChoice: vi.fn(async () => "primary") }),
}));

const prMetadata = { title: "AI title", body: "## Summary\n", templateUsed: true };
const prPreflight = {
  branchOnRemote: true,
  commitsPresent: true,
  conflictsWithBase: false,
  ghAuthOk: true,
  defaultBaseBranch: "main",
  head: "fusion/RUFU-205",
  commits: [{ sha: "abcdef1", subject: "fix", author: "dev" }],
  changedFiles: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" as const }],
};
const prOptions = { baseBranches: ["main"], reviewers: [], assignees: [], labels: [] };

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "RUFU-205",
    title: "Escape ownership host",
    description: "Host task",
    column: "in-review" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    prInfo: undefined,
    prInfos: [],
    ...overrides,
  } as TaskDetail;
}

/**
 * Aims a real Escape keystroke at `target` the way a browser would (bubbling, cancelable) and flushes
 * any React state it causes. Returns whether some layer claimed the keystroke (called preventDefault).
 */
function pressEscape(target: Element): boolean {
  // RTL's fireEvent returns false when a handler called preventDefault.
  return !fireEvent.keyDown(target, { key: "Escape" });
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/**
 * Records every keydown that actually reaches `document` after the layers under test had their turn.
 * Registered last, so a layer that stops propagation correctly hides the keystroke from it — that is
 * what makes the "exactly one layer reacted" assertions non-vacuous.
 */
function mountEscapeRecorder() {
  const seen: string[] = [];
  const listener = (event: KeyboardEvent) => { seen.push(event.key); };
  document.addEventListener("keydown", listener);
  return { seen, release: () => document.removeEventListener("keydown", listener) };
}

async function renderCreatePr(overrides?: Partial<ComponentProps<typeof PrCreateModal>>) {
  const onClose = vi.fn();
  render(
    <PrCreateModal
      open
      taskId="RUFU-205"
      onClose={onClose}
      onCreated={vi.fn()}
      addToast={vi.fn()}
      {...overrides}
    />,
  );
  await screen.findByDisplayValue("AI title");
  return { onClose };
}

/**
 * A second overlay stacked over Create PR, rendered from the real overlay markers the ownership
 * guard reads (`.floating-window-overlay` + `.modal`) instead of a synthetic class.
 */
function mountForeignOverlay() {
  render(
    <div className="floating-window-overlay floating-window-overlay--modal" data-testid="foreign-overlay" role="dialog" aria-modal="true">
      <div className="floating-window modal" role="dialog" aria-label="Foreign Overlay">
        <label>
          Foreign field
          <input aria-label="foreign-field" />
        </label>
        {/* The popup arbiter deliberately defers text-entry targets, so arbiter-ownership cases aim here. */}
        <button type="button" data-testid="foreign-action">Foreign action</button>
      </div>
    </div>,
  );
}

function mountArbiter() {
  const closeTopmostPopup = vi.fn(() => true);
  const toggleNewTask = vi.fn();
  renderHook(() => useDashboardKeyboardShortcuts({
    toggleQuickChat: vi.fn(),
    toggleTerminal: vi.fn(),
    toggleFiles: vi.fn(),
    toggleSettings: vi.fn(),
    toggleCommandCenter: vi.fn(),
    toggleNewTask,
    closeTopmostPopup,
  }));
  return { closeTopmostPopup, toggleNewTask };
}

function focusCreatePrField(): HTMLElement {
  const title = screen.getByDisplayValue("AI title");
  title.focus();
  expect(document.activeElement).toBe(title);
  return title;
}

describe("PrCreateModal Escape ownership", () => {
  beforeEach(() => {
    apiMocks.generatePrMetadata.mockReset().mockResolvedValue(prMetadata);
    apiMocks.fetchPrPreflight.mockReset().mockResolvedValue(prPreflight);
    apiMocks.fetchPrOptions.mockReset().mockResolvedValue(prOptions);
    apiMocks.createPr.mockReset().mockResolvedValue({
      number: 205, title: "Created PR", url: "https://example.test/pr/205", status: "open",
      headBranch: "fusion/RUFU-205", baseBranch: "main", commentCount: 0,
    } satisfies PrInfo);
    apiMocks.fetchTaskDetail.mockReset().mockResolvedValue(makeTask());
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    setViewport(1440, 900);
  });

  afterEach(() => {
    cleanup();
    setViewport(1280, 800);
    document.body.style.removeProperty("overflow");
    document.body.style.removeProperty("overflow-x");
    document.body.style.removeProperty("overflow-y");
  });

  describe("scenario 1: nested inside the Task Detail host (a modal FloatingWindow)", () => {
    async function renderHostWithCreatePrOpen() {
      const hostOnClose = vi.fn();
      render(
        <TaskDetailModal
          task={makeTask({ id: "RUFU-205", column: "in-review" as Column })}
          projectId="project-rufu205"
          onClose={hostOnClose}
          onDeleteTask={async () => ({}) as Task}
          onMergeTask={vi.fn(async () => ({ merged: false }) as MergeResult)}
          onOpenDetail={vi.fn()}
          addToast={vi.fn()}
          prAuthAvailable
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      const opener = await screen.findByTestId("task-review-create-pr");
      // A real click would focus the opener; jsdom does not, so the focus is applied by hand. This also
      // gives the close path a host-side element to restore focus to.
      opener.focus();
      fireEvent.click(opener);
      await screen.findByTestId(CREATE_PR_OVERLAY);
      return { hostOnClose, opener };
    }

    it("closes only Create PR after its own focus blurred out to the body page", async () => {
      /*
      FNXC:ModalEscapeOwnership 2026-09-10-15:20 (REVISE #2 hole):
      Clicking non-focusable content inside Create PR — a section heading, a pre-flight row, the body
      preview — blurs focus to <body>, so the next Escape has target=body AND activeElement=body. A
      guard keyed only on "inside Create PR" deferred that keystroke to the app-wide arbiter, whose
      detailTask closer took the host — and the draft with it — down. The last-focused-overlay rule is
      what keeps this state closing exactly one layer.
      */
      const { hostOnClose } = await renderHostWithCreatePrOpen();
      focusCreatePrField();
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);

      pressEscape(document.body);

      expect(screen.queryByTestId(CREATE_PR_OVERLAY)).toBeNull();
      expect(screen.getByTestId(HOST_OVERLAY)).toBeInTheDocument();
      expect(hostOnClose).not.toHaveBeenCalled();
    });

    it("restores focus into the host instead of stranding it on the removed sheet", async () => {
      const { hostOnClose, opener } = await renderHostWithCreatePrOpen();

      pressEscape(screen.getByDisplayValue("AI title"));

      expect(screen.queryByTestId(CREATE_PR_OVERLAY)).toBeNull();
      expect(hostOnClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
      expect(opener).toBeInTheDocument();
    });

    it("closes only Create PR when Escape is aimed inside Create PR", async () => {
      const { hostOnClose } = await renderHostWithCreatePrOpen();

      pressEscape(screen.getByDisplayValue("AI title"));

      expect(screen.queryByTestId(CREATE_PR_OVERLAY)).toBeNull();
      expect(screen.getByTestId(HOST_OVERLAY)).toBeInTheDocument();
      expect(hostOnClose).not.toHaveBeenCalled();
    });

    it("closes only Create PR when Escape is aimed at the page but focus is inside Create PR", async () => {
      const { hostOnClose } = await renderHostWithCreatePrOpen();
      focusCreatePrField();

      pressEscape(document.body);

      expect(screen.queryByTestId(CREATE_PR_OVERLAY)).toBeNull();
      expect(screen.getByTestId(HOST_OVERLAY)).toBeInTheDocument();
      expect(hostOnClose).not.toHaveBeenCalled();
    });

    it("never claims a keystroke aimed at the host, so dismissal stays host-owned", async () => {
      const { hostOnClose } = await renderHostWithCreatePrOpen();
      const recorder = mountEscapeRecorder();

      // The deferred keystroke is also never consumed: the host's closer runs without preventDefault,
      // so the sheet's guard left the event byte-identical for every later listener.
      expect(pressEscape(screen.getByTestId("task-review-create-pr"))).toBe(false);

      expect(hostOnClose).toHaveBeenCalledTimes(1);
      // Create PR unmounts with its host; the recorder proves the keystroke was never stopped by it.
      expect(recorder.seen).toEqual(["Escape"]);
    });
  });

  describe("scenario 2: the app-wide popup arbiter keeps the keystrokes it owns", () => {
    it("lets Create PR win an Escape aimed inside it, instead of the arbiter closing another surface", async () => {
      const { closeTopmostPopup } = mountArbiter();
      const { onClose } = await renderCreatePr();

      pressEscape(screen.getByDisplayValue("AI title"));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(closeTopmostPopup).not.toHaveBeenCalled();
    });

    it("leaves Create PR open and forwards an Escape aimed at another overlay to the arbiter", async () => {
      const { closeTopmostPopup } = mountArbiter();
      const { onClose } = await renderCreatePr();
      mountForeignOverlay();

      expect(pressEscape(screen.getByTestId("foreign-action"))).toBe(true);

      expect(onClose).not.toHaveBeenCalled();
      expect(closeTopmostPopup).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("foreign-overlay")).toBeInTheDocument();
    });

    it("forwards a page-focus Escape whose last-focused overlay was someone else", async () => {
      const { closeTopmostPopup } = mountArbiter();
      const { onClose } = await renderCreatePr();
      mountForeignOverlay();
      const foreignField = screen.getByLabelText("foreign-field");
      foreignField.focus();
      foreignField.blur();
      expect(document.activeElement).toBe(document.body);

      pressEscape(document.body);

      expect(onClose).not.toHaveBeenCalled();
      expect(closeTopmostPopup).toHaveBeenCalledTimes(1);
    });
  });

  describe("scenario 3: focus escaped to body (blur-to-body orphan)", () => {
    it("closes Create PR instead of orphaning it when focus fell out to body", async () => {
      const { onClose } = await renderCreatePr();
      focusCreatePrField();
      // jsdom keeps activeElement on <body> after blur() and synthesizes no focusin for that
      // transition, which is the same DOM state a real browser leaves when focus exits a dialog.
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);

      pressEscape(document.body);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("hands a body Escape to the overlay that was focused last, not to Create PR", async () => {
      const { closeTopmostPopup } = mountArbiter();
      const { onClose } = await renderCreatePr();
      mountForeignOverlay();
      const foreignField = screen.getByLabelText("foreign-field");
      foreignField.focus();
      foreignField.blur();
      expect(document.activeElement).toBe(document.body);

      pressEscape(document.body);

      expect(onClose).not.toHaveBeenCalled();
      expect(closeTopmostPopup).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("foreign-overlay")).toBeInTheDocument();
    });

    it("still closes exactly one layer when the focused control is removed out from under focus", async () => {
      const recorder = mountEscapeRecorder();
      const { onClose } = await renderCreatePr();
      const title = focusCreatePrField();
      title.remove();
      expect(document.activeElement).toBe(document.body);

      pressEscape(document.body);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(recorder.seen).toEqual([]);
    });

    it("closes the sheet when the keystroke follows a click on Create PR's own static content", async () => {
      // The everyday interaction the REVISE #2 finding names: a click on the non-focusable
      // "Pre-flight checks" heading blurs focus to <body> in a real browser. jsdom synthesizes no
      // click-driven blur, so the resulting DOM state is applied directly and documented here.
      const { onClose } = await renderCreatePr();
      const heading = document.querySelector<HTMLElement>(".pr-create-modal__section-title");
      expect(heading).not.toBeNull();
      fireEvent.click(heading!);
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);

      expect(pressEscape(document.body)).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("scenario 4: phone and desktop share the invariant", () => {
    for (const [label, viewport] of [["desktop", [1440, 900]], ["mobile", [375, 812]]] as const) {
      it(`${label}: an Escape aimed inside Create PR closes it and reaches no other Escape owner`, async () => {
        setViewport(viewport[0], viewport[1]);
        const { closeTopmostPopup } = mountArbiter();
        const recorder = mountEscapeRecorder();
        const { onClose } = await renderCreatePr();
        mountForeignOverlay();

        pressEscape(screen.getByDisplayValue("AI title"));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(closeTopmostPopup).not.toHaveBeenCalled();
        expect(recorder.seen).toEqual([]);
      });

      it(`${label}: an Escape aimed at the other overlay leaves Create PR open`, async () => {
        setViewport(viewport[0], viewport[1]);
        const { onClose } = await renderCreatePr();
        mountForeignOverlay();

        expect(pressEscape(screen.getByTestId("foreign-action"))).toBe(false);

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByTestId(CREATE_PR_OVERLAY)).toBeInTheDocument();
      });
    }
  });

  describe("scenario 5: no listener leaks past close", () => {
    it("removes every keydown/focusin listener the open effect added, and answers nothing afterwards", async () => {
      const addEventListener = vi.spyOn(document, "addEventListener");
      const removeEventListener = vi.spyOn(document, "removeEventListener");
      const { onClose } = await renderCreatePr();
      const shape = (type: string, listener: EventListenerOrEventListenerObject, options: unknown) =>
        `${type}:${String(listener)}:${options === true ? "capture" : String(options)}`;
      const added = addEventListener.mock.calls
        .filter(([type]) => type === "keydown" || type === "focusin")
        .map(([type, listener, options]) => shape(type, listener, options));
      expect(added.length).toBeGreaterThan(0);
      addEventListener.mockClear();

      cleanup();

      const removed = removeEventListener.mock.calls
        .filter(([type]) => type === "keydown" || type === "focusin")
        .map(([type, listener, options]) => shape(type, listener, options));
      expect(new Set(added)).toEqual(new Set(removed));

      onClose.mockClear();
      pressEscape(document.body);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("controls: the claim must be narrow and the old affordances must survive", () => {
    it("claims the keystroke so Create PR's own overlay subtree never sees it", async () => {
      const { onClose } = await renderCreatePr();
      const ownOverlay = screen.getByTestId(CREATE_PR_OVERLAY);
      const ownKeystrokes: string[] = [];
      ownOverlay.addEventListener("keydown", (event) => ownKeystrokes.push(event.key));

      pressEscape(screen.getByDisplayValue("AI title"));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(ownKeystrokes).toEqual([]);
      // A claimed Escape must not swallow unrelated keys: the shell still receives those.
      ownOverlay.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
      expect(ownKeystrokes).toEqual(["a"]);
    });

    it("still closes when the keystroke is aimed at the live page behind the non-blocking shell", async () => {
      // Surface row: the shell is non-blocking, so the page behind it stays live. A keystroke whose aim
      // and focus sit on real page content — not a blur to <body> — still has no overlay owner while
      // Create PR was focused last, so dismissal must match current behavior and close the sheet.
      const { onClose } = await renderCreatePr();
      focusCreatePrField();
      const pageBehind = document.createElement("div");
      pageBehind.textContent = "board behind the shell";
      document.body.appendChild(pageBehind);
      (document.activeElement as HTMLElement).blur();

      expect(pressEscape(pageBehind)).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      pageBehind.remove();
    });

    it("still ignores bare page clicks", async () => {
      const { onClose } = await renderCreatePr();

      fireEvent.pointerDown(document.body);
      fireEvent.click(document.body);

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("floating-window-pr-create")).toBeInTheDocument();
    });

    it("still ignores a self-removing inner control", async () => {
      const { onClose } = await renderCreatePr();

      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Edited title" } });
      fireEvent.click(screen.getByRole("button", { name: /revert to ai version/i }));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId(CREATE_PR_OVERLAY)).toBeInTheDocument();
    });

    it("keeps closing from the header close and cancel buttons", async () => {
      const header = await renderCreatePr();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(header.onClose).toHaveBeenCalledTimes(1);

      cleanup();
      const cancel = await renderCreatePr();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(cancel.onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps its own Tab focus trap working", async () => {
      const { onClose } = await renderCreatePr();
      const focusables = Array.from(
        screen.getByTestId("floating-window-pr-create").querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      );
      expect(focusables.length).toBeGreaterThan(1);
      focusables[focusables.length - 1].focus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });

      expect(document.activeElement).toBe(focusables[0]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("leaves an app shortcut combo untouched while open, so the arbiter still toggles its surface", async () => {
      // Lock-in for the app-shortcut surface: the guard early-returns for non-Escape keys, so the
      // default New Task combo (Ctrl+Shift+N) reaches the arbiter unconsumed and fires normally.
      const { toggleNewTask } = mountArbiter();
      const { onClose } = await renderCreatePr();

      fireEvent.keyDown(document.body, { key: "n", ctrlKey: true, shiftKey: true });

      expect(toggleNewTask).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId(CREATE_PR_OVERLAY)).toBeInTheDocument();
    });

    it("defers an Escape a page-level listener already consumed, keeping page shortcuts first", async () => {
      // Lock-in for the page-shortcut surface: a listener that already called preventDefault owns the
      // keystroke; the guard must not claim a consumed event, so Create PR stays open.
      const { onClose } = await renderCreatePr();
      focusCreatePrField();
      const consume = (event: KeyboardEvent) => {
        if (event.key === "Escape") event.preventDefault();
      };
      window.addEventListener("keydown", consume, true);
      try {
        expect(pressEscape(document.activeElement as HTMLElement)).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByTestId(CREATE_PR_OVERLAY)).toBeInTheDocument();
      } finally {
        window.removeEventListener("keydown", consume, true);
      }
    });

    it("keeps Escape dismissal working from page focus while Create PR is the last-focused overlay", async () => {
      const { onClose } = await renderCreatePr();
      focusCreatePrField();
      (document.activeElement as HTMLElement).blur();

      pressEscape(document);

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("sibling-overlay audit: adjacent Escape owners keep single-layer dismissal", () => {
    it("a modal FloatingWindow owns no Escape dismissal of its own, so it closes nothing", async () => {
      const onClose = vi.fn();
      render(
        <FloatingWindow windowKey="rufu205-audit" title="Audit Window" onClose={onClose} modal>
          <label>
            Audit field
            <input aria-label="audit-field" />
          </label>
        </FloatingWindow>,
      );
      await screen.findByTestId("floating-window-overlay-rufu205-audit");
      const recorder = mountEscapeRecorder();

      pressEscape(screen.getByLabelText("audit-field"));

      expect(onClose).not.toHaveBeenCalled();
      expect(recorder.seen).toEqual(["Escape"]);
    });

    it("Task Detail keeps closing on its own Escape when no Create PR is mounted", async () => {
      const hostOnClose = vi.fn();
      render(
        <TaskDetailModal
          task={makeTask({ id: "RUFU-205" })}
          projectId="project-rufu205"
          onClose={hostOnClose}
          onDeleteTask={async () => ({}) as Task}
          onMergeTask={vi.fn(async () => ({ merged: false }) as MergeResult)}
          onOpenDetail={vi.fn()}
          addToast={vi.fn()}
        />,
      );
      await screen.findByTestId(HOST_OVERLAY);

      pressEscape(document.body);

      expect(hostOnClose).toHaveBeenCalledTimes(1);
    });

    it("Task Detail's in-place Refine overlay is the real second layer, and Create PR never claims its keystroke", async () => {
      const { onClose } = await renderCreatePr();
      const refineOverlay = document.createElement("div");
      refineOverlay.className = "modal-overlay open detail-refine-overlay";
      refineOverlay.innerHTML = '<div class="modal detail-refine-modal"><button type="button" aria-label="refine-action"></button></div>';
      document.body.appendChild(refineOverlay);
      const refineAction = screen.getByLabelText("refine-action");
      refineAction.focus();

      expect(pressEscape(refineAction)).toBe(false);

      expect(onClose).not.toHaveBeenCalled();
      refineOverlay.remove();
    });
  });

  describe("regression control: a claimed Escape must not leak a second dismissal", () => {
    it("a host that also closes on Escape is not double-fired by one Create PR keystroke", async () => {
      const hostOnClose = vi.fn();
      render(
        <TaskDetailModal
          task={makeTask({ id: "RUFU-205", column: "in-review" as Column })}
          projectId="project-rufu205"
          onClose={hostOnClose}
          onDeleteTask={async () => ({}) as Task}
          onMergeTask={vi.fn(async () => ({ merged: false }) as MergeResult)}
          onOpenDetail={vi.fn()}
          addToast={vi.fn()}
          prAuthAvailable
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      fireEvent.click(await screen.findByTestId("task-review-create-pr"));
      await screen.findByTestId(CREATE_PR_OVERLAY);
      const recorder = mountEscapeRecorder();

      pressEscape(screen.getByDisplayValue("AI title"));

      expect(hostOnClose).not.toHaveBeenCalled();
      expect(recorder.seen).toEqual([]);
      await waitFor(() => expect(screen.queryByTestId(CREATE_PR_OVERLAY)).toBeNull());
    });
  });
});
