import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act, cleanup } from "@testing-library/react";
import * as React from "react";
import { DependencyGraphView } from "../DependencyGraphView";
import type { DependencyGraphHostContext, PluginDashboardViewComponentProps } from "../DependencyGraphView";
import type { Task } from "@fusion/core";

// Mock storage to avoid localStorage dependency
vi.mock("../storage", () => ({
  loadPositions: () => ({}),
  savePositions: () => {},
}));

// Helper to create a minimal Task
function createTask(overrides: Partial<Task> & { id: string; column: Task["column"] }): Task {
  return {
    description: overrides.description ?? `Task ${overrides.id}`,
    column: overrides.column,
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    ...overrides,
  } as Task;
}

function createMockContext(tasks: Task[] = []): DependencyGraphHostContext {
  return {
    projectId: "test-project",
    tasks,
    openTaskDetail: vi.fn(),
    renderTaskCard: (task: Task) => React.createElement("div", { "data-testid": "task-card" }, task.id),
  };
}

function renderView(context?: DependencyGraphHostContext) {
  const props: PluginDashboardViewComponentProps = {
    context: context ?? createMockContext(),
  };
  return render(React.createElement(DependencyGraphView, props));
}

describe("DependencyGraphView", () => {
  beforeEach(() => {
    // Mock getComputedStyle for rem calculations
    vi.spyOn(window, "getComputedStyle").mockImplementation((() => {
      return { fontSize: "16px" } as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle);

    // Mock matchMedia to default to desktop
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders empty state when no active-column tasks provided", () => {
    const { container } = renderView(createMockContext([]));
    const empty = container.querySelector(".dependency-graph-empty");
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain("No tasks to display");
  });

  it("renders nodes for active-column tasks", () => {
    const tasks = [
      createTask({ id: "FN-001", column: "todo" }),
      createTask({ id: "FN-002", column: "in-progress" }),
    ];
    const { container } = renderView(createMockContext(tasks));
    const nodes = container.querySelectorAll(".dependency-graph-node");
    expect(nodes.length).toBe(2);
  });

  it("filters out tasks not in active columns", () => {
    const tasks = [
      createTask({ id: "FN-001", column: "todo" }),
      createTask({ id: "FN-002", column: "done" }),
      createTask({ id: "FN-003", column: "archived" }),
    ];
    const { container } = renderView(createMockContext(tasks));
    const nodes = container.querySelectorAll(".dependency-graph-node");
    expect(nodes.length).toBe(1);
  });

  it("renders edges for tasks with dependencies in the active set", () => {
    const tasks = [
      createTask({ id: "FN-001", column: "todo" }),
      createTask({ id: "FN-002", column: "todo", dependencies: ["FN-001"] }),
    ];
    const { container } = renderView(createMockContext(tasks));
    const edges = container.querySelectorAll(".dependency-graph-edge");
    expect(edges.length).toBe(1);
  });

  it("does not render edges for dependencies not in the active set", () => {
    const tasks = [
      createTask({ id: "FN-002", column: "todo", dependencies: ["FN-999"] }),
    ];
    const { container } = renderView(createMockContext(tasks));
    const edges = container.querySelectorAll(".dependency-graph-edge");
    expect(edges.length).toBe(0);
  });

  it("zoom-in button increases scale", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container, unmount } = renderView(createMockContext(tasks));
    const zoomInBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Zoom In")!;
    fireEvent.click(zoomInBtn);
    const scene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    expect(scene).toBeTruthy();
    const transform = scene.style.transform;
    expect(transform).toMatch(/scale\([1-9]/);
  });

  it("zoom-out button decreases scale", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container, unmount } = renderView(createMockContext(tasks));
    const zoomOutBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Zoom Out")!;
    fireEvent.click(zoomOutBtn);
    const scene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    expect(scene).toBeTruthy();
    const transform = scene.style.transform;
    expect(transform).toMatch(/scale\(0\./);
  });

  it("fit-to-graph button produces a valid scale", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container, unmount } = renderView(createMockContext(tasks));

    // Mock canvas dimensions for fitToGraph
    const canvas = container.querySelector(".dependency-graph-canvas") as HTMLElement;
    if (canvas) {
      Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
      Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
    }

    const fitBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Fit")!;
    fireEvent.click(fitBtn);

    const scene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    expect(scene).toBeTruthy();
    const transform = scene.style.transform;
    const scaleMatch = transform.match(/scale\(([\d.]+)\)/);
    expect(scaleMatch).toBeTruthy();
    const scaleValue = parseFloat(scaleMatch![1]);
    expect(scaleValue).toBeGreaterThanOrEqual(0.4);
    expect(scaleValue).toBeLessThanOrEqual(2);
  });

  it("wheel event zooms the graph", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container } = renderView(createMockContext(tasks));
    const canvas = container.querySelector(".dependency-graph-canvas") as HTMLElement;

    expect(canvas).toBeTruthy();

    // Mock getBoundingClientRect on the canvas
    canvas.getBoundingClientRect = vi.fn().mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
    });

    const initialScene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    const initialTransform = initialScene.style.transform;

    // Negative deltaY = zoom in
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 300 });

    const updatedScene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    const updatedTransform = updatedScene.style.transform;

    expect(updatedTransform).not.toBe(initialTransform);
    const scaleMatch = updatedTransform.match(/scale\(([\d.]+)\)/);
    expect(scaleMatch).toBeTruthy();
    expect(parseFloat(scaleMatch![1])).toBeGreaterThan(1);
  });

  it("pinch gesture changes scale", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container } = renderView(createMockContext(tasks));
    const canvas = container.querySelector(".dependency-graph-canvas") as HTMLElement;

    expect(canvas).toBeTruthy();

    // First pointer down (finger 1)
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 200,
      clientY: 300,
    });

    // Second pointer down (finger 2) — starts pinch
    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      clientX: 600,
      clientY: 300,
    });

    // Move fingers apart (increasing distance)
    fireEvent.pointerMove(canvas, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 300,
    });

    fireEvent.pointerMove(canvas, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 700,
      clientY: 300,
    });

    const scene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    const transform = scene.style.transform;
    const scaleMatch = transform.match(/scale\(([\d.]+)\)/);
    expect(scaleMatch).toBeTruthy();
    expect(parseFloat(scaleMatch![1])).toBeGreaterThan(1);
  });

  it("scale is clamped between MIN_SCALE and MAX_SCALE", () => {
    const tasks = [createTask({ id: "FN-001", column: "todo" })];
    const { container, unmount } = renderView(createMockContext(tasks));

    // Try to zoom in beyond MAX_SCALE (2.0)
    const zoomInBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Zoom In")!;
    for (let i = 0; i < 50; i++) {
      fireEvent.click(zoomInBtn);
    }

    const scene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    let scaleMatch = scene.style.transform.match(/scale\(([\d.]+)\)/);
    expect(scaleMatch).toBeTruthy();
    expect(parseFloat(scaleMatch![1])).toBeLessThanOrEqual(2);

    // Try to zoom out beyond MIN_SCALE (0.4)
    const zoomOutBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Zoom Out")!;
    for (let i = 0; i < 100; i++) {
      fireEvent.click(zoomOutBtn);
    }

    const updatedScene = container.querySelector(".dependency-graph-scene") as HTMLElement;
    scaleMatch = updatedScene.style.transform.match(/scale\(([\d.]+)\)/);
    expect(scaleMatch).toBeTruthy();
    expect(parseFloat(scaleMatch![1])).toBeGreaterThanOrEqual(0.4);
  });
});
