/**
 * Async Drizzle allocator reconciliation helpers (U12).
 *
 * FNXC:TaskStoreAllocator 2026-06-24-14:00:
 * Async equivalent of the sync `reconcileTaskIdState()` in
 * distributed-task-id.ts. The allocator reconciliation runs on store open and
 * bumps each prefix sequence to the high-water mark so new task IDs never
 * collide with existing, soft-deleted, or archived IDs.
 *
 * Behavioral invariants preserved (see docs/storage.md):
 *   VAL-DATA-007 — On store open, each prefix sequence is bumped to
 *     max(current, max(task suffix)+1, max(archived suffix)+1, max(reservation)+1).
 *   VAL-DATA-008 — Soft-deleted/archived IDs stay reserved (never reassigned).
 *     The reconciliation intentionally scans soft-deleted task rows (no
 *     deleted_at filter) so a soft-deleted ID continues to hold its sequence
 *     floor (FN-5105).
 *
 * PostgreSQL mapping notes:
 *   - The `distributed_task_id_state` table uses `prefix` as its primary key
 *     and `next_sequence` as the per-prefix counter.
 *   - The reconciliation scans `project.tasks` (including soft-deleted rows)
 *     and `project.archived_tasks` for the max suffix per prefix.
 *   - The config-table legacy `nextId` is honored only for the configured
 *     prefix (deprecated; preserved for one release then dropped).
 *
 * Transition context:
 *   The sync `reconcileTaskIdState(db)` remains the live path until U15 flips
 *   the connection. This async helper is the PostgreSQL target the integration
 *   tests exercise; U13/U14 wire it into the store-open sequence.
 */
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import { projectOwnershipPartition } from "../../postgres/data-layer.js";
import type {
  DistributedTaskIdAbortInput,
  DistributedTaskIdCommitInput,
  DistributedTaskIdReserveInput,
  DistributedTaskIdStateInput,
} from "../../types.js";
import type { DistributedTaskIdAllocator } from "../../tasks/distributed-task-id.js";

const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/u;
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
/**
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
 * Upper bound on how many consecutive taken ids one reservation may skip. Real gaps are a handful (a
 * sibling project's minted run), so reaching the bound means the registry is pathological rather than
 * busy, and the honest outcome is a named failure instead of an unbounded scan.
 */
const MAX_CLAIM_SKIP_ATTEMPTS = 500;

/** Parse a task id (e.g. "KB-012") into prefix + numeric sequence. */
export function parseTaskIdForAllocator(
  taskId: string,
): { prefix: string; sequence: number } | null {
  const match = taskId.trim().toUpperCase().match(TASK_ID_PATTERN);
  if (!match) {
    return null;
  }
  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isFinite(sequence)) {
    return null;
  }
  return { prefix: match[1], sequence };
}

interface ConfiguredPrefixRow {
  prefix: string;
  legacyNextId: number | null;
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:05:
 * Read the configured task prefix and the legacy `config.next_id` floor from
 * the config row. The legacy `nextId` is deprecated but honored for the
 * configured prefix so an upgraded project keeps its sequence continuity.
 *
 * PostgreSQL note: the `settings` column is jsonb, so Drizzle returns it
 * already-parsed as a JS object (VAL-SCHEMA-004). No JSON.parse needed.
 */
export async function getConfiguredPrefixAndLegacyNextId(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId?: string,
): Promise<ConfiguredPrefixRow> {
  try {
    const rows = await db
      .select({ nextId: schema.project.config.nextId, settings: schema.project.config.settings })
      .from(schema.project.config)
      // FNXC:MultiProjectIsolation 2026-07-11: the config row is now keyed
      // per-project. Scope by project_id when bound to a project, else fall back
      // to the legacy singleton id = 1 row (single-project / SQLite parity).
      .where(projectId ? eq(schema.project.config.projectId, projectId) : eq(schema.project.config.id, 1));
    const row = rows[0];
    if (!row) {
      return { prefix: "KB", legacyNextId: null };
    }
    const settings = (row.settings ?? {}) as { taskPrefix?: string };
    return {
      prefix: (settings.taskPrefix ?? "KB").trim().toUpperCase(),
      legacyNextId: typeof row.nextId === "number" ? row.nextId : null,
    };
  } catch {
    return { prefix: "KB", legacyNextId: null };
  }
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:10:
 * Scan a task-id-bearing table (`tasks` or `archived_tasks`) for the max
 * numeric suffix under a given prefix. This intentionally does NOT filter
 * `deleted_at` so soft-deleted and archived IDs keep their sequence floor
 * reserved (VAL-DATA-008, FN-5105).
 *
 * The table is scanned in application code (not SQL) because the prefix/sequence
 * are embedded in the string id column, not a separate numeric column. This
 * mirrors the sync `getMaxTaskSequenceFromTable()` exactly.
 *
 * FNXC:CentralProjectIdentity 2026-07-13-22:40 (CORRECTED 2026-11-08-09:19 by RUFU-320):
 * The claim this comment used to make is FALSE and was the reasoning that hid the defect: there is no
 * global `project.tasks.id` primary key. The key is the composite `(project_id, id)`
 * (`postgres/schema/project.ts`), so one id string is legal in two projects, and the runtime session
 * runs under forced RLS, so this scan can only ever observe the calling project's rows. DB-wide
 * high-water therefore cannot come from this function; it comes from `getMaxClaimSequence()` over the
 * unpartitioned `central.global_task_id_claim` registry.
 * Keep the scan free of a `project_id` predicate anyway: that absence is what keeps a single project's
 * own soft-deleted and archived ids reserved (VAL-DATA-008, FN-5105). RLS, not a predicate, is what
 * bounds it to one partition.
 */
async function getMaxTaskSequenceFromTable(
  db: AsyncDataLayer["db"] | DbTransaction,
  table: "tasks" | "archived_tasks",
  prefix: string,
): Promise<number> {
  try {
    let rows: { id: string }[];
    if (table === "tasks") {
      rows = await db
        .select({ id: schema.project.tasks.id })
        .from(schema.project.tasks)
        .where(sql`${schema.project.tasks.id} LIKE ${`${prefix}-%`}`);
    } else {
      rows = await db
        .select({ id: schema.project.archivedTasks.id })
        .from(schema.project.archivedTasks)
        .where(sql`${schema.project.archivedTasks.id} LIKE ${`${prefix}-%`}`);
    }
    let maxSequence = 0;
    for (const row of rows) {
      const parsed = parseTaskIdForAllocator(row.id);
      if (parsed?.prefix === prefix && parsed.sequence > maxSequence) {
        maxSequence = parsed.sequence;
      }
    }
    return maxSequence;
  } catch {
    return 0;
  }
}

/**
 * Max reservation sequence for a prefix from `distributed_task_id_reservations`.
 */
async function getMaxReservationSequence(
  db: AsyncDataLayer["db"] | DbTransaction,
  prefix: string,
): Promise<number> {
  try {
    const rows = await db
      .select({ maxSeq: sql<number>`MAX(${schema.project.distributedTaskIdReservations.sequence})` })
      .from(schema.project.distributedTaskIdReservations)
      .where(eq(schema.project.distributedTaskIdReservations.prefix, prefix));
    const maxSeq = rows[0]?.maxSeq;
    return typeof maxSeq === "number" && Number.isFinite(maxSeq) ? maxSeq : 0;
  } catch {
    return 0;
  }
}

/**
 * Max sequence already CLAIMED for a prefix in `central.global_task_id_claim`.
 *
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
 * The only high-water source that sees every project, and it exists because the row scans cannot:
 * `project.tasks` is keyed `(project_id, id)` and forced RLS scopes a project session to its own
 * partition, so a sibling project that advanced `FN-` to 500 is invisible from there. The claim
 * registry is unpartitioned and keyed on the id string alone, so its maximum IS the DB-wide floor for
 * the prefix — which is what lets a lagging project skip forward instead of re-minting a number
 * another project already holds.
 */
async function getMaxClaimSequence(
  db: AsyncDataLayer["db"] | DbTransaction,
  prefix: string,
): Promise<number> {
  try {
    const rows = await db
      .select({ taskId: schema.central.globalTaskIdClaim.taskId })
      .from(schema.central.globalTaskIdClaim)
      .where(sql`${schema.central.globalTaskIdClaim.taskId} LIKE ${`${prefix}-%`}`);
    let maxSequence = 0;
    for (const row of rows) {
      const parsed = parseTaskIdForAllocator(row.taskId);
      if (parsed?.prefix === prefix && parsed.sequence > maxSequence) {
        maxSequence = parsed.sequence;
      }
    }
    return maxSequence;
  } catch {
    return 0;
  }
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:15:
 * Compute the next-sequence floor for a prefix:
 *   max(current, configured-legacy-nextId, max(task suffix)+1, max(archived suffix)+1, max(reservation)+1, max(claim)+1)
 *
 * This is the core of VAL-DATA-007. Every known prefix gets bumped to at least
 * one past the highest in-use suffix across tasks, archived tasks, and
 * reservations so a newly-allocated id never collides with an existing one.
 *
 * FNXC:ProjectTaskIdentity 2026-07-14-13:59:
 * The runtime session binds the ROW scans here to one project through forced RLS, so each project
 * keeps its own independent counter rather than drawing from one shared sequence.
 *
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
 * "Independent counter" bounds the counter, not the address. The claim term is read from the
 * unpartitioned registry and is deliberately NOT RLS-scoped, so a sibling project's claim at 500
 * pushes this project past 500 instead of letting it re-mint a taken string. That inverts what
 * `allocator-cross-project.test.ts` used to pin as a feature ("a sibling project's high suffix does
 * not advance this project's floor"): independent counters may not become duplicate addresses, since
 * a card that two projects can both be addressed by is unaddressable.
 */
export async function computeNextSequenceFloor(
  db: AsyncDataLayer["db"] | DbTransaction,
  prefix: string,
  projectId?: string,
): Promise<number> {
  const configured = await getConfiguredPrefixAndLegacyNextId(db, projectId);
  let nextSequence = 1;
  if (configured.prefix === prefix && configured.legacyNextId && configured.legacyNextId > nextSequence) {
    nextSequence = configured.legacyNextId;
  }
  const taskHighWaterMark = (await getMaxTaskSequenceFromTable(db, "tasks", prefix)) + 1;
  const archivedHighWaterMark = (await getMaxTaskSequenceFromTable(db, "archived_tasks", prefix)) + 1;
  const reservationHighWaterMark = (await getMaxReservationSequence(db, prefix)) + 1;
  const claimHighWaterMark = (await getMaxClaimSequence(db, prefix)) + 1;
  return Math.max(
    nextSequence,
    taskHighWaterMark,
    archivedHighWaterMark,
    reservationHighWaterMark,
    claimHighWaterMark,
  );
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:20:
 * Gather every known prefix: the configured prefix, every prefix present in
 * distributed_task_id_state, every prefix present in reservations, and every
 * prefix derivable from existing task/archived-task ids (including soft-deleted
 * rows so reserved prefixes stay reserved).
 */
export async function getKnownPrefixes(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId?: string,
): Promise<Set<string>> {
  const prefixes = new Set<string>();
  const configured = await getConfiguredPrefixAndLegacyNextId(db, projectId);
  if (configured.prefix) {
    prefixes.add(configured.prefix);
  }

  try {
    const stateRows = await db
      .select({ prefix: schema.project.distributedTaskIdState.prefix })
      .from(schema.project.distributedTaskIdState);
    for (const row of stateRows) {
      const prefix = row.prefix?.trim().toUpperCase();
      if (prefix) prefixes.add(prefix);
    }
  } catch {
    // best-effort
  }

  try {
    const reservationRows = await db
      .select({ prefix: schema.project.distributedTaskIdReservations.prefix })
      .from(schema.project.distributedTaskIdReservations);
    for (const row of reservationRows) {
      const prefix = row.prefix?.trim().toUpperCase();
      if (prefix) prefixes.add(prefix);
    }
  } catch {
    // best-effort
  }

  // FN-5105: intentionally scan without a deleted_at filter so soft-deleted
  // task ids keep their prefix reserved.
  try {
    const taskRows = await db.select({ id: schema.project.tasks.id }).from(schema.project.tasks);
    for (const row of taskRows) {
      const parsed = parseTaskIdForAllocator(row.id ?? "");
      if (parsed) prefixes.add(parsed.prefix);
    }
  } catch {
    // best-effort
  }

  try {
    const archivedRows = await db
      .select({ id: schema.project.archivedTasks.id })
      .from(schema.project.archivedTasks);
    for (const row of archivedRows) {
      const parsed = parseTaskIdForAllocator(row.id ?? "");
      if (parsed) prefixes.add(parsed.prefix);
    }
  } catch {
    // best-effort
  }

  return prefixes;
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:25:
 * Ensure a state row exists for a prefix with the computed sequence floor,
 * then bump it to max(current, floor). Idempotent: re-running against an
 * already-correct row is a no-op.
 */
async function ensureStateRow(
  tx: DbTransaction,
  prefix: string,
  floor: number,
  nowIso: string,
): Promise<void> {
  // INSERT ... ON CONFLICT DO NOTHING ensures the row exists.
  await tx
    .insert(schema.project.distributedTaskIdState)
    .values({
      prefix,
      nextSequence: floor,
      committedClusterTaskCount: 0,
      lastCommittedTaskId: null,
      updatedAt: nowIso,
    })
    .onConflictDoNothing();
  // Bump to max(current, floor).
  await tx
    .update(schema.project.distributedTaskIdState)
    .set({
      nextSequence: sql`GREATEST(${schema.project.distributedTaskIdState.nextSequence}, ${floor})`,
      updatedAt: nowIso,
    })
    .where(eq(schema.project.distributedTaskIdState.prefix, prefix));
}

/**
 * FNXC:TaskStoreAllocator 2026-06-24-14:30:
 * Reconcile every known prefix's sequence to the high-water mark, atomically.
 *
 * This is the async equivalent of `reconcileTaskIdState(db)`. It runs on store
 * open so a sequence that drifted below the max in-use suffix self-heals before
 * any new id is allocated (VAL-DATA-007). Soft-deleted/archived ids stay
 * reserved because the floor computation scans them (VAL-DATA-008).
 *
 * @param layer The async data layer.
 * @returns The list of prefixes whose sequence was bumped (changed).
 */
export async function reconcileTaskIdStateAsync(
  layer: AsyncDataLayer,
): Promise<string[]> {
  const nowIso = new Date().toISOString();
  return layer.transactionImmediate(async (tx) => {
    const reconciled: string[] = [];
    const prefixes = await getKnownPrefixes(tx, layer.projectId);
    for (const prefix of prefixes) {
      const floor = await computeNextSequenceFloor(tx, prefix, layer.projectId);

      // Read the current nextSequence so we can detect a change.
      const beforeRows = await tx
        .select({ nextSequence: schema.project.distributedTaskIdState.nextSequence })
        .from(schema.project.distributedTaskIdState)
        .where(eq(schema.project.distributedTaskIdState.prefix, prefix));
      const before = beforeRows[0]?.nextSequence;

      await ensureStateRow(tx, prefix, floor, nowIso);

      const afterRows = await tx
        .select({ nextSequence: schema.project.distributedTaskIdState.nextSequence })
        .from(schema.project.distributedTaskIdState)
        .where(eq(schema.project.distributedTaskIdState.prefix, prefix));
      const after = afterRows[0]?.nextSequence;

      if (before !== after) {
        reconciled.push(prefix);
      }
    }
    return reconciled;
  });
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:30:
 * Format a distributed task ID from prefix + sequence. Mirrors the sync
 * formatDistributedTaskId but lives here so the async allocator is self-contained.
 */
function formatDistributedTaskId(prefix: string, sequence: number): string {
  const normalizedPrefix = prefix.trim().toUpperCase();
  if (!normalizedPrefix) {
    throw new Error("prefix is required");
  }
  return `${normalizedPrefix}-${String(sequence).padStart(3, "0")}`;
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:35:
 * Check whether a task ID is already taken. Used by the async allocator reservation loop to skip past
 * existing IDs.
 *
 * FNXC:ProjectTaskIdentity 2026-07-14-13:59:
 * The exact-ID predicate is intentionally simple because forced RLS supplies the project predicate at
 * the database boundary — so against the ROW tables this sees only the allocator's own project-local
 * namespace.
 *
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
 * Project-local is no longer enough, which is why the unpartitioned claim registry is consulted here
 * too: a number another project already holds must be SKIPPED, not re-minted and refused at insert.
 * Skipping is what keeps the operator's rule honest — a creation never fails merely because a sibling
 * project reached the number first.
 */
async function taskIdTaken(
  tx: DbTransaction,
  prefix: string,
  sequence: number,
): Promise<boolean> {
  const taskId = formatDistributedTaskId(prefix, sequence);
  const liveRows = await tx
    .select({ one: sql<number>`1` })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId))
    .limit(1);
  if (liveRows.length > 0) return true;
  const archivedRows = await tx
    .select({ one: sql<number>`1` })
    .from(schema.project.archivedTasks)
    .where(eq(schema.project.archivedTasks.id, taskId))
    .limit(1);
  if (archivedRows.length > 0) return true;
  const claimRows = await tx
    .select({ one: sql<number>`1` })
    .from(schema.central.globalTaskIdClaim)
    .where(eq(schema.central.globalTaskIdClaim.taskId, taskId))
    .limit(1);
  return claimRows.length > 0;
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:40:
 * Expire stale reservations inside a transaction. Mirrors the sync
 * expireReservations but runs against the async data layer.
 *
 * FNXC:TaskIdGlobalUniqueness 2026-11-08-09:36 (RUFU-320):
 * Expiry also releases the pending DB-wide claim the reservation wrote, otherwise a crashed create
 * would burn its number forever. The delete is scoped to `project_id` on purpose: `project.*` rows are
 * RLS-partitioned, so another project's live reservation is INVISIBLE from here, and an unscoped
 * delete would conclude from that blindness that the reservation was gone and steal its claim. A stale
 * claim of another project is released by that project's own next allocator pass; until then it merely
 * makes a sibling skip a number, which costs nothing.
 */
async function expireReservations(
  tx: DbTransaction,
  nowIso: string,
  projectPartition: string,
): Promise<void> {
  const expired = await tx
    .update(schema.project.distributedTaskIdReservations)
    .set({ status: "expired", reason: "expired", abortedAt: nowIso })
    .where(
      sql`${schema.project.distributedTaskIdReservations.status} = 'reserved' AND ${schema.project.distributedTaskIdReservations.expiresAt} <= ${nowIso}`,
    )
    .returning({ taskId: schema.project.distributedTaskIdReservations.taskId });
  await releasePendingClaims(tx, projectPartition, expired.map((row) => row.taskId));
}

/*
FNXC:TaskIdGlobalUniqueness 2026-11-08-09:36 (RUFU-320):
Releases the PENDING half of a claim — the row a reservation wrote for a number it never got to use.
Never touches a claim whose reservation_id is already NULL (a committed/inserted claim is permanent
ownership) and never another project's row.
*/
async function releasePendingClaims(
  tx: DbTransaction,
  projectPartition: string,
  taskIds: Array<string | null>,
): Promise<void> {
  const ids = taskIds.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (ids.length === 0) return;
  await tx
    .delete(schema.central.globalTaskIdClaim)
    .where(
      sql`${schema.central.globalTaskIdClaim.projectId} = ${projectPartition}
        AND ${schema.central.globalTaskIdClaim.reservationId} IS NOT NULL
        AND ${schema.central.globalTaskIdClaim.taskId} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
    );
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:45:
 * Create an async DistributedTaskIdAllocator backed by the AsyncDataLayer.
 *
 * This is the async equivalent of `createDistributedTaskIdAllocator(db)`. It
 * implements the full DistributedTaskIdAllocator interface against PostgreSQL
 * via Drizzle. All operations (reserve, commit, abort, getState) run inside
 * transactions on the AsyncDataLayer so they are atomic. A JS-side op-lock
 * serializes concurrent reservations from the same process to avoid sequence
 * races (matching the sync allocator's in-process serialization).
 *
 * The reconciliation (bumping sequences to the high-water mark) is handled
 * separately by `reconcileTaskIdStateAsync` during store open. This allocator
 * assumes the sequences are already reconciled and just reserves the next
 * available sequence.
 *
 * @param layer The async data layer.
 * @returns A DistributedTaskIdAllocator backed by PostgreSQL.
 */
export function createAsyncDistributedTaskIdAllocator(
  layer: AsyncDataLayer,
): DistributedTaskIdAllocator {
  // In-process serialization to avoid sequence races within this process.
  let opLock: Promise<void> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = opLock;
    let resolveFn!: () => void;
    opLock = new Promise<void>((r) => {
      resolveFn = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolveFn();
    }
  };

  return {
    formatDistributedTaskId,
    reserveDistributedTaskId: async (input: DistributedTaskIdReserveInput) =>
      withLock(async () => {
        const ttlMs = input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
        const now = new Date();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

        return layer.transactionImmediate(async (tx) => {
          await expireReservations(tx, nowIso, projectOwnershipPartition(layer.projectId));
          const prefix = input.prefix.trim().toUpperCase();
          if (!prefix) {
            throw new Error("prefix is required");
          }

          /*
          FNXC:TaskIdGlobalUniqueness 2026-11-08-09:19 (RUFU-320):
          A transaction-scoped advisory lock over the NAMESPACE, not the project. Two projects sharing
          one prefix live in different RLS partitions, so no row lock can serialize them: without this,
          both read the same floor, both pick `FN-004`, and the loser's insert fails on its own claim
          write. Advisory locks are cluster-wide and need no grants, so one lock per prefix makes the
          "read floor, skip claimed numbers, reserve" sequence atomic DB-wide; it is released with the
          transaction, so a crashed reservation cannot strand the namespace.
          */
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fusion-task-id-namespace:${prefix}`})::bigint)`);

          // Ensure the state row exists with the correct floor.
          const floor = await computeNextSequenceFloor(tx, prefix, layer.projectId);
          await ensureStateRow(tx, prefix, floor, nowIso);

          // Read the current nextSequence.
          const stateRows = await tx
            .select({
              nextSequence: schema.project.distributedTaskIdState.nextSequence,
              committedClusterTaskCount: schema.project.distributedTaskIdState.committedClusterTaskCount,
            })
            .from(schema.project.distributedTaskIdState)
            .where(eq(schema.project.distributedTaskIdState.prefix, prefix));
          const state = stateRows[0];
          if (!state) {
            throw new Error(`distributed_task_id_state row missing for prefix ${prefix}`);
          }

          /*
          FNXC:TaskIdGlobalUniqueness 2026-11-08-10:06 (RUFU-320):
          The claim is taken HERE, in the reserving transaction, not only when the row is written. A
          sibling project cannot see this reservation at all — `distributed_task_id_reservations` is
          RLS-partitioned — so a claim row is the only thing that can tell a second project "that number
          is spoken for" while this card is still merely reserved; without it both projects read a floor
          of 1 and both hand out FN-001. The insert is the atomic gate (primary key on the id string),
          so even racing past the advisory lock above, a contender LOSES BY SKIPPING and never by
          double-issuing. `reservation_id` marks the claim pending: a create that never landed releases
          it, so an id is never burned by a card that was never created.
          */
          const reservationId = randomUUID();
          let sequence = state.nextSequence;
          let skipped = 0;
          let claimed = false;
          while (!claimed) {
            const candidate = formatDistributedTaskId(prefix, sequence);
            if (!(await taskIdTaken(tx, prefix, sequence))) {
              const inserted = await tx
                .insert(schema.central.globalTaskIdClaim)
                .values({
                  taskId: candidate,
                  projectId: projectOwnershipPartition(layer.projectId),
                  createdAt: nowIso,
                  reservationId,
                })
                .onConflictDoNothing({ target: schema.central.globalTaskIdClaim.taskId })
                .returning({ taskId: schema.central.globalTaskIdClaim.taskId });
              claimed = inserted.length > 0;
            }
            if (!claimed) {
              sequence += 1;
              skipped += 1;
              if (skipped >= MAX_CLAIM_SKIP_ATTEMPTS) {
                throw new Error(
                  `task-id allocator exhausted ${MAX_CLAIM_SKIP_ATTEMPTS} consecutive taken ids for prefix ${prefix} starting at ${formatDistributedTaskId(prefix, state.nextSequence)}`,
                );
              }
            }
          }

          const taskId = formatDistributedTaskId(prefix, sequence);

          await tx.insert(schema.project.distributedTaskIdReservations).values({
            reservationId,
            prefix,
            nodeId: input.nodeId,
            sequence,
            taskId,
            status: "reserved",
            reason: null,
            expiresAt,
            createdAt: nowIso,
            updatedAt: nowIso,
          });

          await tx
            .update(schema.project.distributedTaskIdState)
            .set({ nextSequence: sequence + 1, updatedAt: nowIso })
            .where(eq(schema.project.distributedTaskIdState.prefix, prefix));

          return {
            reservationId,
            taskId,
            sequence,
            expiresAt,
            committedClusterTaskCount: state.committedClusterTaskCount,
          };
        });
      }),

    commitDistributedTaskIdReservation: async (input: DistributedTaskIdCommitInput) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return layer.transactionImmediate(async (tx) => {
          await expireReservations(tx, nowIso, projectOwnershipPartition(layer.projectId));
          const rows = await tx
            .select()
            .from(schema.project.distributedTaskIdReservations)
            .where(eq(schema.project.distributedTaskIdReservations.reservationId, input.reservationId))
            .limit(1);
          const row = rows[0];
          if (!row) {
            throw new Error("reservation not found");
          }
          if (row.nodeId !== input.nodeId) {
            throw new Error("reservation belongs to a different node");
          }
          if (row.status === "expired") {
            throw new Error("reservation has expired");
          }
          if (row.status !== "reserved") {
            throw new Error("reservation already finalized");
          }

          await tx
            .update(schema.project.distributedTaskIdReservations)
            .set({ status: "committed", committedAt: nowIso, updatedAt: nowIso })
            .where(eq(schema.project.distributedTaskIdReservations.reservationId, row.reservationId));

          /*
          FNXC:TaskIdGlobalUniqueness 2026-11-08-10:05 (RUFU-320):
          Committing makes the pending claim permanent by clearing its pending marker. A claim the
          insert seam wrote instead (explicit id, or a create that inserted before committing) already
          has reservation_id NULL and is left exactly as it is.
          */
          await tx
            .update(schema.central.globalTaskIdClaim)
            .set({ reservationId: null })
            .where(
              sql`${schema.central.globalTaskIdClaim.taskId} = ${row.taskId} AND ${schema.central.globalTaskIdClaim.projectId} = ${projectOwnershipPartition(layer.projectId)}`,
            );

          // Ensure state row exists and bump committed count.
          const floor = await computeNextSequenceFloor(tx, row.prefix, layer.projectId);
          await ensureStateRow(tx, row.prefix, floor, nowIso);
          await tx
            .update(schema.project.distributedTaskIdState)
            .set({
              committedClusterTaskCount: sql`${schema.project.distributedTaskIdState.committedClusterTaskCount} + 1`,
              lastCommittedTaskId: row.taskId,
              updatedAt: nowIso,
            })
            .where(eq(schema.project.distributedTaskIdState.prefix, row.prefix));

          const stateRows = await tx
            .select({ committedClusterTaskCount: schema.project.distributedTaskIdState.committedClusterTaskCount })
            .from(schema.project.distributedTaskIdState)
            .where(eq(schema.project.distributedTaskIdState.prefix, row.prefix));
          const state = stateRows[0];

          return {
            reservationId: row.reservationId,
            taskId: row.taskId,
            sequence: row.sequence,
            committedClusterTaskCount: state?.committedClusterTaskCount ?? 0,
            committedAt: nowIso,
          };
        });
      }),

    abortDistributedTaskIdReservation: async (input: DistributedTaskIdAbortInput) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return layer.transactionImmediate(async (tx) => {
          await expireReservations(tx, nowIso, projectOwnershipPartition(layer.projectId));
          const rows = await tx
            .select()
            .from(schema.project.distributedTaskIdReservations)
            .where(eq(schema.project.distributedTaskIdReservations.reservationId, input.reservationId))
            .limit(1);
          const row = rows[0];
          if (!row) {
            throw new Error("reservation not found");
          }
          if (row.nodeId !== input.nodeId) {
            throw new Error("reservation belongs to a different node");
          }
          if (row.status === "committed") {
            throw new Error("reservation already finalized");
          }

          if (row.status === "reserved") {
            await tx
              .update(schema.project.distributedTaskIdReservations)
              .set({ status: "aborted", reason: input.reason, abortedAt: nowIso, updatedAt: nowIso })
              .where(eq(schema.project.distributedTaskIdReservations.reservationId, row.reservationId));
          }

          /*
          FNXC:TaskIdGlobalUniqueness 2026-11-08-10:05 (RUFU-320):
          An aborted reservation hands its number back — but only its OWN pending claim, and only while
          the id names no task row. A create that inserted the row and then failed to commit must keep
          its claim, or the registry would call the string free while a live card answers to it.
          */
          await tx
            .delete(schema.central.globalTaskIdClaim)
            .where(
              sql`${schema.central.globalTaskIdClaim.taskId} = ${row.taskId}
                AND ${schema.central.globalTaskIdClaim.projectId} = ${projectOwnershipPartition(layer.projectId)}
                AND ${schema.central.globalTaskIdClaim.reservationId} = ${row.reservationId}
                AND NOT EXISTS (SELECT 1 FROM ${schema.project.tasks} t WHERE t.id = ${row.taskId})`,
            );

          const floor = await computeNextSequenceFloor(tx, row.prefix, layer.projectId);
          await ensureStateRow(tx, row.prefix, floor, nowIso);
          const stateRows = await tx
            .select({ committedClusterTaskCount: schema.project.distributedTaskIdState.committedClusterTaskCount })
            .from(schema.project.distributedTaskIdState)
            .where(eq(schema.project.distributedTaskIdState.prefix, row.prefix));
          const state = stateRows[0];

          return {
            reservationId: row.reservationId,
            taskId: row.taskId,
            sequence: row.sequence,
            committedClusterTaskCount: state?.committedClusterTaskCount ?? 0,
            abortedAt: nowIso,
          };
        });
      }),

    getDistributedTaskIdState: async (input: DistributedTaskIdStateInput) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return layer.transactionImmediate(async (tx) => {
          await expireReservations(tx, nowIso, projectOwnershipPartition(layer.projectId));
          const prefix = input.prefix.trim().toUpperCase();
          if (!prefix) {
            throw new Error("prefix is required");
          }
          const floor = await computeNextSequenceFloor(tx, prefix, layer.projectId);
          await ensureStateRow(tx, prefix, floor, nowIso);

          const stateRows = await tx
            .select()
            .from(schema.project.distributedTaskIdState)
            .where(eq(schema.project.distributedTaskIdState.prefix, prefix))
            .limit(1);
          const stateRow = stateRows[0];
          if (!stateRow) {
            throw new Error(`distributed_task_id_state row missing for prefix ${prefix}`);
          }

          const activeRows = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.project.distributedTaskIdReservations)
            .where(
              sql`${schema.project.distributedTaskIdReservations.prefix} = ${prefix} AND ${schema.project.distributedTaskIdReservations.status} = 'reserved'`,
            );
          const burnedRows = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.project.distributedTaskIdReservations)
            .where(
              sql`${schema.project.distributedTaskIdReservations.prefix} = ${prefix} AND ${schema.project.distributedTaskIdReservations.status} IN ('aborted', 'expired')`,
            );

          return {
            nextSequence: stateRow.nextSequence,
            committedClusterTaskCount: stateRow.committedClusterTaskCount,
            activeReservationCount: activeRows[0]?.count ?? 0,
            burnedReservationCount: burnedRows[0]?.count ?? 0,
            lastCommittedTaskId: stateRow.lastCommittedTaskId ?? undefined,
          };
        });
      }),
  };
}
