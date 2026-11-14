import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Column as ColumnType, Task } from "@fusion/core";
import { loadComponentCss } from "../../test/cssFixture";
import { Column } from "../Column";

vi.mock("../TaskCard", () => ({ TaskCard: ({ task }: { task: Task }) => <article data-testid={`task-${task.id}`}>{task.id}</article> }));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => null }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => null }));
vi.mock("../../hooks/usePluginUiSlots", () => ({ usePluginUiSlots: () => ({ slots: [], getSlotsForId: () => [], loading: false, error: null }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirmWithCheckbox: async (options?: { checkbox?: { defaultChecked?: boolean } }) => ({ choice: "cancel" as const, checkboxValue: options?.checkbox?.defaultChecked ?? false }), confirm: vi.fn() }) }));

function task(index: number): Task {
  return {
    id: `FN-${index}`,
    title: `Task ${index}`,
    description: "",
    column: "done" as ColumnType,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

const props = {
  column: "done" as ColumnType,
  columnFlags: { complete: true },
  workflowMode: true,
  maxConcurrent: 1,
  maxWorktrees: 1,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

afterEach(() => vi.unstubAllGlobals());

describe("Column scroll geometry", () => {
  it("keeps virtual spacers in normal flow and includes row spacing in measurements", () => {
    const css = loadComponentCss("Column.css");
    expect(css).toMatch(/\.column-body\s*\{[^}]*display:\s*block/s);
    expect(css).toMatch(/\.column-virtual-row\s*\{[^}]*padding-block-end:\s*var\(--space-xs\)/s);
    expect(css).toMatch(/\.column-virtual-spacer\s*\{[^}]*inline-size:\s*100%/s);
  });

  it.each([1_200, 768, 600])("reaches the final logical row with at most 40 mounted rows at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    vi.stubGlobal("ResizeObserver", undefined);
    const tasks = Array.from({ length: 10_000 }, (_, index) => task(index));
    render(<Column {...props} tasks={tasks} />);
    const root = document.querySelector<HTMLElement>(".column-body")!;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 3_200_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    root.scrollTop = root.scrollHeight - root.clientHeight;
    await act(async () => {
      fireEvent.scroll(root);
      await Promise.resolve();
    });

    expect(document.querySelectorAll("[data-virtual-task-row]").length).toBeLessThanOrEqual(40);
    expect(document.querySelector("[data-virtual-task-row='FN-9999']")).not.toBeNull();
    const spacerHeights = [...document.querySelectorAll<HTMLElement>(".column-virtual-spacer")].map((node) => Number.parseFloat(node.style.height));
    expect(spacerHeights.some((height) => height > 0)).toBe(true);

    root.scrollTop = 0;
    await act(async () => {
      fireEvent.scroll(root);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-virtual-task-row='FN-0']")).not.toBeNull();
  });

  /*
  FNXC:BoardOrdering 2026-11-13-15:55 (RUFU-526):
  Which lanes follow the start on a prepend is now decided by the ORDER the lane runs, not by which lane
  is `complete`. The first version of this test pinned the rule to the complete trait, because Done was
  the only lane whose head rows arrived at. RUFU-526 made the lane head an arriving position everywhere
  the attention ladder runs, and a prepend into a lane the operator is reading from the top used to be
  compensated by `estimateHeight` (320px here), which pushed the freshly-promoted attention head ABOVE
  the fold — measured in a real Chromium phone lane as `scrollTop` 320 / card top -218, the same "buried
  by idle cards" symptom the card exists to remove. So the expectation is now a function of the flags:
  a lane the ladder ranks keeps the head visible; manual intake, whose newest-first order has no waiting
  queue to rank, keeps the historical anchor compensation; the column id still decides nothing.
  */
  it.each([
    { name: "complete", column: "finished", columnFlags: { complete: true }, expectedScrollTop: 0 },
    { name: "attention-ranked review", column: "reviewed", columnFlags: { mergeBlocker: true }, expectedScrollTop: 0 },
    { name: "attention-ranked hold", column: "waiting", columnFlags: { hold: true }, expectedScrollTop: 0 },
    { name: "manual intake", column: "ideas", columnFlags: { intake: true, manualIntake: true }, expectedScrollTop: 320 },
  ])("follows the start on a lane-head prepend for the $name lane, by trait not id", async ({ column, columnFlags, expectedScrollTop }) => {
    vi.stubGlobal("ResizeObserver", undefined);
    const tasks = Array.from({ length: 100 }, (_, index) => task(index));
    const view = render(<Column {...props} column={column as ColumnType} columnFlags={columnFlags} tasks={tasks} />);
    const body = document.querySelector<HTMLElement>(".column-body")!;
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 32_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(body);
    view.rerender(<Column {...props} column={column as ColumnType} columnFlags={columnFlags} tasks={[task(-1), ...tasks]} />);
    expect(body.scrollTop).toBe(expectedScrollTop);
    view.unmount();
  });

  it("preserves user scroll across an ordinary task refresh", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const tasks = Array.from({ length: 100 }, (_, index) => task(index));
    const { rerender } = render(<Column {...props} tasks={tasks} />);
    const root = document.querySelector<HTMLElement>(".column-body")!;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 32_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    root.scrollTop = 1_600;
    await act(async () => {
      fireEvent.scroll(root);
      await Promise.resolve();
    });
    rerender(<Column {...props} tasks={[...tasks]} />);

    expect(root.scrollTop).toBe(1_600);
    expect(document.querySelector("[data-virtual-task-row='FN-0']")).toBeNull();
  });
});
