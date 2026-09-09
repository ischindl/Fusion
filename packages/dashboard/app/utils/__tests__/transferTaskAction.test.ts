import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/client/client";
import { transferTask as realTransferTask } from "../../api/tasks/tasks-lifecycle";
import { runTransferTaskAction, TARGET_UNRESOLVABLE_REASON } from "../transferTaskAction";
import type { TaskTransferResult } from "../../api/tasks/tasks-lifecycle";

const t = ((key: string, fallback: string, values?: Record<string, unknown>) => {
  return fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name] ?? ""));
}) as never;

function transferResult(overrides: Partial<TaskTransferResult> = {}): TaskTransferResult {
  return {
    targetTaskId: "KB-042",
    targetProjectId: "proj-b",
    targetProjectName: "Knowledge Base",
    targetColumn: "triage",
    deduped: false,
    copiedAttachmentCount: 1,
    skippedAttachmentCount: 0,
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "FN-001",
    projectId: "proj-a",
    t,
    addToast: vi.fn(),
    openTransferModal: vi.fn().mockResolvedValue({ targetProjectId: "proj-b", disposition: "keep-transferred" as const }),
    transferTask: vi.fn().mockResolvedValue(transferResult()),
    ...overrides,
  };
}

describe("runTransferTaskAction", () => {
  /*
  FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
  Cancel is the load-bearing path: a null modal resolution must perform ZERO transfer fetches, so a
  mis-clicked menu item is harmless until the operator presses Transfer inside the picker.
  */
  it("performs zero transfer fetches when the picker is cancelled", async () => {
    const input = setup({ openTransferModal: vi.fn().mockResolvedValue(null) });
    expect(await runTransferTaskAction(input as never)).toBeUndefined();
    expect(input.transferTask).not.toHaveBeenCalled();
    expect(input.addToast).not.toHaveBeenCalled();
  });

  it("forwards the picker selection and names the target project and minted id on success", async () => {
    const input = setup();
    const result = await runTransferTaskAction(input as never);

    expect(input.transferTask).toHaveBeenCalledWith(
      "FN-001",
      { targetProjectId: "proj-b", disposition: "keep-transferred" },
      "proj-a",
    );
    expect(result).toMatchObject({ targetTaskId: "KB-042" });
    expect(input.addToast).toHaveBeenCalledWith("Transferred FN-001 to Knowledge Base as KB-042", "success");
  });

  /*
  FNXC:CrossProjectHandoff 2026-09-09-12:37 (RUFU-203):
  The source project scope is the load-bearing third argument. The server resolves the SOURCE store
  as `request projectId ?? engine.getProjectId()` (the daemon's launch project), so dropping it makes
  a transfer from any other project's board read the id against the wrong store: 404 on a foreign id,
  or a copy + `transferredTo` stamp on a same-id card in the launch project. Asserted as an exact
  three-argument call so an unscoped helper can never go green again.
  */
  it("passes the source project scope to the client so the request is project-scoped", async () => {
    const input = setup();
    await runTransferTaskAction(input as never);

    const call = (input.transferTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[2]).toBe("proj-a");
  });

  it("drives the real client to a projectId-scoped transfer URL", async () => {
    // The helper against the REAL client (not a fake): proves the third argument becomes `?projectId=`.
    const fetchMock = vi.fn(async () => Response.json(transferResult()));
    vi.stubGlobal("fetch", fetchMock);
    const input = setup({ transferTask: realTransferTask });
    try {
      await runTransferTaskAction(input as never);
      const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
      expect(url.pathname).toBe("/api/tasks/FN-001/transfer");
      expect(url.searchParams.get("projectId")).toBe("proj-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still sends an unscoped request when the host has no registered project", async () => {
    // Hosts gate the menu item on projectId, so `undefined` only reaches here from a host without a
    // registered source project; the client must then omit the parameter rather than encode "undefined".
    const fetchMock = vi.fn(async () => Response.json(transferResult()));
    vi.stubGlobal("fetch", fetchMock);
    const input = setup({ transferTask: realTransferTask, projectId: undefined });
    try {
      await runTransferTaskAction(input as never);
      const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
      expect(url.searchParams.has("projectId")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says the card was ALREADY transferred on an idempotent replay, not that a second copy was made", async () => {
    const input = setup({ transferTask: vi.fn().mockResolvedValue(transferResult({ deduped: true })) });
    await runTransferTaskAction(input as never);

    const [message, type] = input.addToast.mock.calls[0] as [string, string];
    expect(type).toBe("info");
    expect(message).toContain("already transferred");
    expect(message).toContain("KB-042");
    expect(message).not.toContain("Transferred FN-001");
  });

  it("surfaces skipped attachments as a second warning toast instead of dropping them silently", async () => {
    const input = setup({
      transferTask: vi.fn().mockResolvedValue(transferResult({ skippedAttachmentCount: 2 })),
    });
    await runTransferTaskAction(input as never);

    expect(input.addToast).toHaveBeenCalledTimes(2);
    expect(input.addToast).toHaveBeenLastCalledWith(
      "2 attachment(s) could not be copied to the target project",
      "warning",
    );
  });

  /*
  The registry-missage guard: a target outside the local registry must show the NAMED reason the
  server pinned (409 details.reason "target-unresolvable"), never the raw server sentence — the
  same privilege-of-registry-boundary reasoning as the server test.
  */
  it("shows the named target-unresolvable reason instead of the raw server sentence", async () => {
    const input = setup({
      transferTask: vi
        .fn()
        .mockRejectedValue(new ApiRequestError("raw server diagnostic", 409, { reason: TARGET_UNRESOLVABLE_REASON })),
    });
    expect(await runTransferTaskAction(input as never)).toBeUndefined();

    const [message, type] = input.addToast.mock.calls[0] as [string, string];
    expect(type).toBe("error");
    expect(message).toContain("not available on this install");
    expect(message).not.toContain("raw server diagnostic");
  });

  it("shows the raw message for unrelated failures", async () => {
    const input = setup({ transferTask: vi.fn().mockRejectedValue(new Error("disk full")) });
    expect(await runTransferTaskAction(input as never)).toBeUndefined();
    expect(input.addToast).toHaveBeenCalledWith("disk full", "error");
  });
});
