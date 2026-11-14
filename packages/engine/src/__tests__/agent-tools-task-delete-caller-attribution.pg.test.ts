/*
FNXC:TaskDeleteAttribution 2026-11-14-01:42 (RUFU-236):
Symptom pin for the chat-lane `fn_task_delete` defect against a REAL PostgreSQL store, because the
failure was a store guard, not a rendering problem: the chat tool stamped the target id into
`auditContext.taskId`, which is the CALLER field and the self-delete guard input, so every chat
delete — of any task — came back as `Task <ID> cannot delete itself` (observed live twice while
closing duplicate card RUFU-235). Only a real `TaskStore` can prove that sentence is gone: the shape
sibling (`agent-tools-task-delete-caller-attribution.test.ts`) asserts the emitted object, and a fake
store cannot refuse a delete.

The attribution half matters as much as the success half. A delete that reaches metadata with an
absent `callerKind` persists as `api-unattributed`, which tells the operator "nothing claimed
responsibility" instead of the truth (an AI agent used the tool), so the persisted `task:deleted` row
is asserted, not assumed. That row is written INSIDE the soft-delete transaction
(`recordRunAuditEventBackend` in `archive-lifecycle-2.ts`), so it is durable when `deleteTask`
resolves and no sink flush is needed before reading it.

A genuine self-delete still refusing is pinned where the guard lives
(`packages/core/src/__tests__/postgres/store-self-delete-guard.pg.test.ts`) and is deliberately not
re-implemented here.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  buildTaskDeleteNoticeContent,
  shouldNotifyOperatorOfDelete,
  type TaskDeleteCallerKind,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createTaskDeleteTool } from "../agent-tools.js";

const pgTest = pgDescribe;

pgTest("chat-lane fn_task_delete caller attribution (RUFU-236)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_chat_delete_attr",
    projectId: "chat-delete-attribution",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("deletes an unrelated task from the chat lane instead of refusing it as a self-delete", async () => {
    const store = h.store();
    const target = await store.createTask({
      title: "Duplicate card",
      description: "Close the duplicate from the chat conversation",
      column: "todo",
    });

    const result = await createTaskDeleteTool(store).execute("chat-run-1", { id: target.id });
    const text = (result.content[0] as { text: string }).text;

    // Pre-fix this is `ERROR: task deletion did not reach the task store: Task <id> cannot delete itself`.
    expect(text).not.toContain("cannot delete itself");
    expect(result.isError).toBeFalsy();
    expect(text).toBe(`Deleted ${target.id}`);

    // Gone from live readers: a soft-deleted card is no longer readable as a board row.
    await expect(store.getTask(target.id)).rejects.toThrow();
  });

  it("persists the chat delete as an agent-tool delete with no calling task recorded", async () => {
    const store = h.store();
    const target = await store.createTask({
      title: "Stale triage card",
      description: "Removed by the chat assistant after triage",
      column: "todo",
    });

    const result = await createTaskDeleteTool(store).execute("chat-run-2", { id: target.id });
    expect(result.isError).toBeFalsy();

    const rows = await store.getRunAuditEventsAsync({ taskId: target.id, mutationType: "task:deleted" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe("chat");
    expect(rows[0]!.runId).toMatch(/^chat-delete-.+-\d+$/);
    /*
    Honest attribution is what the operator reads in the mailbox: `agent-tool` with a null caller id
    renders "An AI agent deleted it with the `fn_task_delete` tool. The calling task was not
    recorded." An absent callerKind would instead persist `api-unattributed`.
    */
    expect(rows[0]!.metadata).toMatchObject({ callerKind: "agent-tool", callerTaskId: null });

    /*
    The persisted values, not a hand-written fixture, decide what the operator reads: feed the audit
    row's own fields through the real notice composer. Before RUFU-236 this branch was unreachable for
    the chat lane because the delete never committed.
    */
    const meta = rows[0]!.metadata as { callerKind: TaskDeleteCallerKind; callerTaskId: string | null };
    expect(shouldNotifyOperatorOfDelete(meta.callerKind)).toBe(true);
    expect(
      buildTaskDeleteNoticeContent(
        { id: target.id, title: target.title, previousColumn: "todo" },
        meta.callerKind,
        meta.callerTaskId,
      ),
    ).toContain(
      "An AI agent deleted it with the `fn_task_delete` tool. The calling task was not recorded.",
    );
  });

  it("still surfaces a live-dependency refusal through the tool result", async () => {
    const store = h.store();
    const parent = await store.createTask({ title: "Parent", description: "has a dependent", column: "todo" });
    await store.createTask({
      title: "Dependent",
      description: "references the parent",
      column: "todo",
      dependencies: [parent.id],
    });

    const result = await createTaskDeleteTool(store).execute("chat-run-3", { id: parent.id });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("still referenced as a dependency");
    // The refusal left the card live and wrote no delete audit.
    await expect(store.getTask(parent.id)).resolves.toBeTruthy();
    expect(await store.getRunAuditEventsAsync({ taskId: parent.id, mutationType: "task:deleted" })).toHaveLength(0);
  });
});
