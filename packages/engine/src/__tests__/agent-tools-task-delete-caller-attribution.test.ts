/*
FNXC:TaskDeleteAttribution 2026-11-14-01:42 (RUFU-236):
Shape pin for the chat-lane `fn_task_delete` audit context — the caller-TASK field is the store's
self-delete guard input (`auditContext.taskId === id` is refused in both `deleteTaskImpl` and its
PostgreSQL mirror), so it names the CALLER and never the target. The chat lane previously stamped
the target id there, which made the guard fire on every chat delete (no chat agent could delete any
task, observed live twice while closing duplicate card RUFU-235).

Two facts make the shape non-obvious and therefore worth pinning rather than eyeballing:
- A chat session carries no ambient task, so `taskId` must be ABSENT from the object. Passing
  `taskId: undefined` satisfies the guard but keeps an own key, which is why the assertion below is
  `hasOwnProperty` and not just a value check.
- `callerKind` must be sent explicitly. `buildDeleteCallerAuditFields` defaults an absent kind to
  `api-unattributed`, which would mislabel an AI-tool delete in the persisted `task:deleted` row and
  rewrite the operator's mailbox notice away from the `agent-tool` sentence.

The store-side guard itself is pinned where it lives
(`packages/core/src/__tests__/postgres/store-self-delete-guard.pg.test.ts`); this file owns only the
chat lane's emitted shape, and the `.pg` sibling owns the symptom against a real store.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFIED_TASK_DELETE_CALLER_KINDS,
  buildTaskDeleteNoticeContent,
  shouldNotifyOperatorOfDelete,
  type TaskDeleteCallerKind,
} from "@fusion/core";
import type { Task, TaskDeleteAuditContext, TaskStore } from "@fusion/core";
import { createTaskDeleteTool } from "../agent-tools.js";

/** Minimal live row; the tool reads only `id` off the delete result. */
function task(id: string): Task {
  const now = "2026-11-14T00:00:00.000Z";
  return {
    id,
    description: "Duplicate card closed from a chat conversation",
    dependencies: [],
    column: "todo",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface DeleteCall {
  id: string;
  allowResurrection?: boolean;
  removeLineageReferences?: boolean;
  auditContext?: TaskDeleteAuditContext;
}

/**
 * Fake store that records what the chat lane actually asked for. It deliberately does NOT run the
 * self-delete guard: that guard is the store's own invariant and is pinned against a real store in
 * the `.pg` sibling and in core, so re-implementing it here would only test the fake.
 */
function trackedStore(): { store: TaskStore; calls: DeleteCall[] } {
  const calls: DeleteCall[] = [];
  const store = {
    deleteTask: vi.fn(async (id: string, options?: Omit<DeleteCall, "id">) => {
      calls.push({ id, ...options });
      return task(id);
    }),
  } as unknown as TaskStore;
  return { store, calls };
}

describe("createTaskDeleteTool caller attribution (chat lane)", () => {
  let tracked: { store: TaskStore; calls: DeleteCall[] };

  beforeEach(() => {
    tracked = trackedStore();
  });

  it("omits the caller task id so the self-delete guard cannot read the target as its own caller", async () => {
    const result = await createTaskDeleteTool(tracked.store).execute("call-1", { id: "FN-target" });

    expect(tracked.calls).toHaveLength(1);
    const auditContext = tracked.calls[0]!.auditContext;
    expect(auditContext).toBeDefined();
    // Preserved chat-lane identity: the tool surface and the per-call run id stay as they were.
    expect(auditContext!.agentId).toBe("chat");
    expect(auditContext!.runId).toMatch(/^chat-delete-FN-target-\d+$/);
    // The fix: the CALLER field is absent, not the target id and not an explicit undefined.
    expect(auditContext!.callerKind).toBe("agent-tool");
    expect(Object.prototype.hasOwnProperty.call(auditContext!, "taskId")).toBe(false);
    // The success text is what the chat agent reports back to the operator.
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("Deleted FN-target");
  });

  it("still forwards the tombstone and lineage params it exposes", async () => {
    await createTaskDeleteTool(tracked.store).execute("call-2", {
      id: "FN-flags",
      allowResurrection: true,
      removeLineageReferences: true,
    });
    await createTaskDeleteTool(tracked.store).execute("call-3", { id: "FN-defaults" });

    expect(tracked.calls[0]).toMatchObject({ id: "FN-flags", allowResurrection: true, removeLineageReferences: true });
    expect(tracked.calls[1]).toMatchObject({ id: "FN-defaults", allowResurrection: false, removeLineageReferences: false });
  });

  /*
  FNXC:TaskDeleteNotice 2026-11-14-01:42 (RUFU-236):
  The chat lane previously never reached this copy — every delete died at the guard first — so the
  operator-facing consequence of an honest `agent-tool` attribution had no coverage anywhere. It is
  asserted here from the declared constant and the real composer rather than from a literal the test
  invents, and `agent-tool` staying in the notified set is the point: chat deletes are now loud, and
  "restoring silence" by editing that set would be the wrong fix.
  */
  it("produces the operator mailbox notice that an agent-tool delete with no caller is supposed to make", () => {
    const callerKind: TaskDeleteCallerKind = "agent-tool";

    expect(NOTIFIED_TASK_DELETE_CALLER_KINDS).toContain(callerKind);
    expect(shouldNotifyOperatorOfDelete(callerKind)).toBe(true);

    const notice = buildTaskDeleteNoticeContent(
      { id: "FN-target", title: "Duplicate card", previousColumn: "todo" },
      callerKind,
      null,
    );
    expect(notice).toContain(
      "An AI agent deleted it with the `fn_task_delete` tool. The calling task was not recorded.",
    );
    expect(notice).toContain("Caller class: `agent-tool`");
    expect(notice).not.toContain("api-unattributed");
  });

  it("reports a store refusal as an error result instead of claiming the delete happened", async () => {
    // A refusal the chat agent must see verbatim: a card with live dependents is refused by the
    // store, and the tool surfaces it through its shared failure shape rather than `Deleted …`.
    const refusing = {
      deleteTask: vi.fn(async () => {
        throw new Error("Cannot delete task FN-parent: still referenced as a dependency by FN-child.");
      }),
    } as unknown as TaskStore;

    const result = await createTaskDeleteTool(refusing).execute("call-4", { id: "FN-parent" });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("still referenced as a dependency");
  });
});
