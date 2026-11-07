import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, TaskDetail } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { fetchTaskDetail } from "../../api";

/*
FNXC:BoardPayloadBudget 2026-11-07-13:55 (RUFU-871):
A board row carries at most BOARD_DESCRIPTION_PREVIEW_CHARS of the spec plus
`descriptionTruncated`. These tests pin the two failures that design has to prevent: an editor
that shows the cut-off body (and would save it back over the real spec), and an editor whose
draft is destroyed by a re-render. Per-character `userEvent.type` is deliberate —
`fireEvent.change` sets a value wholesale and cannot see a remount.
*/

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, fetchTaskDetail: vi.fn() };
});

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

const FULL_SPEC = "# Contract\n\nDo the thing exactly as written, then verify it.\n\n## Steps\n\n1. Implement\n2. Verify";
const PREVIEW = FULL_SPEC.slice(0, 20);

const noop = () => {};

function boardRow(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-871",
    title: "Board row",
    column: "ideas",
    steps: [],
    dependencies: [],
    description: PREVIEW,
    descriptionTruncated: true,
    ...overrides,
  } as Task;
}

function mount(task: Task, onUpdateTask?: (id: string, patch: Partial<Task>) => Promise<unknown>) {
  return render(
    <TaskCard
      task={task}
      onOpenDetail={noop}
      addToast={noop}
      projectId="p1"
      taskColumnFlags={{ manualIntake: true } as never}
      onUpdateTask={onUpdateTask ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

/** The card renders the pencil only when its own editability rules allow an inline spec edit. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit task" }));
  return screen.findByRole("textbox");
}

beforeEach(() => {
  vi.mocked(fetchTaskDetail).mockReset();
});

describe("TaskCard inline spec editor with a bounded board preview", () => {
  it("loads the full body into the editor and keeps typing against it", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ description: FULL_SPEC } as TaskDetail);
    const user = userEvent.setup();
    mount(boardRow());

    const editor = await openEditor(user);
    await waitFor(() => expect(editor).toHaveValue(FULL_SPEC));
    expect(fetchTaskDetail).toHaveBeenCalledWith("RUFU-871", "p1");

    /* Per-character typing across the re-render the loaded body causes: a nested component or a
       draft re-seed would drop the caret and the text typed so far. */
    await user.type(editor, " tail");
    expect(editor).toHaveValue(`${FULL_SPEC} tail`);
  });

  it("never writes the bounded preview back over the stored spec", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ description: FULL_SPEC } as TaskDetail);
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    mount(boardRow(), onUpdateTask);

    const editor = await openEditor(user);
    await waitFor(() => expect(editor).toHaveValue(FULL_SPEC));

    await user.type(editor, " tail");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1));
    expect(onUpdateTask).toHaveBeenCalledWith("RUFU-871", { description: `${FULL_SPEC} tail` });
  });

  it("refuses to save a typed edit when the full body could not be loaded", async () => {
    vi.mocked(fetchTaskDetail).mockRejectedValue(new Error("offline"));
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    mount(boardRow(), onUpdateTask);

    const editor = await openEditor(user);
    await user.type(editor, "appended by hand");

    await user.keyboard("{Enter}");

    expect(onUpdateTask).not.toHaveBeenCalled();
  });

  it("does not fetch when the row already carries the whole body", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ description: FULL_SPEC } as TaskDetail);
    const user = userEvent.setup();
    mount(boardRow({ description: FULL_SPEC, descriptionTruncated: undefined }));

    const editor = await openEditor(user);
    expect(editor).toHaveValue(FULL_SPEC);
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });
});
