import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import type { Task } from "@fusion/core";
import { loadPositions, savePositions } from "./storage";
import "./DependencyGraphView.css";

const ACTIVE_COLUMNS = new Set(["triage", "todo", "in-progress", "in-review"]);
const NODE_WIDTH_REM = 18;
const NODE_HEIGHT_REM = 9;
const GRID_GAP_X_REM = 3;
const GRID_GAP_Y_REM = 4;
const DRAG_THRESHOLD_REM = 0.5;
const SCENE_PADDING_REM = 2;
const FIT_PADDING_REM = 2;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2;
const WHEEL_ZOOM_FACTOR = 0.002;
const MOBILE_BREAKPOINT = 768;

export interface DependencyGraphHostContext {
  projectId?: string;
  tasks: Task[];
  openTaskDetail: (task: Task) => void;
  renderTaskCard: (task: Task) => ReactNode;
}

export interface PluginDashboardViewComponentProps {
  context: DependencyGraphHostContext;
}

type Position = { x: number; y: number };

function getDistance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

export function DependencyGraphView({ context }: PluginDashboardViewComponentProps) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 });
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, Position>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const persisted = useMemo(() => loadPositions(context.projectId), [context.projectId]);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Multi-pointer tracking (no setPointerCapture — it breaks two-finger gestures)
  const pointersRef = useRef<Map<number, Position>>(new Map());
  const interactionRef = useRef<
    | { kind: "node"; taskId: string; startPointer: Position; startNode: Position; moved: boolean }
    | { kind: "pan"; startPointer: Position; startPan: Position; moved: boolean }
    | null
  >(null);
  const pinchRef = useRef<{ startDistance: number; startScale: number } | null>(null);
  const autoFitDoneRef = useRef(false);

  const tasks = useMemo(
    () => context.tasks.filter((task) => ACTIVE_COLUMNS.has(task.column)),
    [context.tasks],
  );

  const positioned = useMemo(() => {
    return tasks.map((task, index) => {
      const saved = nodeOverrides[task.id] ?? persisted[task.id];
      return {
        task,
        x: saved?.x ?? (index % 4) * (NODE_WIDTH_REM + GRID_GAP_X_REM),
        y: saved?.y ?? Math.floor(index / 4) * (NODE_HEIGHT_REM + GRID_GAP_Y_REM),
      };
    });
  }, [nodeOverrides, persisted, tasks]);

  const map = useMemo(() => new Map(positioned.map((node) => [node.task.id, node])), [positioned]);

  const edges = useMemo(() => {
    const lines: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
    positioned.forEach((node) => {
      (node.task.dependencies ?? []).forEach((dependencyId) => {
        const dependency = map.get(dependencyId);
        if (!dependency) return;
        lines.push({
          from: dependencyId,
          to: node.task.id,
          x1: dependency.x + NODE_WIDTH_REM,
          y1: dependency.y + NODE_HEIGHT_REM / 2,
          x2: node.x,
          y2: node.y + NODE_HEIGHT_REM / 2,
        });
      });
    });
    return lines;
  }, [map, positioned]);

  const bounds = useMemo(() => {
    if (positioned.length === 0) {
      return { minX: 0, minY: 0, width: NODE_WIDTH_REM * 2, height: NODE_HEIGHT_REM * 2 };
    }

    const minX = Math.min(...positioned.map((node) => node.x)) - SCENE_PADDING_REM;
    const minY = Math.min(...positioned.map((node) => node.y)) - SCENE_PADDING_REM;
    const maxX = Math.max(...positioned.map((node) => node.x + NODE_WIDTH_REM)) + SCENE_PADDING_REM;
    const maxY = Math.max(...positioned.map((node) => node.y + NODE_HEIGHT_REM)) + SCENE_PADDING_REM;

    return {
      minX,
      minY,
      width: Math.max(NODE_WIDTH_REM * 2, maxX - minX),
      height: Math.max(NODE_HEIGHT_REM * 2, maxY - minY),
    };
  }, [positioned]);

  const positionedForRender = useMemo(
    () =>
      positioned.map((node) => ({
        ...node,
        renderX: node.x - bounds.minX,
        renderY: node.y - bounds.minY,
      })),
    [bounds.minX, bounds.minY, positioned],
  );

  const edgesForRender = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        renderX1: edge.x1 - bounds.minX,
        renderY1: edge.y1 - bounds.minY,
        renderX2: edge.x2 - bounds.minX,
        renderY2: edge.y2 - bounds.minY,
      })),
    [bounds.minX, bounds.minY, edges],
  );

  const dependencyGraph = useMemo(() => {
    const downstream = new Map<string, Set<string>>();
    const upstream = new Map<string, Set<string>>();

    edges.forEach((edge) => {
      downstream.set(edge.from, (downstream.get(edge.from) ?? new Set<string>()).add(edge.to));
      upstream.set(edge.to, (upstream.get(edge.to) ?? new Set<string>()).add(edge.from));
    });

    return { downstream, upstream };
  }, [edges]);

  const focusTaskId = hoveredTaskId ?? selectedTaskId;

  const relatedTaskIds = useMemo(() => {
    if (!focusTaskId) return null;

    const related = new Set<string>([focusTaskId]);
    const walk = (seed: string, map: Map<string, Set<string>>) => {
      const queue = [seed];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        (map.get(current) ?? new Set<string>()).forEach((next) => {
          if (related.has(next)) return;
          related.add(next);
          queue.push(next);
        });
      }
    };

    walk(focusTaskId, dependencyGraph.downstream);
    walk(focusTaskId, dependencyGraph.upstream);

    return related;
  }, [dependencyGraph.downstream, dependencyGraph.upstream, focusTaskId]);

  const fitToGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rootFontSize = Number.parseFloat(globalThis.getComputedStyle(document.documentElement).fontSize) || 16;
    const widthPx = bounds.width * rootFontSize;
    const heightPx = bounds.height * rootFontSize;
    const paddingPx = FIT_PADDING_REM * rootFontSize;
    const availableWidth = Math.max(1, canvas.clientWidth - paddingPx * 2);
    const availableHeight = Math.max(1, canvas.clientHeight - paddingPx * 2);

    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availableWidth / widthPx, availableHeight / heightPx)));
    const centeredPanX = (canvas.clientWidth - widthPx * nextScale) / (2 * rootFontSize * nextScale);
    const centeredPanY = (canvas.clientHeight - heightPx * nextScale) / (2 * rootFontSize * nextScale);

    setScale(nextScale);
    setPan({ x: centeredPanX, y: centeredPanY });
  }, [bounds.width, bounds.height]);

  // Auto-fit on initial mobile load
  useEffect(() => {
    if (autoFitDoneRef.current) return;
    if (!isMobileViewport()) return;
    if (positioned.length === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Ensure the canvas has non-zero dimensions before fitting
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;

    autoFitDoneRef.current = true;
    // Use rAF to ensure layout is settled
    requestAnimationFrame(() => {
      fitToGraph();
    });
  }, [fitToGraph, positioned.length]);

  const persistPosition = (taskId: string, next: Position) => {
    setNodeOverrides((current) => ({ ...current, [taskId]: next }));
    savePositions(context.projectId, { ...persisted, ...nodeOverrides, [taskId]: next });
  };

  const handlePointerDownOnNode = (taskId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const hit = map.get(taskId);
    if (!hit) return;

    // Track this pointer in the global map
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    interactionRef.current = {
      kind: "node",
      taskId,
      startPointer: { x: event.clientX, y: event.clientY },
      startNode: { x: hit.x, y: hit.y },
      moved: false,
    };
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    // Track this pointer
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // If we already have another pointer, this is the start of a pinch gesture
    if (pointersRef.current.size === 2) {
      // Cancel any ongoing pan interaction
      interactionRef.current = null;
      const [p1, p2] = Array.from(pointersRef.current.values());
      const distance = getDistance(p1, p2);
      pinchRef.current = { startDistance: distance, startScale: scale };
      return;
    }

    interactionRef.current = {
      kind: "pan",
      startPointer: { x: event.clientX, y: event.clientY },
      startPan: pan,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Update tracked pointer position
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Handle pinch gesture when two pointers are active
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const currentDistance = getDistance(p1, p2);
      const scaleFactor = currentDistance / pinchRef.current.startDistance;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchRef.current.startScale * scaleFactor));
      setScale(newScale);
      return;
    }

    const current = interactionRef.current;
    if (!current) return;

    const delta = {
      x: (event.clientX - current.startPointer.x) / 16,
      y: (event.clientY - current.startPointer.y) / 16,
    };

    if (current.kind === "node") {
      const moved = getDistance({ x: 0, y: 0 }, delta) > DRAG_THRESHOLD_REM;
      if (moved && !current.moved) current.moved = true;
      if (!current.moved) return;
      setNodeOverrides((existing) => ({
        ...existing,
        [current.taskId]: { x: current.startNode.x + delta.x / scale, y: current.startNode.y + delta.y / scale },
      }));
      return;
    }

    const moved = getDistance({ x: 0, y: 0 }, delta) > DRAG_THRESHOLD_REM;
    if (moved && !current.moved) current.moved = true;
    if (!current.moved) return;
    setPan({ x: current.startPan.x + delta.x, y: current.startPan.y + delta.y });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);

    // If we had a pinch and one finger remains, end pinch mode
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
      }
      return;
    }

    const current = interactionRef.current;
    interactionRef.current = null;
    if (!current) return;

    if (current.kind === "node") {
      const hit = map.get(current.taskId);
      if (!hit) return;

      if (!current.moved) {
        context.openTaskDetail(hit.task);
        return;
      }

      persistPosition(current.taskId, { x: hit.x, y: hit.y });
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    interactionRef.current = null;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rootFontSize = Number.parseFloat(globalThis.getComputedStyle(document.documentElement).fontSize) || 16;
    const delta = -event.deltaY * WHEEL_ZOOM_FACTOR;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)));

    // Zoom toward the pointer position
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    // How much the point under the cursor should shift in rem
    const scaleRatio = newScale / scale;
    const panOffsetX = (pointerX / rootFontSize) * (1 - scaleRatio) / scale;
    const panOffsetY = (pointerY / rootFontSize) * (1 - scaleRatio) / scale;

    setScale(newScale);
    setPan((prev) => ({
      x: prev.x + panOffsetX * newScale / scale,
      y: prev.y + panOffsetY * newScale / scale,
    }));
  };

  return (
    <section className="dependency-graph-view">
      <div className="dependency-graph-controls">
        <button className="btn btn-sm" onClick={() => setScale((value) => Math.min(value + 0.1, MAX_SCALE))}>Zoom In</button>
        <button className="btn btn-sm" onClick={() => setScale((value) => Math.max(value - 0.1, MIN_SCALE))}>Zoom Out</button>
        <button className="btn btn-sm" onClick={fitToGraph}>Fit</button>
      </div>

      <div
        className="dependency-graph-canvas"
        ref={canvasRef}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
      >
        {tasks.length === 0 ? (
          <div className="dependency-graph-empty">
            <p>No tasks to display. Tasks in Triage, Todo, In Progress, or In Review columns will appear here.</p>
          </div>
        ) : (
          <div
            className="dependency-graph-scene"
            style={{
              width: `${bounds.width}rem`,
              height: `${bounds.height}rem`,
              transform: `translate(${pan.x}rem, ${pan.y}rem) scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <svg className="dependency-graph-edges" viewBox={`0 0 ${bounds.width} ${bounds.height}`}>
              {edgesForRender.map((edge) => (
                <line
                  key={`${edge.from}-${edge.to}`}
                  x1={edge.renderX1}
                  y1={edge.renderY1}
                  x2={edge.renderX2}
                  y2={edge.renderY2}
                  className={`dependency-graph-edge${relatedTaskIds ? relatedTaskIds.has(edge.from) && relatedTaskIds.has(edge.to) ? " is-related" : " is-dimmed" : ""}`}
                />
              ))}
            </svg>

            {positionedForRender.map((node) => (
              <div
                key={node.task.id}
                className={`dependency-graph-node${selectedTaskId === node.task.id ? " is-selected" : ""}${relatedTaskIds ? relatedTaskIds.has(node.task.id) ? " is-related" : " is-dimmed" : ""}`}
                style={{
                  width: `${NODE_WIDTH_REM}rem`,
                  minHeight: `${NODE_HEIGHT_REM}rem`,
                  transform: `translate(${node.renderX}rem, ${node.renderY}rem)`,
                }}
                onPointerDown={(event) => handlePointerDownOnNode(node.task.id, event)}
                onPointerEnter={() => setHoveredTaskId(node.task.id)}
                onPointerLeave={() => setHoveredTaskId((current) => (current === node.task.id ? null : current))}
              >
                {context.renderTaskCard(node.task)}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
