import { AgentStore } from "../agents/agent-store.js";
import { MessageStore } from "../stores/message-store.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { resolveLifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import type { WorkflowIr, WorkflowIrColumn } from "../workflows/workflow-ir-types.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import type { RunAuditEventInput } from "../types.js";
import {
  deliverTaskComment,
  resolveTaskCommentRecipient,
  type TaskCommentColumnBinding,
  type TaskCommentDeliveryInput,
  type TaskCommentDeliveryResult,
  type TaskCommentLane,
} from "./task-comment-delivery.js";

/*
FNXC:CommentDelivery 2026-09-27-18:05 (RUFU-259):
Every write surface used to hand its comment straight to a wake helper and report success. This module
is the one place that turns "a comment row was appended" into "an agent was given the body": it reads
the lane state a comment write needs — the durable agent list, the selected workflow's column bindings,
the messaging transport — and then defers the actual write and reporting to the pure seam in
`task-comment-delivery.js`.

It lives in core rather than the dashboard because the CLI writes comments too, and a fix that only
taught the dashboard to deliver would leave `fn task comment`/`fn task steer` in the old lossy shape.
Wake policy stays with the caller: the dashboard passes its own heartbeat trigger as `onRouted` because
only it holds a heartbeat monitor, while the CLI has no in-process engine and relies on the durable
inbox row plus the operator notice.
*/

/** The task facts the resolver needs; a plain subset so a caller may pass a hydrated task or a row. */
export interface TaskCommentTaskFacts {
  id: string;
  /** Board column the card sits in when the comment is written. */
  column?: string;
  assignedAgentId?: string | null;
  /** A card with its own model lane selection makes a `defer` column binding yield. */
  modelId?: string;
}

/** The store capabilities the host needs. `TaskStore` satisfies all of them. */
export interface TaskCommentStoreHost {
  getAsyncLayer?: () => AsyncDataLayer | null | undefined;
  getFusionDir?: () => string;
  getRootDir?: () => string;
  /** The bounded run-audit sink and the card-log writer; both optional — delivery must not need them. */
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
  logEntryOnce?: (
    id: string,
    input: { action: string; outcome?: string; dedupeKey: string; windowMs: number },
  ) => Promise<unknown>;
}

export interface DeliverTaskCommentFromStoreInput {
  store: TaskCommentStoreHost;
  task: TaskCommentTaskFacts;
  comment: TaskCommentDeliveryInput["comment"];
  source: TaskCommentDeliveryInput["source"];
  /**
   * Called after a successful routing with the recipient, so the host can wake it. The durable inbox
   * row is already written when this runs, so a host that cannot wake (the CLI) simply omits it.
   */
  onRouted?: (recipientAgentId: string, result: TaskCommentDeliveryResult) => void | Promise<void>;
}

/**
 * The columns that hold a card *before* work starts, in declaration order.
 *
 * FNXC:CommentDelivery 2026-09-27-18:20 (RUFU-259): the test is POSITIONAL, not "does this column
 * carry the hold trait": a hold that sits AFTER wip is a review-side dwell (an approved-then-held
 * card), and routing an operator's note about in-flight work to the planner would put the body where
 * nobody is looking for it. A hold before wip is the planning dwell, and the agent bound to either of
 * these columns is the workflow's planner.
 */
function planningColumnIds(ir: WorkflowIr, columns: readonly WorkflowIrColumn[]): string[] {
  const roles = resolveLifecycleColumns(ir);
  if (!roles) return [];
  const indexOf = (id: string | undefined): number =>
    id === undefined ? -1 : columns.findIndex((column) => column.id === id);
  const ids = roles.intake ? [roles.intake] : [];
  const wipIndex = indexOf(roles.wip);
  const holdIndex = indexOf(roles.hold);
  if (holdIndex >= 0 && wipIndex >= 0 && holdIndex < wipIndex && roles.hold) ids.push(roles.hold);
  return ids;
}

/** Read the card's column bindings and lane from its own selected workflow IR. */
async function resolveColumnContext(store: TaskCommentStoreHost & Partial<WorkflowIrResolverStore>, task: TaskCommentTaskFacts): Promise<{
  columnBinding: TaskCommentColumnBinding | null;
  workflowBinding: TaskCommentColumnBinding | null;
  lane: TaskCommentLane;
}> {
  const toBinding = (column: WorkflowIrColumn | undefined): TaskCommentColumnBinding | null =>
    column?.agent ? { agentId: column.agent.agentId, mode: column.agent.mode } : null;
  try {
    const ir = await resolveWorkflowIrForTask(store as WorkflowIrResolverStore, task.id);
    const columns: readonly WorkflowIrColumn[] = ir?.version === "v2" ? ir.columns : [];
    if (!ir) return { columnBinding: null, workflowBinding: null, lane: "work" };
    const current = columns.find((candidate) => candidate.id === task.column);
    const planning = new Set(planningColumnIds(ir, columns));
    const planningColumn = [...planning]
      .map((id) => columns.find((candidate) => candidate.id === id))
      .find((column) => column?.agent);
    return {
      columnBinding: toBinding(current),
      workflowBinding: toBinding(planningColumn),
      lane: current ? (planning.has(current.id) ? "planning" : "work") : "work",
    };
  } catch {
    // An unreadable workflow must not lose a comment: fall back to the unbound work lane.
    return { columnBinding: null, workflowBinding: null, lane: "work" };
  }
}

/**
 * Deliver one comment using whatever durable stores this project has.
 *
 * Fail-soft by design: an unreadable workflow, a missing PostgreSQL layer, or a throwing agent list
 * degrades the outcome (`no-message-store`, `unrouted`, `send-failed`) rather than throwing, because
 * the comment row itself is already committed by the time this runs and the operator's write must not
 * turn into a 500 over a delivery side-effect.
 */
export async function deliverTaskCommentFromStore(
  input: DeliverTaskCommentFromStoreInput,
): Promise<TaskCommentDeliveryResult> {
  const { store, task } = input;
  const asyncLayer = store.getAsyncLayer?.() ?? null;

  let pool: Awaited<ReturnType<AgentStore["listAgents"]>> = [];
  try {
    const agentStore = new AgentStore({
      rootDir: store.getFusionDir?.() ?? store.getRootDir?.() ?? ".fusion",
      asyncLayer: asyncLayer ?? undefined,
    });
    await agentStore.init();
    pool = await agentStore.listAgents();
  } catch {
    pool = [];
  }

  const { columnBinding, workflowBinding, lane } = await resolveColumnContext(
    store as TaskCommentStoreHost & Partial<WorkflowIrResolverStore>,
    task,
  );

  const recipient = resolveTaskCommentRecipient({
    assignedAgentId: task.assignedAgentId ?? null,
    columnBinding,
    workflowBinding,
    taskOwnAgentSetting: Boolean(task.modelId),
    lane,
    pool,
  });

  const messageSink = asyncLayer ? new MessageStore(null, { asyncLayer }) : null;
  // Bound method rather than the store object: the host interface declares the capability optionally,
  // so only the extracted function carries the guarantee that it exists.
  const logSink = store.logEntryOnce ? { logEntryOnce: store.logEntryOnce.bind(store) } : null;
  const result = await deliverTaskComment({
    taskId: task.id,
    comment: input.comment,
    recipient,
    source: input.source,
    messageSink,
    auditHost: store,
    logSink,
  });

  // Attach the display name from the pool the resolver already used, so text-answering surfaces can
  // report "delivered to Workflow Planner" instead of an opaque agent id.
  const recipientLabel = result.recipientAgentId
    ? pool.find((agent) => agent.id === result.recipientAgentId)?.name
    : undefined;
  if (recipientLabel) result.recipientLabel = recipientLabel;

  if (result.recipientAgentId && input.onRouted) {
    try {
      await input.onRouted(result.recipientAgentId, result);
    } catch {
      // A failed wake cannot un-deliver the message; the inbox row is the guarantee.
    }
  }

  return result;
}
