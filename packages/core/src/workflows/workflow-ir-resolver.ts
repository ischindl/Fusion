/**
 * Single source of truth for the workflow-IR resolution rule.
 *
 * The selection → builtin/custom → default-fallback rule was independently
 * reimplemented in engine/hold-release.ts, engine/merge-trait.ts,
 * engine/plugin-runner.ts (which bypassed the public API via getDatabase()),
 * and dashboard/board-workflows.ts, with behavioral divergence already creeping
 * in (GitHub #1402). This module consolidates the read-only resolution into one
 * pair of helpers built on the *public* store surface so every call site shares
 * one implementation.
 *
 * A missing/corrupt definition degrades to the built-in default workflow so
 * resolution never throws. The store-private, txn-hot `resolveTaskWorkflowIrSync`
 * stays separate by design.
 */

import { getBuiltinWorkflow, isBuiltinWorkflowId, resolveDefaultWorkflowIr } from "./builtin-workflows.js";
import { parseWorkflowIr, serializeWorkflowIr } from "./workflow-ir.js";
import { applyPromptOverridesToIr } from "./workflow-prompt-overrides.js";
import { registerHostRetentionSource } from "../retention-host-sources.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

/*
FNXC:WorkflowIrPin 2026-07-18-20:20:
KTD-3 — a task pins its resolved workflow IR when it ENTERS a node, and holds
that resolution until the node settles. The pin is a durable seam: the field
lives on the workflow run state (schema wiring lands in U9; this is the in-code
seam U1 adds now). Restart recovery compares the stored pin against the CURRENT
IR and takes the drift-park path on mismatch — the pin survives crashes.

`resolveWorkflowIrForTask` is otherwise live-per-call, so a mid-flight editor
edit that changes the graph under a running task is a determinism hole; the pin
plus `detectWorkflowDrift` closes it. If an edit deleted the pinned node or its
column, the task parks with `task:reconcile-workflow-drift` instead of traversing
a mutated graph.
*/

/** A durable per-node-entry IR pin. `irHash` is a content hash of the resolved
 *  IR at entry time; `columnId` is the pinned node's column at entry (so drift
 *  detection can flag a deleted column even when the node id survives). */
export interface WorkflowIrPin {
  nodeId: string;
  irHash: string;
  columnId?: string;
}

/** Stable, cheap content hash of a resolved IR (djb2 over the canonical
 *  serialization). Not cryptographic — only used to detect that the graph a
 *  running task pinned differs from the graph now resolved. */
export function hashWorkflowIr(ir: WorkflowIr): string {
  const serialized = serializeWorkflowIr(ir);
  let hash = 5381;
  for (let i = 0; i < serialized.length; i++) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(i)) | 0;
  }
  // Unsigned hex + length so two different-length graphs never collide trivially.
  return `${(hash >>> 0).toString(16)}:${serialized.length}`;
}

/** Compute the per-node-entry pin for a node against a resolved IR. */
export function computeWorkflowIrPin(ir: WorkflowIr, nodeId: string): WorkflowIrPin {
  const node = ir.nodes.find((n) => n.id === nodeId);
  return { nodeId, irHash: hashWorkflowIr(ir), columnId: node?.column };
}

/** The reason a pinned run is considered drifted, or null when the pin still
 *  resolves cleanly against the current IR. */
export type WorkflowDriftReason = "node-deleted" | "column-deleted";

/**
 * KTD-3 drift detection. A pin is drifted when, against the CURRENT resolved IR:
 *   - the pinned node id no longer exists (`node-deleted`), or
 *   - the pinned node's column no longer exists (`column-deleted`).
 * A matching `irHash` short-circuits to "no drift" (the graph is byte-identical).
 * Returns null when the pin is still safely resolvable.
 */
export function detectWorkflowDrift(ir: WorkflowIr, pin: WorkflowIrPin): WorkflowDriftReason | null {
  if (pin.irHash === hashWorkflowIr(ir)) return null;
  const node = ir.nodes.find((n) => n.id === pin.nodeId);
  if (!node) return "node-deleted";
  const columnId = node.column ?? pin.columnId;
  if (columnId !== undefined) {
    const columns = "columns" in ir ? ir.columns : undefined;
    if (columns && !columns.some((c) => c.id === columnId)) return "column-deleted";
  }
  return null;
}

function defaultCodingWorkflowIr(): WorkflowIr {
  /*
   * FNXC:WorkflowBuiltins 2026-06-29-02:18:
   * `builtin:coding` is the operator-facing default workflow id, not the legacy monolithic IR export. Resolve the catalog entry first so no-selection tasks follow the new stepwise default; keep the old IR only as a missing-catalog safety fallback.
   *
   * FNXC:WorkflowBuiltins 2026-07-19-10:28: delegated to the shared
   * resolveDefaultWorkflowIr() authority so the move-path resolvers and this
   * one cannot drift (that drift produced "preflight is stale" on no-selection moves).
   */
  return resolveDefaultWorkflowIr();
}

/** Minimal store surface the resolver needs (public APIs only). */
export type WorkflowSelection = { workflowId: string; stepIds: string[] };

/** A caller-owned cache that is valid only for one resolver pass. */
export type WorkflowSelectionCache = Map<string, WorkflowSelection | undefined>;

/*
FNXC:WorkflowBatchCacheEpoch 2026-10-11-19:16 (RUFU-584):
A pass cache used to be safe only because it was short-lived. These two classes make a LONG-lived,
batch-shared cache safe: each carries the store epoch it was filled under and discards every entry the
moment the store reports a workflow selection or definition write. Sharing across sweeps therefore
cannot serve a workflow that changed mid-batch, which is the property that lets self-healing collapse
14 per-sweep caches into one per-batch pair.
Over-clearing is free (the next read repopulates); serving a stale IR is not, so the check runs on read
AND on write, and any epoch movement clears the whole object rather than invalidating per task - a
selection write changes which workflow a card belongs to, which can affect other cards' aggregates too.
*/
export class EpochedWorkflowSelectionCache
  extends Map<string, WorkflowSelection | undefined>
  implements WorkflowSelectionCache {
  private epoch: number;
  constructor(private readonly currentEpoch: () => number, initialEpoch = currentEpoch()) {
    super();
    this.epoch = initialEpoch;
  }
  private syncEpoch(): void {
    const now = this.currentEpoch();
    if (now !== this.epoch) {
      this.clear();
      this.epoch = now;
    }
  }
  override get size(): number { this.syncEpoch(); return super.size; }
  override has(key: string): boolean { this.syncEpoch(); return super.has(key); }
  override get(key: string): WorkflowSelection | undefined { this.syncEpoch(); return super.get(key); }
  override set(key: string, value: WorkflowSelection | undefined): this { this.syncEpoch(); return super.set(key, value); }
  /* Iteration is a read too: a stale entry reached through forEach or size would be served as fresh,
     so those sync as well. `entries`/`keys`/`values` are deliberately not overridden - nothing reads
     these caches that way, and delegating to the inherited methods still routes through the synced
     `size`/`forEach` paths for anything that does. */
  override forEach(cb: (value: WorkflowSelection | undefined, key: string, map: Map<string, WorkflowSelection | undefined>) => void, thisArg?: unknown): void {
    this.syncEpoch();
    super.forEach(cb as (value: WorkflowSelection | undefined, key: string, map: Map<string, WorkflowSelection | undefined>) => void, thisArg);
  }
  /** Epoch this cache is currently valid under; tests assert invalidation without touching internals. */
  validUnderEpoch(): number { return this.epoch; }
}

/** Definition-epoch counterpart, keyed by the resolver's `workflowId\u0000projectId` cache key. */
export class EpochedWorkflowIrCache extends Map<string, WorkflowIr> {
  private epoch: number;
  constructor(private readonly currentEpoch: () => number, initialEpoch = currentEpoch()) {
    super();
    this.epoch = initialEpoch;
  }
  private syncEpoch(): void {
    const now = this.currentEpoch();
    if (now !== this.epoch) {
      this.clear();
      this.epoch = now;
    }
  }
  override get size(): number { this.syncEpoch(); return super.size; }
  override has(key: string): boolean { this.syncEpoch(); return super.has(key); }
  override get(key: string): WorkflowIr | undefined { this.syncEpoch(); return super.get(key); }
  override set(key: string, value: WorkflowIr): this { this.syncEpoch(); return super.set(key, value); }
  override forEach(cb: (value: WorkflowIr, key: string, map: Map<string, WorkflowIr>) => void, thisArg?: unknown): void {
    this.syncEpoch();
    super.forEach(cb, thisArg);
  }
  validUnderEpoch(): number { return this.epoch; }
}

/** Selection database work performed by one multi-row hydration pass. */
export type WorkflowSelectionReadTally = { batched: number; singles: number };

/** Definition reads actually issued by one caller-owned resolver pass. */
export type WorkflowDefinitionReadTally = { definitions: number };

/*
FNXC:WorkflowIrHoist 2026-11-08-05:57 (RUFU-871):
The workflow a card with no selection is governed by. THREE call sites spell it
(`resolveWorkflowIrForTaskWithProvenance`'s absent-selection branch, `prefetchWorkflowIrs`, and the
synchronous reader below), and they must agree exactly or the synchronous reader answers for a card
the async resolver would have governed differently. One const so there is one spelling.
*/
export const FALLBACK_WORKFLOW_ID = "builtin:coding";

/** The `irCache` key for one workflow id under a known project scope. `resolveWorkflowIrById` WRITES
 *  this key and `createCachedWorkflowIrReader` READS it; sharing the derivation is the only thing
 *  that keeps a cache hit from becoming a silent miss (a miss is merely slow, a wrong key shape that
 *  collides would serve one project's graph to another). */
function irCacheKey(workflowId: string, projectId: string | undefined): string {
  return projectId ? `${workflowId}\u0000${projectId}` : workflowId;
}

/**
 * Build a SYNCHRONOUS reader over an already-warm `irCache` for one caller-owned pass.
 *
 * The hot loops that resolve an IR per card (the hold/release sweep, board hydration) do not need a
 * round trip per card — the IR is a function of the card's SELECTED WORKFLOW, of which a board has a
 * handful. `prefetchWorkflowIrs` fills the cache once per distinct workflow; this reader then answers
 * the rest from memory, so the per-card leg stops crossing the event loop at all. Measured field
 * evidence for why that matters:
 *
 *     [scheduler] Hold-release sweep: project=proj_1849a8ac5d5842ac: 11733ms (prefetch 3430ms,
 *     ir-resolve 1464ms, evaluate 6839ms over 235 tasks)
 *
 * 1 464 ms / 235 = 6.2 ms per card of pure await, on the same Node process that serves the UI, paid
 * by every card including the ones that are not candidates for anything.
 *
 * It returns `undefined` — never a guess — in exactly the states where the cache cannot answer, and
 * the caller must then run the async resolver as it always did:
 * - the selection cache has no entry for the card. An absent ENTRY is not an absent SELECTION: the
 *   async resolver would go read the store, and answering `builtin:coding` here would merge that
 *   card into the default pool.
 * - the workflow's IR is not cached. A missing, malformed, or throwing definition is deliberately
 *   never written to `irCache` (see `resolveWorkflowIrById`), so this stays a miss and the async
 *   path keeps its documented degrade-to-default behaviour.
 *
 * The project scope is read ONCE here, not once per card, which is what removes the per-card
 * `getWorkflowSettingsProjectId` the sweep used to pay (25 calls for a 24-card board).
 */
export function createCachedWorkflowIrReader(
  store: WorkflowIrDefinitionStore,
  irCache: Map<string, WorkflowIr>,
  selectionCache: WorkflowSelectionCache,
): (taskId: string) => WorkflowIr | undefined {
  let projectId: string | undefined;
  try {
    projectId = store.getWorkflowSettingsProjectId?.();
  } catch {
    projectId = undefined;
  }
  return (taskId: string): WorkflowIr | undefined => {
    if (!selectionCache.has(taskId)) return undefined;
    const workflowId = selectionCache.get(taskId)?.workflowId ?? FALLBACK_WORKFLOW_ID;
    return irCache.get(irCacheKey(workflowId, projectId));
  };
}

/*
FNXC:WorkflowScheduling 2026-08-12-20:00 (RUFU-073):
In-flight selection-read coalescing, keyed by the CALLER-OWNED per-pass cache object. Several
`resolveTaskParkedColumns` wake closures can race on the same task in one scheduler event, and each
used to see the cache still-empty (the `.has` check runs before the first `await` resolves and the
`.set`) — so all of them hit the DB. This WeakMap lets concurrent calls that SHARE a cache coalesce
onto ONE in-flight read promise; the weak key binds it strictly to that pass, so it is NOT a global
/infinite cache and auto-releases when the pass cache is GC'd. A selection write in the next pass
uses a fresh cache (fresh WeakMap slot) and is always observed.
*/
const inflightSelectionReads = new WeakMap<WorkflowSelectionCache, Map<string, Promise<WorkflowSelection | undefined>>>();

/*
FNXC:WorkflowScheduling 2026-10-06-08:56 (RUFU-588):
The RUFU-073 coalescer above only helps callers that PASS a `selectionCache`. Measured from two live
heap snapshots of the production dashboard: ~4 000 async frames were suspended on the workflow-IR
selection read (`resolveWorkflowIrForTask` 2 003 + the provenance variant 2 014 + 1 963 queries still
in flight inside drizzle), because the resolver has ~150 call sites and most pass no cache at all.
The no-cache branch was deliberately live-per-call and cached nothing, so every concurrent caller
issued its own SELECT and parked a frame — and each parked frame retained the batch of materialized
tasks it had closed over, which is what grew the heap from 914 MB to 2.4 GB and OOM-killed the UI hourly.

This is a coalescer, NOT a cache. The in-flight entry is removed in `finally`, so it cannot outlive the
query it represents: a call arriving after an operator edits a workflow still reads fresh, which is the
property `resolveWorkflowIrForTask` is documented on and the reason the old branch refused to cache.
Keyed by the store, because a selection row is project-owned and each project scope owns its store; the
map dies with the store, so there is no global retention and no cross-project bleed.
*/
const inflightUncachedSelectionReads = new WeakMap<WorkflowIrResolverStore, Map<string, Promise<WorkflowSelection | undefined>>>();

/*
FNXC:WorkflowScheduling 2026-10-06-08:56 (RUFU-588):
Coalescing alone still admits one query per DISTINCT task in a pass, and the pool is sized in the tens
(RUFU-577), so the overflow just moves from JS frames into driver-queue frames that pin the same
closures. The bound caps concurrent uncached selection reads per store. It wraps ONLY the store read:
the selection implementation re-reads through its own advisory-fence path and never acquires this
semaphore, so the bound cannot deadlock by re-entrancy.
*/
export const SELECTION_READ_CONCURRENCY = 16;
type SelectionReadSlots = { free: number; waiters: Array<() => void> };
const selectionReadSlots = new WeakMap<WorkflowIrResolverStore, SelectionReadSlots>();

function acquireSelectionReadSlot(store: WorkflowIrResolverStore): Promise<void> {
  let queue = selectionReadSlots.get(store);
  if (!queue) {
    queue = { free: SELECTION_READ_CONCURRENCY, waiters: [] };
    selectionReadSlots.set(store, queue);
  }
  if (queue.free > 0) {
    queue.free -= 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue!.waiters.push(resolve));
}

function releaseSelectionReadSlot(store: WorkflowIrResolverStore): void {
  const queue = selectionReadSlots.get(store);
  if (!queue) return;
  const next = queue.waiters.shift();
  // A woken waiter inherits the released slot directly, so `free` is only restored when nobody waits.
  if (next) next();
  else queue.free += 1;
}

/*
FNXC:WorkflowSelectionMemo 2026-11-06-18:35 (RUFU-871):
The no-cache selection read was the hottest store read in the process by a wide margin. The read-attribution
seam counter recorded 86,307 `workflowSelection` reads in ONE 5-minute production window (288 per second)
on a board with zero in-progress cards, and 53 % of sampled stacks went through the resolver's own no-cache
branch. Around 50 call sites legitimately own no pass cache — `self-healing.ts` alone has ten
`resolveTaskLifecycleColumns(store, id)?.complete ?? "done"` sites inside recurring sweeps, plus the agent
heartbeat, merger, notification service and both GitHub/GitLab trackers — so the coalescer and the
concurrency bound cannot help them: those reads are distinct and sequential, and each one is a PostgreSQL
round-trip that pins its caller's closure while it waits.

The bound is a TTL, not an eviction policy, and that choice is the whole design. `EpochedWorkflowSelectionCache`
(RUFU-584) invalidates on a selection write made THROUGH this store, but `workflowSelectionEpoch()` is a
process-local instance counter (`store.ts` bumps a field), so a selection written by another process — an
`fn` CLI planning a card, a second engine — is invisible to it. That cross-process blind spot is exactly
why this module was documented as live-per-call. So the memo carries BOTH: an in-process write drops the
entry immediately (per-entry epoch compare), and a cross-process write is observed once the TTL lapses.
500 ms is a quarter of the 2-second `workflowContinuationTimer` tick and two orders of magnitude under the
45-second engine tick, so no loop an operator can observe can read a selection this memo served stale.
`FUSION_WORKFLOW_SELECTION_MEMO_MS=0` restores live-per-call exactly; a shorter value is available for any
caller that needs fresher truth than the default.
*/
function readSelectionMemoTtlMs(): number {
  const raw = process.env.FUSION_WORKFLOW_SELECTION_MEMO_MS;
  if (raw === undefined || raw.trim() === "") return 500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 500;
}

export const UNCACHED_SELECTION_MEMO_MAX = 4096;

let uncachedSelectionMemoTtlMs = readSelectionMemoTtlMs();

/** Test seam for the TTL; production never calls this. Passing 0 restores live-per-call reads. */
export function setSelectionMemoTtlMsForTests(ms: number): void {
  uncachedSelectionMemoTtlMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
}

/** Current TTL in force (0 = memo disabled, every uncached read goes to the store). */
export function selectionMemoTtlMs(): number {
  return uncachedSelectionMemoTtlMs;
}

interface SelectionMemoEntry {
  selection: WorkflowSelection | undefined;
  /** Store epoch the value was read under; a local selection write makes it a miss. */
  epoch: number;
  at: number;
}

/** Keyed weakly by store so a per-test fake store can never read another store's selections. */
const selectionMemo = new WeakMap<WorkflowIrResolverStore, Map<string, SelectionMemoEntry>>();

/** -1 means the store does not expose an epoch, so the entry is bounded by TTL alone. */
function selectionEpochOf(store: WorkflowIrResolverStore): number {
  const epoch = (store as { workflowSelectionEpoch?: () => number }).workflowSelectionEpoch?.();
  return typeof epoch === "number" ? epoch : -1;
}

function rememberSelection(store: WorkflowIrResolverStore, taskId: string, entry: SelectionMemoEntry): void {
  let memo = selectionMemo.get(store);
  if (!memo) {
    memo = new Map<string, SelectionMemoEntry>();
    selectionMemo.set(store, memo);
  }
  memo.set(taskId, entry);
  // Insertion order is the eviction order: a board-sized key space fits, and one that does not loses the
  // oldest entry rather than the whole memo.
  while (memo.size > UNCACHED_SELECTION_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/** Entries currently held — an operator-facing debug signal, never a decision input. */
export function selectionMemoSizeForStore(store: WorkflowIrResolverStore): number {
  return selectionMemo.get(store)?.size ?? 0;
}

/*
FNXC:WorkflowSelectionMemo 2026-11-06-20:05 (RUFU-871):
Hit/miss counters, published as census sources rather than log lines. Without them the memo is unfalsifiable
from outside: reads/second at the store seam stay high no matter what, because the cache-owning callers
(the scheduler sweep, board hydration) never ask the memo — and the first deploy of this memo proved
exactly that, 57,388 reads in the window after it landed versus 53,914 before. So `/metrics` now answers
"is the uncached branch even hot?" directly (`fusion_retention_source_entries{source="selection_memo_*"}`),
which is the question that decides whether to keep this bound or go after the cache-owning loops with
`prefetchWorkflowSelections` instead. `bytesPerEntry: 0` keeps these rates out of `tracked_bytes`.
*/
const selectionMemoCounters = { hits: 0, misses: 0, staleEpoch: 0 };
let memoRegistryRefused = false;

/** Memo decisions taken so far (hits = served without a store read). */
export function selectionMemoStats(): { hits: number; misses: number; staleEpoch: number } {
  return { ...selectionMemoCounters };
}

for (const [id, read] of [
  ["selection_memo_hits", () => selectionMemoCounters.hits],
  ["selection_memo_misses", () => selectionMemoCounters.misses],
  ["selection_memo_stale_epoch", () => selectionMemoCounters.staleEpoch],
] as const) {
  // A refused registration costs only observability — `false` means the id was already taken or the
  // registry ceiling was hit, never that the bound itself is wrong.
  if (!registerHostRetentionSource({ id, kind: "counter", bytesPerEntry: 0, read })) {
    memoRegistryRefused = true;
  }
}

/** True when the census refused to take a memo counter (registry ceiling or an id collision). */
export function selectionMemoRegistryRefused(): boolean {
  return memoRegistryRefused;
}

/**
 * Read one task's workflow selection for callers that own no per-pass cache, collapsing concurrent
 * duplicate reads onto one query and bounding how many distinct queries may be in flight at once.
 */
async function readSelectionWithCoalescing(
  store: WorkflowIrResolverStore,
  taskId: string,
): Promise<WorkflowSelection | undefined> {
  const epoch = selectionEpochOf(store);
  if (uncachedSelectionMemoTtlMs > 0) {
    const hit = selectionMemo.get(store)?.get(taskId);
    if (hit) {
      const staleEpoch = epoch >= 0 && hit.epoch !== epoch;
      if (!staleEpoch && Date.now() - hit.at < uncachedSelectionMemoTtlMs) {
        selectionMemoCounters.hits += 1;
        return hit.selection;
      }
      if (staleEpoch) selectionMemoCounters.staleEpoch += 1;
      selectionMemo.get(store)!.delete(taskId);
    }
    selectionMemoCounters.misses += 1;
  }
  let pending = inflightUncachedSelectionReads.get(store);
  if (!pending) {
    pending = new Map<string, Promise<WorkflowSelection | undefined>>();
    inflightUncachedSelectionReads.set(store, pending);
  }
  const existing = pending.get(taskId);
  if (existing) return existing;
  const inFlight = (async (): Promise<WorkflowSelection | undefined> => {
    await acquireSelectionReadSlot(store);
    try {
      const selection = store.getTaskWorkflowSelectionAsync
        ? await store.getTaskWorkflowSelectionAsync(taskId)
        : store.getTaskWorkflowSelection(taskId);
      // Only a read that actually reached the store is remembered, and an absent selection is remembered
      // too: an absent selection is the N+1 this memo exists for.
      if (uncachedSelectionMemoTtlMs > 0) {
        rememberSelection(store, taskId, { selection, epoch, at: Date.now() });
      }
      return selection;
    } finally {
      releaseSelectionReadSlot(store);
      // Bookkeeping is released with the query on BOTH paths, so the next pass is a real read.
      pending!.delete(taskId);
    }
  })();
  pending.set(taskId, inFlight);
  return inFlight;
}

/*
FNXC:WorkflowScheduling 2026-09-08-04:11:
Task-list rows share a caller-owned cache but populate it only after the definition await, so concurrent
misses previously re-read and re-parse one custom workflow per row (Runfusion/Fusion#3585). This weak
key scopes in-flight coalescing strictly to that pass and releases it with the caller-owned cache.
*/
const inflightIrReads = new WeakMap<Map<string, WorkflowIr>, Map<string, Promise<WorkflowIr>>>();

/*
FNXC:WorkflowScheduling 2026-09-05-23:12:
Multi-row read hydration must prefetch into its caller-owned, per-pass cache: a cached undefined is
intentional and prevents absent selections from becoming an N+1. Failed batch reads leave the cache
unchanged so a later pass retries and hydration uses its established individual-read fallback. Callers
must use this returned tally for accounting; cache growth cannot distinguish one batch from N reads.
*/
export async function prefetchWorkflowSelections(
  store: WorkflowIrResolverStore,
  taskIds: readonly string[],
  cache: WorkflowSelectionCache,
): Promise<WorkflowSelectionReadTally> {
  const missingIds = [...new Set(taskIds)].filter((id) => !cache.has(id));
  if (missingIds.length === 0) return { batched: 0, singles: 0 };
  if (!store.getTaskWorkflowSelectionsAsync) return { batched: 0, singles: missingIds.length };
  try {
    const selections = await store.getTaskWorkflowSelectionsAsync(missingIds);
    for (const id of missingIds) cache.set(id, selections.get(id));
    return { batched: 1, singles: 0 };
  } catch {
    return { batched: 0, singles: missingIds.length };
  }
}

export interface WorkflowIrResolverStore {
  getTaskWorkflowSelection(taskId: string): WorkflowSelection | undefined;
  getTaskWorkflowSelectionAsync?(taskId: string): Promise<WorkflowSelection | undefined>;
  getTaskWorkflowSelectionsAsync?(taskIds: string[]): Promise<Map<string, WorkflowSelection>>;
  getWorkflowDefinition(id: string): Promise<{ ir: string | WorkflowIr } | undefined>;
  getWorkflowSettingsProjectId?(): string;
  getWorkflowPromptOverrides?(workflowId: string, projectId: string): Record<string, string>;
  getWorkflowPromptOverridesAsync?(workflowId: string, projectId: string): Promise<Record<string, string>>;
}

/**
 * Extract a prompt seam's prompt text from a resolved workflow IR.
 *
 * Seam prompt nodes are prompt nodes with `config.seam === seam`;
 * `config.prompt` carries the text installed by builtinPromptConfig or a custom
 * workflow author. Empty/missing prompts return undefined so callers can apply
 * their own fail-soft fallback.
 */
export function resolveSeamPromptFromIr(ir: WorkflowIr, seam: string): string | undefined {
  for (const node of ir.nodes) {
    if (node.kind !== "prompt") continue;
    if (node.config?.seam !== seam) continue;
    const prompt = node.config.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) return prompt;
  }
  return undefined;
}

/** Extract the planning seam prompt from a resolved workflow IR. */
export function resolvePlanningPromptFromIr(ir: WorkflowIr): string | undefined {
  return resolveSeamPromptFromIr(ir, "planning");
}

/** Resolve a task's seam prompt via its selected workflow IR. */
export async function resolveTaskSeamPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  seam: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    return resolveSeamPromptFromIr(ir, seam);
  } catch {
    return undefined;
  }
}

/** Resolve a task's planning seam prompt via its selected workflow IR. */
export async function resolveTaskPlanningPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  return resolveTaskSeamPrompt(store, taskId, "planning", irCache);
}

/*
FNXC:WorkflowPromptOverrideMemo 2026-11-07-15:50 (RUFU-871):
The prompt-override read is the SECOND-hottest statement in the process. Sampling `pg_stat_activity`
inside a single `/api/tasks/page` request saw 243 `task_workflow_selection` selects AND 69
`select "overrides" from "project"."workflow_prompt_overrides"` — ~500 DB statements per second, across
1107 scheduler passes averaging 50–183 s each. The shape that produces it: every resolution of a
BUILT-IN workflow applies project-scoped overrides, and the override-applied IR is only memoized in
the caller's `irCache`, so a caller that owns no pass cache (the same ~50 sites RUFU-871 measured for
selections — self-healing sweeps, the agent heartbeat, the merger, notification service, trackers)
paid one overrides SELECT per card. That is the N+1 the selection memo left behind one layer down.

Deliberately NOT a second TTL. The memo reuses `uncachedSelectionMemoTtlMs` — the same
`FUSION_WORKFLOW_SELECTION_MEMO_MS` knob and the same `setSelectionMemoTtlMsForTests` accessor — because
the two memos guard one request path and an operator tuning it must not have to reason about two
numbers, and `0` must disable both or neither. Two TTL sources is how a memo ends up serving stale text
while its sibling is fresh.

Epoch bound is `workflowDefinitionEpoch()`, NOT `workflowSelectionEpoch()`: an override map is a
fact about the workflow definition, so the counter that moves when a definition (or an override) is
written is the one that invalidates it. The store-side counterpart is `updateWorkflowPromptOverrides`
bumping that epoch — without it this memo would just move the existing
`EpochedWorkflowIrCache` staleness bug (override-applied built-in IRs keyed by
`workflowId\u0000projectId`, invalidated only on create/update/deleteWorkflowDefinition, so an operator
editing a prompt override left long-lived caches serving the previous text) one layer down.

Only the ASYNC reader is memorized. The sync reader is the SQLite/embedder path where the value is
already in-process, so wrapping it would add a bound with no saving; it stays byte-identical and
live-per-call. A rejected read is never remembered — serving `{}` for a transient PostgreSQL failure
would silently drop an operator's prompts for the whole TTL.
*/

/** Distinct (workflow, project) pairs held at once. The key space is workflows × projects, not cards,
 *  so this ceiling is far above any real deployment and exists only to bound worst-case retention. */
export const PROMPT_OVERRIDES_MEMO_MAX = 1024;

/** The store surface `resolveWorkflowIrById` needs: one definition reader plus, for built-in workflows,
 *  the project scope and its prompt-override readers. */
export type WorkflowIrDefinitionStore =
  Pick<WorkflowIrResolverStore, "getWorkflowDefinition">
  & Partial<Pick<WorkflowIrResolverStore, "getWorkflowSettingsProjectId" | "getWorkflowPromptOverrides" | "getWorkflowPromptOverridesAsync">>;

interface PromptOverridesMemoEntry {
  overrides: Record<string, string>;
  /** Definition epoch the map was read under; a local override/definition write makes it a miss. */
  epoch: number;
  at: number;
}

/** Keyed weakly by store, so a per-test fake can never read another store's overrides and a project
 *  scope's map dies with its store. Entry values are handed out as-is: `applyPromptOverridesToIr`
 *  reads the map and never mutates it. */
const promptOverridesMemo = new WeakMap<WorkflowIrDefinitionStore, Map<string, PromptOverridesMemoEntry>>();

/** -1 means the store exposes no definition epoch, so the entry is bounded by TTL alone. */
function promptDefinitionEpochOf(store: WorkflowIrDefinitionStore): number {
  const epoch = (store as { workflowDefinitionEpoch?: () => number }).workflowDefinitionEpoch?.();
  return typeof epoch === "number" ? epoch : -1;
}

function rememberPromptOverrides(store: WorkflowIrDefinitionStore, key: string, entry: PromptOverridesMemoEntry): void {
  let memo = promptOverridesMemo.get(store);
  if (!memo) {
    memo = new Map<string, PromptOverridesMemoEntry>();
    promptOverridesMemo.set(store, memo);
  }
  memo.set(key, entry);
  // Insertion order is the eviction order: losing the oldest project is cheaper than losing the memo.
  while (memo.size > PROMPT_OVERRIDES_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/** Entries currently held — an operator-facing debug signal, never a decision input. */
export function promptOverridesMemoSizeForStore(store: WorkflowIrDefinitionStore): number {
  return promptOverridesMemo.get(store)?.size ?? 0;
}

/*
FNXC:WorkflowPromptOverrideMemo 2026-11-07-15:50 (RUFU-871):
Hit/miss counters published as census sources, for the reason RUFU-871 already learned twice: store-seam
read counters cannot answer whether a memo was ever asked, because the cache-owning callers (board
hydration, the scheduler sweep) never reach it. `/metrics` therefore answers
"how often does the built-in branch actually go to PostgreSQL for overrides?" directly via
`fusion_retention_source_entries{source="prompt_override_memo_*"}`. `bytesPerEntry: 0` keeps these rates
out of `tracked_bytes`, since a counter is not a retained structure.
*/
const promptOverridesMemoCounters = { hits: 0, misses: 0, staleEpoch: 0 };
let promptOverridesMemoCensusRefused = false;

/** Memo decisions taken so far (hits = served without an overrides read). */
export function promptOverridesMemoStats(): { hits: number; misses: number; staleEpoch: number } {
  return { ...promptOverridesMemoCounters };
}

for (const [id, read] of [
  ["prompt_override_memo_hits", () => promptOverridesMemoCounters.hits],
  ["prompt_override_memo_misses", () => promptOverridesMemoCounters.misses],
  ["prompt_override_memo_stale_epoch", () => promptOverridesMemoCounters.staleEpoch],
] as const) {
  // A refused registration costs only observability, never the bound itself.
  if (!registerHostRetentionSource({ id, kind: "counter", bytesPerEntry: 0, read })) {
    promptOverridesMemoCensusRefused = true;
  }
}

/** True when the census refused to take a prompt-override counter (registry ceiling or id collision). */
export function promptOverridesMemoRegistryRefused(): boolean {
  return promptOverridesMemoCensusRefused;
}

/**
 * One project-scoped prompt-override read, served from the memo while its TTL holds and its definition
 * epoch is current. Falls straight through for the sync-only (SQLite/embedder) reader.
 */
async function readPromptOverridesWithMemo(
  store: WorkflowIrDefinitionStore,
  workflowId: string,
  projectId: string,
): Promise<Record<string, string>> {
  const readAsync = store.getWorkflowPromptOverridesAsync;
  if (!readAsync) return store.getWorkflowPromptOverrides?.(workflowId, projectId) ?? {};
  if (uncachedSelectionMemoTtlMs <= 0) return readAsync.call(store, workflowId, projectId);

  const key = `${workflowId}\u0000${projectId}`;
  const epoch = promptDefinitionEpochOf(store);
  const memo = promptOverridesMemo.get(store);
  const hit = memo?.get(key);
  if (hit) {
    const staleEpoch = epoch >= 0 && hit.epoch !== epoch;
    if (!staleEpoch && Date.now() - hit.at < uncachedSelectionMemoTtlMs) {
      promptOverridesMemoCounters.hits += 1;
      return hit.overrides;
    }
    // A write this process made, versus a TTL lapse, are reported separately: one is a missing bump,
    // the other is the documented bound on a write made by another process.
    if (staleEpoch) promptOverridesMemoCounters.staleEpoch += 1;
    memo!.delete(key);
  }
  promptOverridesMemoCounters.misses += 1;
  const overrides = await readAsync.call(store, workflowId, projectId);
  // Reached only after the read resolved, so a failure is retried by the next caller, not memoized.
  rememberPromptOverrides(store, key, { overrides, epoch, at: Date.now() });
  return overrides;
}

/**
 * Resolve a workflow IR by its id (built-in or custom).
 *
 * @param irCache optional cache keyed by workflowId so each distinct workflow's
 *   IR (and its definition fetch) is resolved at most once per caller-scoped
 *   sweep. Hits short-circuit before any builtin/db lookup.
 */
export async function resolveWorkflowIrById(
  store: WorkflowIrDefinitionStore,
  requestedWorkflowId: string,
  irCache?: Map<string, WorkflowIr>,
  definitionReadTally?: WorkflowDefinitionReadTally,
): Promise<WorkflowIr> {
  const workflowId = requestedWorkflowId;
  let projectId: string | undefined;
  try { projectId = store.getWorkflowSettingsProjectId?.(); } catch { projectId = undefined; }
  const cacheKey = irCacheKey(workflowId, projectId);
  const cached = irCache?.get(cacheKey);
  if (cached) return cached;

  const resolve = async (): Promise<WorkflowIr> => {
    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      const fellBackToDefault = !builtin?.ir;
      const ir = builtin?.ir ?? defaultCodingWorkflowIr();
      const resolved = typeof ir === "string" ? parseWorkflowIr(ir) : ir;
      /*
      FNXC:WorkflowPromptOverrideMemo 2026-11-07-15:50 (RUFU-871):
      Memoized here, on the `irCache`-miss branch, and nowhere else: a pass cache that holds the
      override-applied IR short-circuits above this line, so a cache-owning caller never reaches the
      memo and keeps its established live-per-call behaviour within one pass.
      */
      const overrides = projectId ? await readPromptOverridesWithMemo(store, workflowId, projectId) : undefined;
      const effective = applyPromptOverridesToIr(resolved, overrides);
      const answer = fellBackToDefault ? markFellBack(effective) : effective;
      irCache?.set(cacheKey, answer);
      return answer;
    }
    try {
      /*
      FNXC:WorkflowScheduling 2026-09-08-04:11:
      This tally counts getWorkflowDefinition invocations actually issued. Distinct ids, cache growth,
      and prefetch attempts misreport built-in, absent-selection, warm-cache, and retryable fallback paths.
      */
      if (definitionReadTally) definitionReadTally.definitions += 1;
      const def = await store.getWorkflowDefinition(workflowId);
      if (!def) return markFellBack(defaultCodingWorkflowIr());
      const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
      irCache?.set(cacheKey, ir);
      return ir;
    } catch { return markFellBack(defaultCodingWorkflowIr()); }
  };

  if (!irCache) return resolve();
  let inflight = inflightIrReads.get(irCache);
  if (!inflight) { inflight = new Map(); inflightIrReads.set(irCache, inflight); }
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const readPromise = resolve();
  inflight.set(cacheKey, readPromise);
  try { return await readPromise; } finally { inflight.delete(cacheKey); }
}

/** Prefetch distinct effective workflow IRs into a caller-owned pass cache. */
export async function prefetchWorkflowIrs(
  store: WorkflowIrResolverStore,
  taskIds: readonly string[],
  irCache: Map<string, WorkflowIr>,
  selectionCache: WorkflowSelectionCache,
  definitionReadTally?: WorkflowDefinitionReadTally,
): Promise<void> {
  /* FNXC:WorkflowScheduling 2026-09-08-04:11: Delegating to the resolver keeps observed-read accounting at the store call site and isolates one broken definition from board hydration.
  
  FNXC:WorkflowIrHoist 2026-11-08-05:57 (RUFU-871): The mapped default MUST stay
  `FALLBACK_WORKFLOW_ID`, the same rule `createCachedWorkflowIrReader` applies — a card this function
  maps to a different workflow than the reader maps it to is a card the reader answers from the wrong
  graph, or not at all. */
  const ids = new Set(taskIds.map((taskId) => selectionCache.get(taskId)?.workflowId ?? FALLBACK_WORKFLOW_ID));
  await Promise.all([...ids].map(async (id) => {
    try { await resolveWorkflowIrById(store, id, irCache, definitionReadTally); } catch { /* fail-soft */ }
  }));
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:45 (PR #2618 review — greptile P1, both rounds):
FALLBACK IS REPORTED, NOT INFERRED. Two review findings pulled in opposite directions and
together proved the id cannot answer this: requiring `ir.id === workflowId` denied trust to a
valid selection whose IR carries no id, while accepting an absent id let the default fallback —
which also has none — pass as a selection. There is no rule over the returned value that
separates them, because the two shapes are genuinely identical.

So the function that KNOWS marks it. A non-enumerable brand keeps the IR structurally unchanged
for every existing consumer, deep-equal comparisons included, while letting the provenance form
read the one fact only the resolver has.
*/
const FELL_BACK_TO_DEFAULT = Symbol.for("fusion.workflowIr.fellBackToDefault");

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:45 (#2815 review — found while covering the fourth path):
BRAND A COPY. `resolveDefaultWorkflowIr()` returns a SHARED object — `a.ir === b.ir` across two
independent resolutions — so branding it in place marked the singleton itself. After any task
anywhere hit a fallback, every later resolution of `builtin:coding` reported `source: "default"`,
including a task that genuinely selected the default workflow. Process-wide, permanent, and
invisible: the brand is non-enumerable, so nothing in a dump or a deep-equal shows it.

It also made the fourth-path test unfalsifiable — the object under assertion was already branded by
an earlier case in the same file, so removing the new mark changed nothing.

A shallow copy keeps the IR structurally identical (the property is non-enumerable and the clone is
deep-equal to the original) while giving the fallback its own object to carry the fact.
*/
function markFellBack(ir: WorkflowIr): WorkflowIr {
  const copy = { ...ir } as WorkflowIr;
  Object.defineProperty(copy, FELL_BACK_TO_DEFAULT, { value: true, enumerable: false, configurable: true });
  return copy;
}

function didFallBackToDefault(ir: WorkflowIr): boolean {
  return (ir as unknown as Record<symbol, unknown>)[FELL_BACK_TO_DEFAULT] === true;
}

/**
 * Resolve a task's workflow IR via its selection. A null/absent selection or any
 * lookup failure degrades to the built-in default workflow.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:10 (lifecycle-column census enabler):
WHY PROVENANCE IS A SEPARATE ANSWER FROM THE IR.

`resolveWorkflowIrForTask` answers "which workflow governs this task" by returning the default
coding IR in two cases that are NOT the same as knowing: the selection read threw, and the store
reported no selection at all (the synchronous PostgreSQL path does exactly that). Callers cannot
tell those apart from a genuine selection, and for lifecycle-column work the difference decides
correctness rather than tidiness.

Concretely, and this is what motivated it: post-merge the default coding lineage declares `todo`
as its single Planning column and NO `triage`. So a call site converting a `column === "triage"`
guard to trait resolution silently stops firing for `builtin:legacy-coding` cards whenever the
store cannot name the workflow — the resolver hands back the default's vocabulary and the caller
has no way to know it was a guess. Every such site has so far had to keep the legacy ids unioned
in "just in case", which is exactly why the census stalls instead of converging.

With provenance a caller can say what it actually means: trust the resolved columns when the
workflow was SELECTED, and fall back to legacy compat only when it was GUESSED.

Additive by construction — `resolveWorkflowIrForTask` delegates here and drops the provenance, so
no existing caller changes behavior.
*/
export type WorkflowIrResolutionSource = "selection" | "default";

export interface ResolvedWorkflowIr {
  ir: WorkflowIr;
  /** `"selection"` only when the store named a workflow; `"default"` when we guessed. */
  source: WorkflowIrResolutionSource;
  /** The selected id, absent when guessed. */
  workflowId?: string;
  selectionAbsent?: boolean;
}

export async function resolveWorkflowIrForTaskWithProvenance(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
  definitionReadTally?: WorkflowDefinitionReadTally,
): Promise<ResolvedWorkflowIr> {
  let workflowId: string | undefined;
  try {
    /*
    FNXC:WorkflowScheduling 2026-08-09-06:07:
    Selection caches are per-call/per-scheduler-pass only: selection writes invalidate lane state and the next pass must observe them. A throwing read is deliberately not cached so transient PostgreSQL failures are retried; therefore instrumentation must count calls rather than infer them from cache keys.
    */
    const isSelectionCached = selectionCache?.has(taskId) ?? false;
    let selection: WorkflowSelection | undefined = isSelectionCached && selectionCache ? selectionCache.get(taskId) : undefined;
    if (!isSelectionCached) {
      // When a caller OWNs a per-tick cache shared by concurrent wake closures, coalesce duplicated
      // in-flight reads onto ONE promise (RUFU-073). When NO cache is supplied, behave exactly as
      // before: read the selection once, live-per-call, and cache nothing.
      let inflight: Map<string, Promise<WorkflowSelection | undefined>> | undefined;
      let coalesced = false;
      if (selectionCache) {
        inflight = inflightSelectionReads.get(selectionCache);
        if (!inflight) {
          inflight = new Map<string, Promise<WorkflowSelection | undefined>>();
          inflightSelectionReads.set(selectionCache, inflight);
        }
        const pending = inflight.get(taskId);
        if (pending) {
          // A concurrent closure sharing this cache already owns the read; just await its outcome.
          selection = await pending;
          coalesced = true;
        }
      }
      if (!coalesced && selectionCache && inflight) {
        const readPromise = store.getTaskWorkflowSelectionAsync
          ? store.getTaskWorkflowSelectionAsync(taskId)
          : Promise.resolve(store.getTaskWorkflowSelection(taskId));
        // Book first, then fulfill; any subsequent caller sharing this cache sees `pending` and awaits
        // the same promise instead of issuing its own DB read.
        inflight.set(taskId, readPromise);
        try {
          selection = await readPromise;
        } finally {
          inflight.delete(taskId);
        }
      }
      if (!coalesced && !selectionCache) {
        /*
        FNXC:WorkflowScheduling 2026-10-06-08:56 (RUFU-588):
        This is the branch the ~150 uncached call sites fall through, and until now it issued an
        uncoalesced, unbounded SELECT per caller. Coalescing here is per-query-lifetime only, so
        live-per-call is preserved; see the WeakMap declaration above for the measured rationale.
        */
        selection = await readSelectionWithCoalescing(store, taskId);
      }
      // Cache the resolved value so SEQUENTIAL later calls in the same pass skip even the coalescer.
      // A throwing read is deliberately NOT cached so transient failures are retried next pass.
      selectionCache?.set(taskId, selection);
    }
    workflowId = selection?.workflowId;
  } catch {
    return { ir: defaultCodingWorkflowIr(), source: "default" };
  }
  if (!workflowId) {
    return { ir: await resolveWorkflowIrById(store, FALLBACK_WORKFLOW_ID, irCache, definitionReadTally), source: "default", selectionAbsent: true };
  }
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-13:20 (PR #2618 review — greptile P1):
  A NAMED SELECTION IS NOT A RESOLVED ONE. `resolveWorkflowIrById` degrades to the default coding
  IR in three further cases — a missing definition, a malformed one, and a throwing lookup — so
  reporting `source: "selection"` merely because the store named an id would hand a caller the
  default's columns wearing the selected workflow's label. That is worse than having no provenance
  at all: the entire value of this API is that a caller can TRUST "selection", and a signal that
  lies is one nobody can build the census conversions on.

  Verified by identity, not by hope: a v2 IR carries its own id, so a returned IR whose id is not
  the selected one is a fallback however it arose. A v1/column-less IR carries no id to check, and
  it has no column vocabulary either, so it is reported as a default rather than guessed at.
  */
  const ir = await resolveWorkflowIrById(store, workflowId, irCache, definitionReadTally);
  /*
FNXC:WorkflowLifecycleColumns 2026-08-01-03:10 (the id cross-check is DELETED — it is unreliable and redundant):
  THE MARKER IS THE WHOLE ANSWER. An id-equality check used to run after this line, on the reasoning
  that a returned IR whose `id` differs from the requested one proves a fallback. Both halves of that
  are wrong.

  UNRELIABLE. Neither `WorkflowIrV1` nor `WorkflowIrV2` declares an `id` field, so the check is
  answering a question about a property the IR type does not have. When one IS present — a fixture, a
  hand-authored graph, an import — it is the AUTHOR's id and has no relation to the `WF-NNN` the store
  mints, because `createWorkflowDefinition` persists the IR verbatim and allocates the row id
  separately. Measured:

      store workflow id = WF-001   stored ir.id = custom:prov
      -> source reported "default", for a workflow that resolved CORRECTLY

  REDUNDANT. All four ways `resolveWorkflowIrById` substitutes the default — missing definition,
  malformed definition, throwing lookup, and an unregistered builtin id (branded above, in this same
  change) — return a MARKED IR, and the line below returns `"default"` for every one of them.

  The note on `markFellBack` states the principle: "there is no rule over the returned value that
  separates them, because the two shapes are genuinely identical. So the function that KNOWS marks
  it." The id check was an inference over the returned value, which is exactly what that note rules
  out.

  SCOPE, corrected after the first version of this change overstated it: an editor-authored workflow
  carries no `ir.id`, so the check reported `"selection"` for it and the misfire never reached the one
  production consumer (`triage.ts`'s post-U11 intake recovery). The reachable defect this change fixes
  is the unregistered-builtin branding hole above; removing the id check is correctness and clarity,
  not a live bug fix.

  Found while fixing PR #2812, where gating on this signal turned a fixture-built case red.
  */
  if (didFallBackToDefault(ir)) return { ir, source: "default" };
  return { ir, source: "selection", workflowId };
}

export async function resolveWorkflowIrForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
  definitionReadTally?: WorkflowDefinitionReadTally,
): Promise<WorkflowIr> {
  /*
   * FNXC:WorkflowModelLanes 2026-07-14-16:26:
   * Backend-mode task workflow selection is asynchronous. Execution must resolve the migrated task selection before loading its workflow graph; the synchronous PostgreSQL fallback intentionally reports no selection and previously forced every task onto builtin:coding.
   *
   * FNXC:WorkflowLifecycleColumns 2026-07-30-12:15: delegates to the provenance form and drops
   * the provenance, so the two answers cannot drift apart.
   */
  return (await resolveWorkflowIrForTaskWithProvenance(store, taskId, irCache, selectionCache, definitionReadTally)).ir;
}

/*
FNXC:StateMachine 2026-07-31-20:10 (PR #2793's finding, fixed):
IS `nodeId` THE TASK'S OWN TERMINAL NODE? Resolved from the task's REAL workflow.

The previous answer came from `store.resolveTaskWorkflowIrSync`, which returns the DEFAULT workflow
IR for every task under PostgreSQL, so it answered about a board the card is not on. On a workflow
whose terminal node is not called `end` that inverted the FN-7641 guard in both directions: a
legitimate override to a non-terminal node named `end` was rejected as a terminal finalize, and an
override to the board's REAL terminal node was written verbatim — the silent no-op FN-7641 exists to
prevent. Proven end to end in `workflow-terminal-node-sync-resolution-live-e2e.pg.test.ts`.

FAIL-SOFT TO THE LITERAL, deliberately: an unresolvable workflow keeps exactly the pre-conversion
answer rather than losing the guard. `end` is also every builtin's terminal node id, so the fallback
is correct wherever it can still be reached.

RESIDUAL, stated because a review raised it and the obvious remedy does not work yet (PR #2812):
`resolveWorkflowIrForTask` DEGRADES to the default workflow instead of throwing, so the `catch` above
does not cover a failed lookup — a task on a custom board whose definition cannot be loaded is judged
against the default graph. The natural fix is to gate on
`resolveWorkflowIrForTaskWithProvenance(...).source === "selection"`, and that signal is currently
unusable: `createWorkflowDefinition` stores an authored IR VERBATIM, so its `ir.id` keeps whatever the
author wrote while the store allocates its own `WF-NNN`. The provenance identity check then compares
those two and reports `source: "default"` for a workflow it resolved CORRECTLY. Measured, not
assumed — gating on it here turned the "non-terminal override is written" case red.

So the residual is knowingly left: it is the pre-existing fail-soft, not a regression this change
introduces, and narrowing it depends on fixing the provenance signal first.
*/
export async function isTaskTerminalNodeIdAsync(
  store: WorkflowIrResolverStore,
  taskId: string,
  nodeId: string,
): Promise<boolean> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    const node = ir.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node.kind === "end";
  } catch {
    // Fall through to the literal-id fallback below.
  }
  return nodeId === "end";
}
