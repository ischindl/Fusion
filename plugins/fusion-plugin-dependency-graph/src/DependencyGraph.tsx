import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { Task } from "@fusion/core";
import { TaskCard } from "@fusion/dashboard/app/components/TaskCard";
import { GraphEdges } from "./edges";
import { filterGraphTasks } from "./filters";
import { computeAutoLayout } from "./layout";
import { useGraphData } from "./useGraphData";
import { useGraphInteraction } from "./useGraphInteraction";
import "./DependencyGraph.css";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;

export interface DependencyGraphProps {
  tasks: Task[];
  projectId?: string;
  onOpenTaskDetail: (taskId: string) => void;
}

export function DependencyGraph({ tasks, projectId, onOpenTaskDetail }: DependencyGraphProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const filteredTasks = useMemo(() => filterGraphTasks(tasks), [tasks]);
  const graphData = useGraphData(filteredTasks);
  const positions = useMemo(
    () => computeAutoLayout(graphData, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, horizontalGap: 40, verticalGap: 80 }),
    [graphData],
  );

  const {
    transform,
    zoomIn,
    zoomOut,
    fitToGraph,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelZoom,
  } = useGraphInteraction();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
  }, [fitToGraph, positions]);

  const bounds = useMemo(() => {
    const values = Array.from(positions.values());
    if (values.length === 0) return { width: 0, height: 0 };
    const maxX = Math.max(...values.map((pos) => pos.x + NODE_WIDTH));
    const maxY = Math.max(...values.map((pos) => pos.y + NODE_HEIGHT));
    return { width: maxX, height: maxY };
  }, [positions]);

  return (
    <section className="dependency-graph" data-testid="dependency-graph">
      <div
        ref={viewportRef}
        className="dependency-graph__viewport"
        onPointerDown={(event) => onPointerDown(event.pointerId, { x: event.clientX, y: event.clientY })}
        onPointerMove={(event) => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          onPointerMove(event.pointerId, { x: event.clientX, y: event.clientY }, viewport.clientWidth, viewport.clientHeight);
        }}
        onPointerUp={(event) => onPointerUp(event.pointerId)}
        onPointerCancel={(event) => onPointerUp(event.pointerId)}
        onWheel={(event) => {
          event.preventDefault();
          const viewport = viewportRef.current;
          if (!viewport) return;
          const rect = viewport.getBoundingClientRect();
          onWheelZoom(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewport.clientWidth, viewport.clientHeight);
        }}
      >
        {filteredTasks.length === 0 ? (
          <div className="dependency-graph__empty">No active tasks to display in graph view.</div>
        ) : (
          <div className="dependency-graph__canvas" style={{ transform, width: `${bounds.width}px`, height: `${bounds.height}px` }}>
            <GraphEdges edges={graphData.edges} positions={positions} nodeWidth={NODE_WIDTH} nodeHeight={NODE_HEIGHT} />
            {graphData.nodes.map((node) => {
              const position = positions.get(node.task.id);
              if (!position) return null;

              return (
                <div
                  key={node.task.id}
                  className="dependency-graph__node"
                  style={{ width: `${NODE_WIDTH}px`, minHeight: `${NODE_HEIGHT}px`, left: `${position.x}px`, top: `${position.y}px` }}
                >
                  <TaskCard
                    task={node.task}
                    projectId={projectId}
                    onOpenDetail={() => onOpenTaskDetail(node.task.id)}
                    addToast={() => {}}
                    disableDrag={true}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="dependency-graph__toolbar">
        <button className="btn btn-icon" aria-label="Fit to screen" onClick={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          fitToGraph(positions, viewport.clientWidth, viewport.clientHeight, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT });
        }}>
          <Maximize size={16} />
        </button>
        <button className="btn btn-icon" aria-label="Zoom in" onClick={zoomIn}><ZoomIn size={16} /></button>
        <button className="btn btn-icon" aria-label="Zoom out" onClick={zoomOut}><ZoomOut size={16} /></button>
      </div>
    </section>
  );
}
