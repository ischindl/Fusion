import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-board-workflows");
/**
 * Board multi-lane payload assembly (U9, R16/R17).
 *
 * When the `workflowColumns` flag is ON, the dashboard board groups visible
 * cards into one lane per workflow in use. This module resolves, for a set of
 * tasks, the workflow each card belongs to plus the (deduplicated) set of
 * workflow definitions referenced — each carrying its ordered columns, display
 * names, and *resolved trait flags* (archived / hold / complete / wip etc.) so
 * the client can render live lanes and show promote affordances,
 * and pre-check drag adjacency/capacity without a second round-trip.
 *
 * The payload is served by a sibling endpoint (`GET /tasks/board-workflows`)
 * rather than folded into the `/tasks` list response, so the existing task
 * payload stays byte-identical and flag-OFF clients are wholly unaffected
 * (additive-only, KTD-8/R19).
 */

import {
  resolveDefaultWorkflowIr,
  resolveEffectiveDefaultWorkflowId,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  parseWorkflowIr,
  type WorkflowDefinition,
  resolveAllowedColumns,
  resolveColumnFlags,
  resolveWorkflowIrById,
  prefetchWorkflowSelections,
  type Settings,
  type TaskStore,
  type TraitFlags,
  type WorkflowIr,
  type WorkflowIrV2,
  type WorkflowIrColumn,
  type WorkflowFieldDefinition,
  type WorkflowSelectionCache,
} from "@fusion/core";

/** A workflow-defined custom task field as the board client needs it (U13/KTD-14).
 *  Uses @fusion/core's WorkflowFieldDefinition directly now that it is exported
 *  through the barrel. The payload is a verbatim pass-through of the IR's `fields` array. */
export type BoardWorkflowField = WorkflowFieldDefinition;

/** Stable id the client uses for the implicit default lane (null selection). */
export const DEFAULT_WORKFLOW_LANE_ID = "builtin:coding";

/** One column as the board client needs it: id, display name, resolved flags. */
export interface BoardWorkflowColumn {
  id: string;
  name: string;
  /** Optional author-defined explanatory copy; omitted keeps client lifecycle fallback. */
  description?: string;
  flags: TraitFlags;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
  The columns this one may move to, resolved from the workflow's OWN graph adjacency
  (`resolveAllowedColumns`) — the same function `moveTaskInternal` validates against,
  so the menu offers exactly what the store will accept.

  This field exists to retire the client's two remaining legacy-vocabulary reads. The
  context menu previously had no adjacency at all, so it approximated targets by a
  column's NEIGHBOURS in declared order and kept a `VALID_TRANSITIONS` shortcut for
  workflows whose column-id set matched the six built-ins — because the neighbour
  approximation is strictly weaker (in-progress: 4 real targets vs 2 neighbours).

  Optional on the wire so a client older than this field keeps its previous behaviour
  rather than losing its move menu.
  */
  moveTargets?: string[];
}

/** A workflow definition in use by visible cards. */
export interface BoardWorkflowDefinition {
  id: string;
  name: string;
  /** Whether this definition may be selected for new board/task work. Optional for older cached payloads. */
  selectable?: boolean;
  /** Optional compact custom workflow icon; built-ins render the Fusion mark by id. */
  icon?: string;
  columns: BoardWorkflowColumn[];
  /** Custom field definitions declared by the workflow (U13/KTD-14). Absent
   *  when the workflow declares no fields. */
  fields?: BoardWorkflowField[];
}

/** The full board-workflows payload. `flagEnabled: false` short-circuits the
 *  client back to the legacy single-lane render. */
export interface BoardWorkflowsPayload {
  flagEnabled: boolean;
  /** The default lane id (where null-selection cards land). */
  defaultWorkflowId: string;
  /** Deduplicated workflow definitions referenced by the provided tasks. */
  workflows: BoardWorkflowDefinition[];
  /** taskId → resolved workflowId (the lane the card belongs in). */
  taskWorkflowIds: Record<string, string>;
}

/*
 * FNXC:Workflows 2026-07-07-00:00:
 * The canonical built-in lifecycle label for the intake column (id: "triage")
 * is "Planning" — FN-7599 renamed the IR column name, but this override map
 * was still clobbering it back to "Triage" for built-in workflows via
 * describeColumns(ir, true). Do not re-clobber the IR rename (FN-7660); the
 * column id itself remains "triage" everywhere (types, DB, transitions).
 */
const BUILTIN_WORKFLOW_COLUMN_LABELS: Record<string, string> = {
  ideas: "Ideas",
  triage: "Planning",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
};

function toV2(ir: WorkflowIr): WorkflowIrV2 | undefined {
  return ir.version === "v2" ? ir : undefined;
}

/*
 * FNXC:WorkflowResolvedColumns 2026-07-27-16:45 (U10 / R8):
 * The canonical map is a FALLBACK, not an override. Applied unconditionally it replaced the name
 * a built-in workflow deliberately chose — `builtin:lead-generation` names `triage` "Lead intake"
 * and the board rendered "Planning" — and it is the same mechanism that would clobber a renamed
 * built-in column (U11's Todo -> Planning). Canonicalise only when the IR's own name adds nothing:
 * blank, the raw column id, or the same words in different case (the "In progress"/"In Progress"
 * variants that motivated the map). Anything else is an authored name and wins.
 */
function displayColumnName(id: string, name: string, canonicalizeLifecycle: boolean): string {
  if (!canonicalizeLifecycle) return name;
  const canonical = BUILTIN_WORKFLOW_COLUMN_LABELS[id];
  if (!canonical) return name;
  const trimmed = name?.trim() ?? "";
  const isUninformative = trimmed === ""
    || trimmed.toLowerCase() === id.toLowerCase()
    || trimmed.toLowerCase() === canonical.toLowerCase();
  return isUninformative ? canonical : trimmed;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
`manualIntake` — an intake column that does NOT auto-triage, i.e. one where cards wait
for an operator to promote them (Coding (Ideas)'s "Ideas" lane).

It exists because the distinction is trait CONFIG (`intake` with `autoTriage: false`),
not a trait flag, so it was invisible to every client. The dashboard approximated it as
`intake && column !== "triage"` — a hardcoded id doing the work of a missing fact. That
approximation inverts under U11: the merged Planning column keeps id `todo` and `triage`
is deleted, so `column !== "triage"` becomes vacuously TRUE and a "Start" action would
appear on every planning card. Surfacing the real fact is the fix; renaming the
comparison would not have been.
*/
function isManualIntakeColumn(col: WorkflowIrColumn): boolean {
  const flags = resolveColumnFlags(col);
  if (flags.intake !== true) return false;
  const intakeTrait = (col.traits ?? []).find((trait) => trait.trait === "intake");
  return (intakeTrait?.config as { autoTriage?: boolean } | undefined)?.autoTriage === false;
}

/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
FN-509: the SERVER needs the same column facts the board card reasons about, so the Boost endpoint
can refuse a lane that has no automatic queue instead of persisting a durable rank on a Complete or
manual-capture card. Reusing this module keeps `manualIntake` a single derivation.
*/
export function resolveBoardColumnFlags(
  ir: WorkflowIr,
  columnId: string,
): BoardWorkflowColumn["flags"] | undefined {
  const column = toV2(ir)?.columns.find((col) => col.id === columnId);
  if (!column) return undefined;
  return { ...resolveColumnFlags(column), ...(isManualIntakeColumn(column) ? { manualIntake: true } : {}) };
}

function describeColumns(ir: WorkflowIr, canonicalizeLifecycle = false): BoardWorkflowColumn[] {
  const v2 = toV2(ir);
  if (!v2) return [];
  return v2.columns.map((col) => ({
    id: col.id,
    name: displayColumnName(col.id, col.name, canonicalizeLifecycle),
    ...(col.description ? { description: col.description } : {}),
    flags: { ...resolveColumnFlags(col), ...(isManualIntakeColumn(col) ? { manualIntake: true } : {}) },
    moveTargets: resolveAllowedColumns(ir, col.id),
  }));
}

/** Pass through the workflow's declared custom fields (U13/KTD-14). Returns
 *  `undefined` when the workflow declares none, so the payload stays compact and
 *  byte-identical for field-less workflows. */
function describeFields(ir: WorkflowIr): BoardWorkflowField[] | undefined {
  const v2 = toV2(ir);
  const fields = v2?.fields;
  if (!fields || fields.length === 0) return undefined;
  return fields;
}

/*
FNXC:BoardLoad 2026-10-06-18:55 (RUFU-585):
Both independent fan-outs in the board payload (per-card selection reads on the
fallback path, and per-workflow IR description) used to be awaited inside a
`for … of` loop, so a request paid the SUM of every round-trip instead of the
slowest one. This bounded mapper keeps result order while running at most
`limit` items at a time, so the fan-out is bounded by concurrency rather than by
how many cards or workflows the board happens to reference.

`github-tracking-reconciler.ts` has a private worker-pool limiter with the same
shape but a `void` worker, so it cannot carry results. A shared util is the right
home for this and is deliberately left as follow-up rather than widening two
unrelated modules in a latency fix.
*/
const SELECTION_READ_CONCURRENCY = 8;
const WORKFLOW_DESCRIBE_CONCURRENCY = 4;

async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/*
FNXC:BoardWorkflows 2026-11-07-12:41 (RUFU-871):
`catalogRow` is the definition the caller already holds from its ONE
`listWorkflowDefinitions()` read. When it is present the workflow is described from it and ZERO
further reads happen.

Dropping the per-workflow read for a BUILT-IN is not a behaviour change, and this is why: the only
thing `resolveWorkflowIrById` adds over the catalog row is `applyPromptOverridesToIr`, and that
function rewrites `nodes[].config.prompt` and nothing else (`workflow-prompt-overrides.ts`).
Everything this payload carries about a workflow comes from `ir.columns` (id, name, description,
resolved trait flags, and `resolveAllowedColumns` adjacency, which derives from column ids, traits
and declared order) plus `ir.fields`. Neither half reads a node prompt, so an override cannot reach
the wire and the read bought nothing. `board-workflows-read-cost.test.ts` asserts that identity.

The catalog row is deliberately not trusted for a workflow it does not list: a card can still select
a deleted custom workflow, and the pre-existing fallback (read the definition, else the catalog
default IR) must keep describing it. A missing row therefore keeps the read path — and so does a row
that carries no usable IR, because a listing row is allowed to be an id/kind stub.
*/
function definitionIr(definition: WorkflowDefinition): WorkflowIr | undefined {
  const raw = definition.ir as string | WorkflowIr | undefined | null;
  if (raw === undefined || raw === null) return undefined;
  try {
    return typeof raw === "string" ? parseWorkflowIr(raw) : raw;
  } catch {
    return undefined;
  }
}

async function describeWorkflow(
  store: Pick<TaskStore, "getWorkflowDefinition">,
  workflowId: string,
  selectable: boolean,
  catalogRow?: WorkflowDefinition,
): Promise<BoardWorkflowDefinition> {
  // The display name comes from the persisted definition when available,
  // otherwise the IR's own name (default workflow).
  if (isBuiltinWorkflowId(workflowId)) {
    const ir = (catalogRow ? definitionIr(catalogRow) : undefined) ?? await resolveWorkflowIrById(store, workflowId);
    const name = getBuiltinWorkflow(workflowId)?.name ?? ir.name;
    const fields = describeFields(ir);
    return { id: workflowId, name, selectable, columns: describeColumns(ir, true), ...(fields ? { fields } : {}) };
  }
  // Custom workflow: fetch the definition once and derive both IR and name from
  // it (previously getWorkflowDefinition was called twice per workflow).
  /*
  FNXC:WorkflowBuiltins 2026-07-31-23:59:
  THE CATALOG DEFAULT, NOT THE LEGACY IR. This is the placeholder a CUSTOM workflow's description
  falls back to when `getWorkflowDefinition` returns nothing or throws.
  `BUILTIN_CODING_WORKFLOW_IR` is `builtin:legacy-coding`, which declares a `triage` column the
  default board does not have — so a workflow that failed to load was described with a phantom lane.
  That is the #3178 symptom (TUI board rendering `triage`) reached through the dashboard route.
  */
  let ir: WorkflowIr = resolveDefaultWorkflowIr();
  let name = ir.name;
  let icon: string | undefined;
  const catalogIr = catalogRow ? definitionIr(catalogRow) : undefined;
  if (catalogRow && catalogIr) {
    ir = catalogIr;
    name = catalogRow.name || ir.name;
    icon = catalogRow.icon;
  } else {
    try {
      const def = await store.getWorkflowDefinition(workflowId);
      if (def) {
        ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
        name = def.name || ir.name;
        icon = def.icon;
      }
    } catch {
      // fall through to the default IR/name
    }
  }
  const fields = describeFields(ir);
  return { id: workflowId, name, selectable, ...(icon ? { icon } : {}), columns: describeColumns(ir), ...(fields ? { fields } : {}) };
}

/**
 * Build the board-workflows payload for the given task ids. Resolves each task's
 * workflow selection (null → the default workflow lane) and assembles the
 * deduplicated set of referenced workflow definitions.
 *
 * FNXC:WorkflowColumns 2026-07-27-09:48 (U2 / R9):
 * The flag-OFF early return is deleted — its gate (`isWorkflowColumnsEnabled`)
 * returned a literal `true`, so the empty payload was unreachable. `flagEnabled`
 * stays on the WIRE as a constant `true` because shipped dashboard clients still
 * branch on it (Board, ListView, TaskDetailModal, useBoardWorkflows); removing
 * the field would change the response shape, which this delete-only unit must
 * not do. U10 retires the field once no client reads it.
 */
export async function buildBoardWorkflowsPayload(
  store: Pick<TaskStore, "getWorkflowDefinition" | "getTaskWorkflowSelection" | "getSettings" | "listWorkflowDefinitions"> &
    Partial<Pick<TaskStore, "getTaskWorkflowSelectionAsync" | "getTaskWorkflowSelectionsAsync">>,
  taskIds: string[],
  settingsOverride?: Pick<Settings, "experimentalFeatures">,
  /*
  FNXC:BoardWorkflows 2026-11-07-12:41 (RUFU-871):
  A caller that already read the workflow catalog for this request hands it over instead of paying a
  second `listWorkflowDefinitions()`. The board route needs the project lane vocabulary from these
  same rows and was issuing its own read for them. Passing the catalog is also what makes the
  per-workflow reads removable: these rows already describe every workflow they list.
  */
  workflowCatalog?: readonly WorkflowDefinition[],
  /*
  FNXC:BoardWorkflowsCost 2026-11-09-11:35 (RUFU-906):
  A caller-owned workflow-selection pass cache — the same `WorkflowSelectionCache` every cache-owning
  read pass in `@fusion/core` already threads (`listTasks`, `resolveWorkflowIrForTask`, the hold-release
  sweep). Before this the builder owned its selection pass entirely, so a caller that had ALREADY
  resolved these cards could not hand what it had over and every request re-read every id.

  It is request-scoped by design, not process-scoped. `EpochedWorkflowSelectionCache` invalidates on
  `workflowDefinitionEpoch()`/`workflowSelectionEpoch()`, which `store.ts` keeps as process-local
  instance counters — a selection written by another process (an `fn` CLI planning a card, a second
  engine) never moves them. Tolerable for a scheduler pass that re-runs in seconds; for the lane a card
  renders under, an invalidation policy with no clock could pin a card in the wrong lane indefinitely.
  Cross-request reuse therefore lives at the route, where the coalescer bounds staleness by a TTL an
  operator can name (`FUSION_BOARD_WORKFLOWS_TTL_MS`) instead of by an epoch that can fail to move.
  */
  selectionCache?: WorkflowSelectionCache,
): Promise<BoardWorkflowsPayload> {
  /*
  FNXC:WorkflowColumns 2026-07-27-09:50 (U2 / R9):
  `settingsOverride` and the `store.getSettings()` read it defaulted to existed
  ONLY to feed the deleted flag check — no other field of this payload depends on
  settings. The parameter stays in the signature (callers pass it positionally
  and it costs nothing) but is no longer read, so the settings round-trip is gone
  from the board-load path.
  */
  void settingsOverride;
  const flagEnabled = true;
  let settings: Pick<Settings, "defaultWorkflowId" | "enabledBuiltinWorkflowIds"> = {};
  try {
    const loaded = await store.getSettings();
    if (loaded) settings = loaded;
  } catch {
    // A degraded settings read still permits explicit task assignments to render.
  }
  /*
  FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
  Board metadata uses the same effective default as task creation. The catalog
  Coding id is only the fallback identity; it is never injected when project
  enablement has selected another built-in.
  */
  const defaultWorkflowId = resolveEffectiveDefaultWorkflowId(
    settings.defaultWorkflowId,
    settings.enabledBuiltinWorkflowIds,
  );

  const taskWorkflowIds: Record<string, string> = {};
  const referenced = new Set<string>();
  const selectableWorkflowIds = new Set<string>([defaultWorkflowId]);

  /*
  FNXC:BoardLoad 2026-09-11-21:12:
  Board metadata must resolve task workflow selections in ONE query. This loop
  awaited one selection read per card, so a 65-card board paid N+1 round-trips
  before rendering: measured 12-25s on the deployed 0.78.0-beta.4 dashboard for
  GET /tasks/board-workflows while its two sibling list reads answered in <1s.
  That serial fan-out — amplified by GC pressure under heap saturation — is what
  made the board look unable to load at all.

  FNXC:BoardWorkflowsCost 2026-11-09-11:35 (RUFU-906):
  The per-card resolution now runs through core's own `prefetchWorkflowSelections` seam instead of a
  dashboard-local copy of it. That seam is what every other multi-row read pass already uses
  (`listTasks` hydration, `resolveWorkflowIrForTask`, the hold-release sweep): one `inArray` batch fills
  the caller-owned cache, a card with NO selection row is cached as `undefined` — a cached absence is
  what stops the N+1 — and ids already in the cache are not read again. After the prefetch the per-card
  leg is a `Map.get` with zero awaits, the same property `createCachedWorkflowIrReader` exists for.

  Measured at production shape (`board-workflows-cost.test.ts`, `FUSION_BOARD_WORKFLOWS_BENCH=1`): the
  whole payload builder costs 8.07 / 0.67 / 0.53 us per card at 100 / 1 000 / 5 000 cards — 2.6 ms total
  for 5 000 cards — with ONE batched selection read and ZERO per-workflow definition reads at every
  size. Per-card resolution was already flat and is NOT what saturated the loop; request repetition
  across 8 dashboard tabs and the whole-table id enumeration in front of this function are. That
  measurement is why this slice reuses the seam rather than inventing a per-card fast path.

  Zero ids still means zero selections to resolve (`scope=lanes`): the seam returns
  `{ batched: 0, singles: 0 }` before touching the store, so no `IN ()` over an empty list is issued.
  A failed batch or a store predating the batched reader returns `batched: 0, singles: N` and keeps the
  pre-existing per-card fallback below; ids absent from the batch fall back to the effective default
  exactly as before, so a degraded read degrades CARDS to the default rather than failing the board load.
  */
  const passSelections: WorkflowSelectionCache = selectionCache ?? new Map();
  const selectionReads = await prefetchWorkflowSelections(store, taskIds, passSelections);
  if (selectionReads.batched === 0 && selectionReads.singles > 0) {
    /*
    FNXC:BoardLoad 2026-10-06-18:55 (RUFU-585):
    The degenerate branch awaited ONE selection read per card inside the loop, so a
    board of N cards paid N serial round-trips on the request path. Characterized
    against a counting store: 120 cards with no batched reader produced 120 awaited
    selection reads. The batched reader is still preferred whenever the store
    exposes it (that path stays exactly one query); this change only removes the
    serial fan-out from the fallback, so an older/partial store degrades by read
    COUNT, never by serial LATENCY.
    */
    await mapWithLimit(taskIds, SELECTION_READ_CONCURRENCY, async (taskId): Promise<void> => {
      if (passSelections.has(taskId)) return;
      try {
        const selection = store.getTaskWorkflowSelectionAsync
          ? await store.getTaskWorkflowSelectionAsync(taskId)
          : store.getTaskWorkflowSelection(taskId);
        passSelections.set(taskId, selection ? { workflowId: selection.workflowId, stepIds: [] } : undefined);
      } catch {
        // An unreadable selection resolves to the effective default, as a failed batch always has.
        passSelections.set(taskId, undefined);
      }
    });
  }

  for (const taskId of taskIds) {
    const workflowId = passSelections.get(taskId)?.workflowId ?? defaultWorkflowId;
    taskWorkflowIds[taskId] = workflowId;
    referenced.add(workflowId);
  }

  // The effective default is always describable so a no-task board still
  // resolves it and the client has one authoritative selectable lane.
  referenced.add(defaultWorkflowId);

  let catalog: readonly WorkflowDefinition[] = workflowCatalog ?? [];
  if (workflowCatalog === undefined) {
    try {
      catalog = await store.listWorkflowDefinitions();
    } catch (err) {
      // Older/partial test stores may not expose definition listing; the referenced
      // workflow set above is still sufficient for task rendering. Production
      // failures are logged so empty workflow definitions do not disappear silently.
      severityAuditLog.warn("[board-workflows] listWorkflowDefinitions failed; using referenced workflows only", err);
      catalog = [];
    }
  }

  const catalogById = new Map<string, WorkflowDefinition>();
  for (const definition of catalog) {
    if (definition.kind === "fragment") continue;
    selectableWorkflowIds.add(definition.id);
    referenced.add(definition.id);
    catalogById.set(definition.id, definition);
  }

  /*
  FNXC:BoardLoad 2026-10-06-18:55 (RUFU-585):
  Describing a workflow compiles its IR (`resolveWorkflowIrById`), which is the
  expensive half of this payload — measured as the slowest remaining board
  request (13.2 s / 14.2 s for an 11 KB response, second call 10.3 s, so nothing
  is cached across requests). Each referenced workflow is independent, so the
  serial `for … await` made the request cost the SUM of every IR build instead of
  the slowest one. Cross-request caching is deliberately NOT added here: prompt
  overrides are project-scoped and a stale IR would silently render wrong lanes,
  so the invalidation seam belongs at the definition-write path, not at this
  read path.

  FNXC:BoardWorkflows 2026-11-07-12:41 (RUFU-871):
  The concurrency bound stays, but it is no longer what keeps this off the critical path.
  Describing from the catalog row means the fan-out issues ZERO reads for every workflow the catalog
  listed, so the request stops paying one round trip per workflow. Measured live, the 11 described
  workflows cost 11 of the route's ~20 awaited reads (9 single-row `getWorkflowPromptOverridesAsync`
  plus 2 `getWorkflowDefinition`), and with the process's 3-connection pool saturated that is most
  of the request. `mapWithLimit` now only wraps the workflows a card selected that the catalog does
  NOT list (a deleted custom workflow), which is where one read per workflow is still honest.
  */
  const workflows = await mapWithLimit(
    [...referenced],
    WORKFLOW_DESCRIBE_CONCURRENCY,
    (workflowId) => describeWorkflow(
      store,
      workflowId,
      selectableWorkflowIds.has(workflowId),
      catalogById.get(workflowId),
    ),
  );

  return {
    flagEnabled,
    defaultWorkflowId,
    workflows,
    taskWorkflowIds,
  };
}
