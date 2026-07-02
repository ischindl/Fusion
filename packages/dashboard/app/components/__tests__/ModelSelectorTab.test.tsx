import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { ModelSelectorTab } from "../ModelSelectorTab";

vi.mock("../../api", () => ({
  fetchModels: vi.fn(),
  updateTask: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const { fetchModels, updateTask } = await import("../../api");
const mockFetchModels = vi.mocked(fetchModels);
const mockUpdateTask = vi.mocked(updateTask);

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7398",
    title: "Anthropic model selector",
    description: "Verify Claude CLI model selection",
    column: "todo",
    steps: [],
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as TaskDetail;
}

describe("ModelSelectorTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(SWR_CACHE_KEYS.MODELS);
    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "pi-claude-cli", id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", reasoning: true, contextWindow: 1_000_000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
    });
  });

  it("renders and selects Anthropic Claude CLI rows from the shared model catalog", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const task = makeTask();
    mockUpdateTask.mockResolvedValueOnce({
      ...task,
      modelProvider: "pi-claude-cli",
      modelId: "claude-sonnet-5",
    });

    render(
      <ModelSelectorTab
        task={task}
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/No models available/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Executor Model"));

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("pi-claude-cli")).toBeInTheDocument();
    await user.click(within(listbox).getByText("Claude Sonnet 5 (CLI)"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-7398", {
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      });
      expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
        modelProvider: "pi-claude-cli",
        modelId: "claude-sonnet-5",
      }));
    });
  });

  it("updates from a cached empty catalog to populated Claude CLI rows without remounting", async () => {
    localStorage.setItem(
      SWR_CACHE_KEYS.MODELS,
      JSON.stringify({
        savedAt: Date.now(),
        data: { models: [], favoriteProviders: [], favoriteModels: [] },
      }),
    );

    render(<ModelSelectorTab task={makeTask()} addToast={vi.fn()} />);

    expect(screen.getByText(/No models available/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(/No models available/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });
  });
});
