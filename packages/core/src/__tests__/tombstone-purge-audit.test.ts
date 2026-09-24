/*
 * RUFU-283: the tombstone resurrection purge is audited and fails closed.
 *
 * RUFU-225's id could only be re-used by a purge path, and the pre-change purge deleted the
 * `task_workflow_selection` / `workflow_steps` children FIRST and then hard-deleted the parent with
 * no audit row at all — so a mid-way failure left a gutted tombstone that still reserved the id and
 * looked intentionally deleted, and a completed purge left no trace of what was removed. These tests
 * pin the two guarantees that make that unreachable: the audit row and the parent delete share one
 * transaction, and the child purge is best-effort AFTER the commit.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const readTaskRow = vi.hoisted(() => vi.fn());
const auditWithinTx = vi.hoisted(() => vi.fn());
const asyncAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const purgeChildren = vi.hoisted(() => vi.fn());

vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  readTaskRow,
}));
vi.mock("../postgres/data-layer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../postgres/data-layer.js")>()),
  recordRunAuditEventWithinTransaction: auditWithinTx,
}));
vi.mock("../task-store/workflow-definitions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/workflow-definitions.js")>()),
  purgeTaskWorkflowSelectionRowsAsyncImpl: purgeChildren,
}));
vi.mock("../task-store/async/async-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-audit.js")>()),
  recordRunAuditEvent: asyncAudit,
}));

import { maybeResolveTombstonedTaskIdImpl } from "../task-store/task-id-integrity.js";
import { TombstonePurgeUnauditedError } from "../task-store/errors.js";

const TOMBSTONED_ROW = {
  id: "RUFU-225",
  deletedAt: "2026-09-17T14:08:16.277Z",
  allowResurrection: false,
  workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }],
};

interface TxFixture {
  deletes: number;
}

function storeFixture(txState: TxFixture) {
  return {
    asyncLayer: {
      projectId: "proj",
      db: {},
      /** Mirrors the real shape: the callback's rejection propagates and the write is discarded. */
      transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          delete: vi.fn(() => ({
            where: vi.fn(async () => {
              txState.deletes += 1;
            }),
          })),
        };
        return fn(tx);
      }),
    },
  } as never;
}

beforeEach(() => {
  readTaskRow.mockReset();
  auditWithinTx.mockReset().mockResolvedValue(undefined);
  purgeChildren.mockReset().mockResolvedValue(undefined);
});

describe("tombstone purge audit + fail-closed ordering", () => {
  it("does nothing at all for a live row or an absent id", async () => {
    readTaskRow.mockResolvedValue(undefined);
    await expect(
      maybeResolveTombstonedTaskIdImpl(storeFixture({ deletes: 0 }), "RUFU-X", {}, "createTask"),
    ).resolves.toBeUndefined();
    expect(auditWithinTx).not.toHaveBeenCalled();
    expect(purgeChildren).not.toHaveBeenCalled();
  });

  it("emits the mandatory audit row and refuses the purge when that write fails", async () => {
    readTaskRow.mockResolvedValue({ ...TOMBSTONED_ROW, allowResurrection: true });
    auditWithinTx.mockRejectedValue(new Error("audit insert rejected"));
    const txState = { deletes: 0 };

    await expect(
      maybeResolveTombstonedTaskIdImpl(storeFixture(txState), "RUFU-225", {}, "createTask"),
    ).rejects.toBeInstanceOf(TombstonePurgeUnauditedError);

    // The transaction rolled back before the delete, so the tombstone still reserves the id.
    expect(txState.deletes).toBe(0);
    // A refused purge must not have touched the children either: the old ordering gutted the row
    // first, which is what made a preserved tombstone look intentional.
    expect(purgeChildren).not.toHaveBeenCalled();
  });

  it("audits the purge with ids-and-flags metadata before deleting the row", async () => {
    readTaskRow.mockResolvedValue({ ...TOMBSTONED_ROW, allowResurrection: true });
    const order: string[] = [];
    auditWithinTx.mockImplementation(async () => { order.push("audit"); });
    const txState = { deletes: 0 };
    const store = {
      asyncLayer: {
        projectId: "proj",
        db: {},
        transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            delete: vi.fn(() => ({
              where: vi.fn(async () => { order.push("delete"); txState.deletes += 1; }),
            })),
          }),
        ),
      },
    } as never;

    await maybeResolveTombstonedTaskIdImpl(store, "RUFU-225", {}, "duplicateTask");

    expect(order).toEqual(["audit", "delete"]);
    // The transaction handle is the first argument; the event input is the second.
    expect(auditWithinTx.mock.calls[0][1]).toMatchObject({
      mutationType: "task:row-purged-for-resurrection",
      target: "task:RUFU-225",
      metadata: {
        taskId: "RUFU-225",
        operation: "duplicateTask",
        allowResurrection: true,
        forceResurrect: false,
        // Presence, not the value: the audit contract is ids/counts/flags, never timestamps of
        // user data when a boolean answers the question.
        deletedAtPresent: true,
        purgedWorkflowStepCount: 1,
      },
    });
  });

  it("purges children only after the audit-and-delete transaction commits", async () => {
    readTaskRow.mockResolvedValue({ ...TOMBSTONED_ROW, allowResurrection: null });
    const order: string[] = [];
    auditWithinTx.mockImplementation(async () => { order.push("audit"); });
    const store = {
      asyncLayer: {
        projectId: "proj",
        db: {},
        transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
          const result = await fn({ delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })) });
          order.push("commit");
          return result;
        }),
      },
    } as never;
    purgeChildren.mockImplementation(async () => { order.push("children"); });

    await maybeResolveTombstonedTaskIdImpl(store, "RUFU-225", { forceResurrect: true }, "refineTask");

    expect(order).toEqual(["audit", "commit", "children"]);
  });

  it("lets a completed purge stand when only the best-effort child cleanup fails", async () => {
    readTaskRow.mockResolvedValue({ ...TOMBSTONED_ROW, allowResurrection: true });
    purgeChildren.mockRejectedValue(new Error("child delete rejected"));

    // The parent row and its audit record are already durable; failing here would launder a
    // successful, audited purge into an error the caller cannot act on.
    await expect(
      maybeResolveTombstonedTaskIdImpl(storeFixture({ deletes: 0 }), "RUFU-225", { forceResurrect: true }, "createTask"),
    ).resolves.toBeUndefined();
    expect(purgeChildren).toHaveBeenCalledTimes(1);
  });

  it("still refuses an unwaived tombstone without purging anything", async () => {
    readTaskRow.mockResolvedValue(TOMBSTONED_ROW);
    const txState = { deletes: 0 };
    await expect(
      maybeResolveTombstonedTaskIdImpl(storeFixture(txState), "RUFU-225", {}, "createTask"),
    ).rejects.toThrow(/resurrect|resurrection|deleted/i);
    expect(auditWithinTx).not.toHaveBeenCalled();
    expect(purgeChildren).not.toHaveBeenCalled();
    expect(txState.deletes).toBe(0);
    // The refusal is still forensically recorded through the ordinary non-transactional sink.
    expect(asyncAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mutationType: "task:resurrection-blocked",
    }));
  });
});
