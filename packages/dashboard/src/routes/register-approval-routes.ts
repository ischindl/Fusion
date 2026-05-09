import { AgentStore, ApprovalRequestStore, type ApprovalRequestActorSnapshot, type ApprovalRequestStatus } from "@fusion/core";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import { emitApprovalSseEvent } from "../sse.js";

const DEFAULT_ACTOR: ApprovalRequestActorSnapshot = {
  actorId: "user",
  actorType: "user",
  actorName: "User",
};

interface ApprovalRequestSummaryDto {
  id: string;
  status: ApprovalRequestStatus;
  actionCategory: string;
  actionSummary: string;
  agentId: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

interface ApprovalRequestDetailDto extends ApprovalRequestSummaryDto {
  requester: ApprovalRequestActorSnapshot;
  runId?: string;
  requestedAt: string;
  completedAt?: string;
  targetAction: {
    category: string;
    action: string;
    summary: string;
    resourceType: string;
    resourceId: string;
    context?: Record<string, unknown>;
  };
  history: Array<{
    id: string;
    eventType: string;
    actor: ApprovalRequestActorSnapshot;
    note?: string;
    createdAt: string;
  }>;
}

function parseOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a non-negative integer`);
  return n;
}

function parseStatus(value: unknown): ApprovalRequestStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "pending" || value === "approved" || value === "denied" || value === "completed") return value;
  throw badRequest("status must be one of: pending, approved, denied, completed");
}

function getDeciderActorId(
  history: Array<{ eventType: string; actor: ApprovalRequestActorSnapshot }>,
): string | undefined {
  const decisionEvent = [...history].reverse().find((entry) => entry.eventType === "approved" || entry.eventType === "denied");
  return decisionEvent?.actor.actorId;
}

function toSummaryDto(
  request: import("@fusion/core").ApprovalRequest,
  history: Array<{ eventType: string; actor: ApprovalRequestActorSnapshot }>,
): ApprovalRequestSummaryDto {
  return {
    id: request.id,
    status: request.status,
    actionCategory: request.targetAction.category,
    actionSummary: request.targetAction.summary,
    agentId: request.requester.actorId,
    taskId: request.taskId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    decidedAt: request.decidedAt,
    decidedBy: getDeciderActorId(history),
  };
}

function toDetailDto(
  request: import("@fusion/core").ApprovalRequest,
  history: import("@fusion/core").ApprovalRequestAuditEvent[],
): ApprovalRequestDetailDto {
  return {
    ...toSummaryDto(request, history),
    requester: request.requester,
    runId: request.runId,
    requestedAt: request.requestedAt,
    completedAt: request.completedAt,
    targetAction: request.targetAction,
    history,
  };
}

async function resumeAfterDecision(params: {
  scopedStore: import("@fusion/core").TaskStore;
  request: import("@fusion/core").ApprovalRequest;
  runtimeLogger: ApiRoutesContext["runtimeLogger"];
}): Promise<void> {
  const { scopedStore, request, runtimeLogger } = params;

  try {
    if (request.taskId) {
      const task = await scopedStore.getTask(request.taskId);
      if (task?.paused && task.pausedByAgentId === request.requester.actorId) {
        await scopedStore.pauseTask(request.taskId, false, undefined);
      }
    }
  } catch (error) {
    runtimeLogger.warn("Failed to unpause task after approval decision", {
      requestId: request.id,
      taskId: request.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
    await agentStore.init();
    const agent = await agentStore.getAgent(request.requester.actorId);
    if (agent?.state === "paused" && agent.pauseReason === "awaiting-approval") {
      await agentStore.updateAgentState(agent.id, "idle");
      await agentStore.updateAgent(agent.id, { pauseReason: undefined });
    }
  } catch (error) {
    runtimeLogger.warn("Failed to unpause agent after approval decision", {
      requestId: request.id,
      agentId: request.requester.actorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerApprovalRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError, runtimeLogger } = ctx;

  router.get("/approvals", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const approvalStore = new ApprovalRequestStore(scopedStore.getDatabase());
      const status = parseStatus(req.query.status);
      const limit = parseOptionalInt(req.query.limit, "limit") ?? 50;
      const offset = parseOptionalInt(req.query.offset, "offset") ?? 0;

      const requests = approvalStore.list({ status, limit, offset });
      const summaries = requests.map((request) => {
        const history = approvalStore.getAuditHistory(request.id);
        return toSummaryDto(request, history);
      });
      const total = approvalStore.list({ status, limit: Number.MAX_SAFE_INTEGER, offset: 0 }).length;
      const pendingCount = approvalStore.list({ status: "pending", limit: Number.MAX_SAFE_INTEGER, offset: 0 }).length;

      res.json({ requests: summaries, total, pendingCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/approvals/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const approvalStore = new ApprovalRequestStore(scopedStore.getDatabase());
      const requestId = String(req.params.id);
      const request = approvalStore.get(requestId);
      if (!request) throw notFound("Approval request not found");
      const history = approvalStore.getAuditHistory(requestId);
      res.json(toDetailDto(request, history));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/approvals/:id/decision", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { decision?: "approve" | "deny"; comment?: string; actor?: ApprovalRequestActorSnapshot };
      if (body.decision !== "approve" && body.decision !== "deny") {
        throw badRequest("decision must be one of: approve, deny");
      }
      if (body.comment !== undefined && typeof body.comment !== "string") {
        throw badRequest("comment must be a string");
      }

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const approvalStore = new ApprovalRequestStore(scopedStore.getDatabase());
      const requestId = String(req.params.id);
      const existing = approvalStore.get(requestId);
      if (!existing) throw notFound("Approval request not found");

      const actor = body.actor ?? DEFAULT_ACTOR;
      if (!actor || typeof actor.actorId !== "string" || typeof actor.actorType !== "string" || typeof actor.actorName !== "string") {
        throw badRequest("actor must include actorId, actorType, and actorName");
      }

      const targetStatus = body.decision === "approve" ? "approved" : "denied";
      let updated;
      try {
        updated = approvalStore.decide(requestId, targetStatus, { actor, note: body.comment });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Invalid approval request transition")) {
          throw conflict(message);
        }
        throw error;
      }

      await resumeAfterDecision({ scopedStore, request: updated, runtimeLogger });
      const history = approvalStore.getAuditHistory(requestId);
      const detail = toDetailDto(updated, history);
      emitApprovalSseEvent("approval:updated", detail, projectId);
      emitApprovalSseEvent("approval:decided", detail, projectId);
      res.json(detail);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
}
