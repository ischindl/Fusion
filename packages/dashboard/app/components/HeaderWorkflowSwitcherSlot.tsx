import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { useViewportMode } from "../hooks/useViewportMode";
import { WorkflowSwitcher } from "./WorkflowSwitcher";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";

export interface HeaderWorkflowSelection {
  boardWorkflows: BoardWorkflowsPayload;
  selectedWorkflow: BoardWorkflowDefinition;
}

interface HeaderWorkflowSwitcherSlotProps {
  projectId?: string;
  onOpenWorkflowEditor?: () => void;
  onCreateWorkflow?: () => void;
  onWorkflowSelectionChange?: (selection: HeaderWorkflowSelection | null) => void;
}

// Counts require live task/column data that non-board header slots do not thread here.
// WorkflowSwitcher renders zero counts for an empty map, so pass a stable empty Map.
const EMPTY_COUNTS: Map<string, WorkflowStatusCounts> = new Map();

export function HeaderWorkflowSwitcherSlot({
  projectId,
  onOpenWorkflowEditor,
  onCreateWorkflow,
  onWorkflowSelectionChange,
}: HeaderWorkflowSwitcherSlotProps) {
  const {
    boardWorkflows,
    workflowMode,
    workflowOptions,
    selectedWorkflow,
    setSelectedWorkflowId,
    refreshBoardWorkflows,
  } = useBoardWorkflows({ projectId });
  const viewportMode = useViewportMode();

  const [headerWorkflowSlot, setHeaderWorkflowSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.getElementById("header-workflow-slot");
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolve = () => {
      const slot = document.getElementById("header-workflow-slot");
      setHeaderWorkflowSlot((previous) => (previous === slot ? previous : slot));
      return slot;
    };
    if (resolve()) return;
    /*
    FNXC:MissionWorkflows 2026-06-25-00:00:
    Missions shares Planning's header workflow dropdown because mission triage creates tasks. The header slot can be absent on mobile or during layout swaps, so poll only briefly and re-resolve on viewport changes to avoid an empty toolbar shell or an unbounded timer.
    */
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (resolve() || attempts >= 20) window.clearInterval(interval);
    }, 250);
    return () => window.clearInterval(interval);
  }, [viewportMode]);

  const selection = useMemo<HeaderWorkflowSelection | null>(() => {
    if (!workflowMode || !boardWorkflows || !selectedWorkflow) return null;
    return { boardWorkflows, selectedWorkflow };
  }, [boardWorkflows, selectedWorkflow, workflowMode]);

  useEffect(() => {
    onWorkflowSelectionChange?.(selection);
  }, [onWorkflowSelectionChange, selection]);

  useEffect(() => {
    return () => onWorkflowSelectionChange?.(null);
  }, [onWorkflowSelectionChange]);

  if (!workflowMode || !selectedWorkflow || workflowOptions.length < 2 || !headerWorkflowSlot) {
    return null;
  }

  return createPortal(
    <div className="board-workflow-toolbar">
      <div className="board-workflow-selector">
        <WorkflowSwitcher
          workflows={workflowOptions}
          value={selectedWorkflow.id}
          onChange={setSelectedWorkflowId}
          counts={EMPTY_COUNTS}
          onOpen={refreshBoardWorkflows}
          onEditWorkflow={onOpenWorkflowEditor}
          onCreateWorkflow={onCreateWorkflow}
        />
      </div>
    </div>,
    headerWorkflowSlot,
  );
}
