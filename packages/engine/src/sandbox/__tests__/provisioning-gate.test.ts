import type { ApprovalRequest } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxProvisioningPendingError,
  requireSandboxProvisioningApproval,
} from "../provisioning-gate.js";

function makeApproval(id: string, status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id,
    status,
    requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
    targetAction: {
      category: "sandbox_provisioning",
      action: "provision",
      summary: "Provision sandbox backend",
      resourceType: "command",
      resourceId: "install-bubblewrap",
      context: { backendId: "bubblewrap", operation: "install-bubblewrap", params: {} },
    },
    taskId: "FN-4641",
    runId: "run-1",
    requestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("requireSandboxProvisioningApproval", () => {
  it("allows auto-approved backend", async () => {
    const createApprovalRequest = vi.fn();
    const result = await requireSandboxProvisioningApproval({
      backendId: "native",
      operation: "prepare",
      description: "Prepare native backend",
      context: {
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
        settings: undefined,
        createApprovalRequest,
      },
    });
    expect(result).toEqual({ outcome: "allow" });
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("creates pending request and pauses for approval in default mode", async () => {
    const createApprovalRequest = vi.fn(async () => makeApproval("apr-1", "pending"));
    const pauseForApproval = vi.fn(async () => undefined);

    await expect(
      requireSandboxProvisioningApproval({
        backendId: "bubblewrap",
        operation: "install",
        description: "Install bubblewrap",
        context: {
          taskId: "FN-4641",
          requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
          settings: undefined,
          createApprovalRequest,
          pauseForApproval,
        },
      }),
    ).rejects.toBeInstanceOf(SandboxProvisioningPendingError);

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(pauseForApproval).toHaveBeenCalledTimes(1);
  });

  it("returns execute-once-then-complete after approval exists", async () => {
    const result = await requireSandboxProvisioningApproval({
      backendId: "bubblewrap",
      operation: "install",
      description: "Install bubblewrap",
      context: {
        taskId: "FN-4641",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
        settings: undefined,
        createApprovalRequest: vi.fn(async () => null),
        findApprovalByDedupeKey: vi.fn(async () => ({ id: "apr-1", status: "approved" })),
      },
    });

    expect(result).toEqual({ outcome: "execute-once-then-complete", approvalRequestId: "apr-1" });
  });

  it("throws block when prior approval was denied", async () => {
    await expect(
      requireSandboxProvisioningApproval({
        backendId: "bubblewrap",
        operation: "install",
        description: "Install bubblewrap",
        context: {
          requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
          settings: undefined,
          createApprovalRequest: vi.fn(async () => null),
          findApprovalByDedupeKey: vi.fn(async () => ({ id: "apr-1", status: "denied" })),
        },
      }),
    ).rejects.toBeInstanceOf(SandboxProvisioningPendingError);
  });

  it("allows never mode without creating approval", async () => {
    const createApprovalRequest = vi.fn(async () => makeApproval("apr-1", "pending"));
    const result = await requireSandboxProvisioningApproval({
      backendId: "bubblewrap",
      operation: "install",
      description: "Install bubblewrap",
      context: {
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
        settings: { sandboxProvisioning: { approvalMode: "never" } },
        createApprovalRequest,
      },
    });
    expect(result).toEqual({ outcome: "allow" });
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("produces stable dedupe key for identical inputs", async () => {
    const createApprovalRequest = vi.fn(async () => makeApproval("apr-1", "pending"));

    const first = requireSandboxProvisioningApproval({
      backendId: "bubblewrap",
      operation: "install",
      description: "Install bubblewrap",
      context: {
        taskId: "FN-4641",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
        settings: undefined,
        createApprovalRequest,
      },
    }).catch((error) => error as SandboxProvisioningPendingError);

    const second = requireSandboxProvisioningApproval({
      backendId: "bubblewrap",
      operation: "install",
      description: "Install bubblewrap",
      context: {
        taskId: "FN-4641",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Executor" },
        settings: undefined,
        createApprovalRequest,
      },
    }).catch((error) => error as SandboxProvisioningPendingError);

    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError.dedupeKey).toBe(secondError.dedupeKey);
  });
});
