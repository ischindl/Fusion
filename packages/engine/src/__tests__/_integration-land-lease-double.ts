/*
FNXC:MergeSingleFlight 2026-11-21-18:40 (RUFU-1148 Step 5):
Shared store double for the durable integration-landing claim. It reproduces the `@fusion/core` lease
semantics the claim depends on — one row per `leaseKey`, a monotonically increasing `fenceToken`, a TTL
that lets a successor take an expired `held` row as `reclaimed-expired`, and owner matching on
taskId + nodeId + incarnationId — so engine-side tests can assert WHICH outcome a caller sees and what
a claim may carry, without each suite re-inventing the row model.

Two consumers, deliberately: `integration-land-claim.test.ts` proves the seam's outcomes and its audit
shape; `merge-integration-land-real-git.test.ts` proves the same table gating a REAL git landing.
This is a faithful model, not the database: `merge-integration-land.pg.test.ts` proves the real seam
across two independent store handles.

FNXC:MergeSingleFlight 2026-11-21-17:55 (RUFU-1148): the double also enforces the table's own
`kind` CHECK constraint, and that is the whole reason it is worth more than a permissive fake. The
table admits only `acquire`, `land`, `merge-dispatch` (`workspace_coordination_leases_kind_check`,
migration 0060), and RUFU-1148's first implementation passed a fifth value that every unit and
real-git test accepted because the double took any `kind` while PostgreSQL refused the insert with
`23514`. A model that accepts what the database rejects manufactures exactly the false green that put
a broken claim on `main`; the constraint is mirrored here so the cheap lane refuses it first.
*/
import { vi } from "vitest";
import type { TaskStore, WorkspaceLeaseHandle } from "@fusion/core";

/** Mirrors `workspace_coordination_leases_kind_check` verbatim; a value outside it cannot be stored. */
export const LEASE_KIND_CHECK = ["acquire", "land", "merge-dispatch"] as const;

/** The refusal the real database raises, shaped the same way so a caller cannot mistake it for success. */
class LeaseKindCheckViolation extends Error {
  constructor(kind: string) {
    super(`new row violates check constraint "workspace_coordination_leases_kind_check" (kind: ${kind})`);
    this.name = "CheckViolation";
  }
}

function assertLeaseKind(kind: string): void {
  if (!(LEASE_KIND_CHECK as readonly string[]).includes(kind)) throw new LeaseKindCheckViolation(kind);
}

export type LeaseRow = {
  leaseKey: string;
  kind: string;
  ownerTaskId: string;
  ownerNodeId: string;
  ownerIncarnationId: string;
  fenceToken: bigint;
  status: "held" | "released";
  expiresAt: string;
};

export type EmittedAudit = {
  mutationType: string;
  target: string;
  metadata: Record<string, unknown>;
};

export type LeaseStoreDouble = {
  rows: Map<string, LeaseRow>;
  emits: EmittedAudit[];
  /** Replace the audit sink to prove a hostile sink cannot change the claim (absent/throwing/hanging). */
  setAuditSink: (sink: ((input: unknown) => unknown) | undefined) => void;
  /** Pre-plant a row owned by another card/task, e.g. a crashed holder still marked `held`. */
  plantHeldLease: (input: {
    leaseKey: string;
    kind: string;
    ownerTaskId: string;
    /** Negative means already expired — the crashed-holder shape. */
    expiresAt: string;
    fenceToken?: bigint;
  }) => void;
} & Partial<TaskStore>;

export function createLeaseStoreDouble(options: { now?: () => Date } = {}): LeaseStoreDouble {
  const rows = new Map<string, LeaseRow>();
  const now = options.now ?? (() => new Date());
  const emits: EmittedAudit[] = [];
  let sink: ((input: unknown) => unknown) | undefined = async () => undefined;

  const handleOf = (row: LeaseRow): WorkspaceLeaseHandle => ({
    leaseKey: row.leaseKey,
    owner: { taskId: row.ownerTaskId, nodeId: row.ownerNodeId, incarnationId: row.ownerIncarnationId },
    fenceToken: row.fenceToken,
    expiresAt: row.expiresAt,
  });

  const store = {
    rows,
    emits,
    setAuditSink: (next: ((input: unknown) => unknown) | undefined) => { sink = next; },
    plantHeldLease: (input: { leaseKey: string; kind: string; ownerTaskId: string; expiresAt: string; fenceToken?: bigint }) => {
      assertLeaseKind(input.kind);
      rows.set(input.leaseKey, {
        leaseKey: input.leaseKey,
        kind: input.kind,
        ownerTaskId: input.ownerTaskId,
        ownerNodeId: "node-other",
        ownerIncarnationId: "incarnation-other",
        fenceToken: input.fenceToken ?? 1n,
        status: "held",
        expiresAt: input.expiresAt,
      });
    },
    getAsyncLayer: () => ({ projectId: "proj_test" } as never),
    getProjectId: () => "proj_test",
    recordRunAuditEvent: (input: unknown) => {
      const event = input as EmittedAudit;
      emits.push(event);
      return sink?.(input);
    },
    acquireWorkspaceLease: vi.fn(async (input: {
      leaseKey: string;
      kind: string;
      owner: { taskId: string; nodeId: string; incarnationId: string };
      leaseMs: number;
    }) => {
      assertLeaseKind(input.kind);
      const existing = rows.get(input.leaseKey);
      const nowIso = now().toISOString();
      const expiresAt = new Date(now().getTime() + input.leaseMs).toISOString();
      const owned = existing
        && existing.ownerTaskId === input.owner.taskId
        && existing.ownerNodeId === input.owner.nodeId
        && existing.ownerIncarnationId === input.owner.incarnationId;
      if (existing?.status === "held" && existing.expiresAt > nowIso && !owned) {
        return {
          outcome: "conflict" as const,
          conflict: {
            leaseKey: existing.leaseKey,
            taskId: existing.ownerTaskId,
            nodeId: existing.ownerNodeId,
            incarnationId: existing.ownerIncarnationId,
            fenceToken: existing.fenceToken,
            expiresAt: existing.expiresAt,
          },
        };
      }
      if (existing?.status === "held" && existing.expiresAt > nowIso && owned) {
        existing.expiresAt = expiresAt;
        return { outcome: "reentrant" as const, handle: handleOf(existing) };
      }
      const row: LeaseRow = {
        leaseKey: input.leaseKey,
        kind: input.kind,
        ownerTaskId: input.owner.taskId,
        ownerNodeId: input.owner.nodeId,
        ownerIncarnationId: input.owner.incarnationId,
        // Every takeover raises the fence, so a superseded owner can never write again.
        fenceToken: (existing?.fenceToken ?? 0n) + 1n,
        status: "held",
        expiresAt,
      };
      rows.set(input.leaseKey, row);
      return { outcome: existing ? "reclaimed-expired" as const : "acquired" as const, handle: handleOf(row) };
    }),
    renewWorkspaceLease: vi.fn(async (current: WorkspaceLeaseHandle, leaseMs: number) => {
      const row = rows.get(current.leaseKey);
      if (!row || row.status !== "held" || row.fenceToken !== current.fenceToken) return undefined;
      row.expiresAt = new Date(now().getTime() + leaseMs).toISOString();
      return handleOf(row);
    }),
    releaseWorkspaceLease: vi.fn(async (current: WorkspaceLeaseHandle) => {
      const row = rows.get(current.leaseKey);
      if (!row || row.status !== "held" || row.fenceToken !== current.fenceToken) return false;
      row.status = "released";
      return true;
    }),
    validateWorkspaceLeaseFence: vi.fn(async (input: {
      leaseKey: string;
      owner: { taskId: string; nodeId: string; incarnationId: string };
      fenceToken: bigint;
    }) => {
      const row = rows.get(input.leaseKey);
      if (!row) return "missing" as const;
      if (row.fenceToken < input.fenceToken) return "unknown" as const;
      if (
        row.fenceToken !== input.fenceToken
        || row.ownerTaskId !== input.owner.taskId
        || row.ownerNodeId !== input.owner.nodeId
        || row.ownerIncarnationId !== input.owner.incarnationId
        || row.status !== "held"
        || row.expiresAt <= now().toISOString()
      ) return "superseded" as const;
      return "valid" as const;
    }),
    /*
    The fence-refusal path names the CURRENT holder through this read (so an operator is never sent to
    interrogate the card that was just refused). Modelled from the same rows, `held` only.
    */
    inspectWorkspaceLeases: vi.fn(async (filter: { leaseKeys?: string[] } = {}) => {
      const wanted = filter.leaseKeys ? new Set(filter.leaseKeys) : undefined;
      // The real `WorkspaceLease extends WorkspaceLeaseHandle`, so a caller reads the holder off
      // `row.owner.taskId`. A fake that flattened that to `row.taskId` would let the claim pass here
      // and read `undefined` against a real store.
      return [...rows.values()]
        .filter((row) => (!wanted || wanted.has(row.leaseKey)) && row.status === "held")
        .map((row) => ({
          leaseKey: row.leaseKey,
          owner: { taskId: row.ownerTaskId, nodeId: row.ownerNodeId, incarnationId: row.ownerIncarnationId },
          fenceToken: row.fenceToken,
          expiresAt: row.expiresAt,
          status: row.status,
        }));
    }),
  };
  return store as LeaseStoreDouble;
}
