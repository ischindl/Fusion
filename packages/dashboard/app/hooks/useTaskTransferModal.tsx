import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskTransferSelection, TransferableTask } from "../components/TaskTransferModal";

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
The three transfer hosts (board card, list row, detail modal) need the SAME modal with a
promise-returning opener, because `runTransferTaskAction` awaits an operator decision and treats a
null resolution as cancel. Duplicating that open/resolve/await state machine in each host is three
chances to get the cancel path wrong, so one hook owns it: the host renders `transferModal` and
calls `requestTransfer(task)` from its menu handler.

The returned element is created in the hook body (an element, not a nested component definition), so
opening the modal never remounts the host's subtree, and the unmount cleanup resolves a still-open
request as cancel instead of leaving the awaiting helper hanging.

FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
The picker is LAZY-loaded and only mounted while a transfer is pending. TaskCard/ListView/
TaskDetailModal sit on every board surface, and an eager import would drag the ProjectSelector
status-icon graph (lucide `Play`/`Pause`) into every host's module graph — breaking the narrow
lucide-react mock contracts of ~40 host suites and charging every card the picker's bundle cost.
Chunking behind first-open keeps host graphs untouched and defers the cost until an operator
actually picks "Transfer to project…".
*/
const TaskTransferModalLazy = lazy(() =>
  import("../components/TaskTransferModal").then((mod) => ({ default: mod.TaskTransferModal })),
);

export interface TaskTransferModalHost {
  /** Opens the picker for `task`; resolves to the selection, or null on cancel/close/unmount. */
  requestTransfer: (task: TransferableTask) => Promise<TaskTransferSelection | null>;
  /** Render this in the host's JSX. It is inert (null) while no transfer is pending. */
  transferModal: ReactNode;
}

export function useTaskTransferModal(currentProjectId: string | null): TaskTransferModalHost {
  const [pendingTask, setPendingTask] = useState<TransferableTask | null>(null);
  const resolveRef = useRef<((selection: TaskTransferSelection | null) => void) | null>(null);

  const settle = useCallback((selection: TaskTransferSelection | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPendingTask(null);
    resolve?.(selection);
  }, []);

  const requestTransfer = useCallback((task: TransferableTask) => {
    // A second open while one is pending cancels the first rather than stacking pickers.
    resolveRef.current?.(null);
    setPendingTask(task);
    return new Promise<TaskTransferSelection | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  // Unmounting with the picker open is a cancel: the awaiting helper must not hang forever.
  useEffect(() => () => resolveRef.current?.(null), []);

  const transferModal: ReactNode =
    pendingTask !== null ? (
      <Suspense fallback={null}>
        <TaskTransferModalLazy
          task={pendingTask}
          currentProjectId={currentProjectId}
          open
          onClose={() => settle(null)}
          onConfirm={(selection) => settle(selection)}
        />
      </Suspense>
    ) : null;

  return { requestTransfer, transferModal };
}
