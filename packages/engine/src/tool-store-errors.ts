/*
FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
The dependency guard in core is a durable board rule, and a rule delivered as an exception is not a
refusal — it is a dead agent turn. Measured fleet-wide 2026-10-04: 40 `task:dependency-cycle-rejected`
rows, every one `source=updateTask`, because `assertNoDependencyCycleImpl` throws *before* the write and
every dependency-writing tool let that throw escape its own boundary. This file is the one place that
turns those three deterministic dependency codes back into a tool result, so no lane re-authors the
wording and none re-detects a cycle the store already detected.
*/

import { DependencyCycleError } from "@fusion/core";

/*
FNXC:SharedStoreErrorShape 2026-09-23-06:00:
STAS-251. During the 2026-09-23 stall one database held every task but the pool could not
answer, and the tools turned that into two kinds of lie: "Task STAS-250 not found" for a card
that was alive (an agent rebuilt it), and "Step 7 → done" for a transition the store had
refused. Both read as successes because `AgentLogger` records `tool_error` only when a result
carries `isError`. Every tool that learns the store — not its data — stopped it now returns
one of these two results, so the agent can tell a card that is absent from a board it cannot
reach, and a step it closed from one it merely asked about.
*/

/** A step transition the store holds the authority to refuse, and what to do next. */
export const STEP_LIFECYCLE_GUIDANCE =
  "Nothing was persisted. A step moves pending → in-progress → done one transition at a time and never backwards; " +
  "find the step the frontier is actually on, move that one, and retry.";

/** The store is slow, unreachable, or past its boot deadline, so nothing was read or written. */
export const STORE_RETRY_GUIDANCE =
  "The board recorded nothing. Retry the call; if it fails again, report the failure instead of assuming the change landed.";

/* One line of failure text — a stack trace is noise to a model, not detail. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/*
FNXC:StoreQueryFailureAttribution 2026-10-16-04:30:
STAS-335. The board-read failure an agent actually saw was `Failed query: select "id","name",…
from project.agents where project_id = $1 order by …` — the whole statement and nothing about why.
That shape came from a query that ERRORED after the store had already booted, so it never reached the
boot seam's typed transient error and left the tool with no table, no SQLSTATE, and no way to tell a
read outage from a write outage. Measured against the live board the same query runs in 0.168 ms over
9 heap blocks, so cost was never the story — attribution was.

Drizzle wraps driver failures in `DrizzleQueryError`, which carries `query`, `params` and the original
`cause`. This reads `query` and `cause` STRUCTURALLY and deliberately never reads `params`: the bound
values are user content (task descriptions, credentials a task stored) and must not be copied into a
tool result or an agent log. Reading `cause.code` is what recovers the SQLSTATE the message throws away.
*/
/** What a store query failure can be attributed to, without repeating it. */
export interface StoreQueryAttribution {
  readonly table?: string;
  readonly statement?: string;
  readonly sqlState?: string;
}

/*
Identifiers are matched after the quoting is removed, so one pattern covers `"project"."agents"`,
`"tasks"` and `project.agents` without quote-pairing backreferences. An earlier two-optional-group form
backtracked and returned `"s"` for `"tasks"` — a confidently wrong table name, which is exactly the
failure mode this attribution exists to remove.
*/
const QUERY_TABLE = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?/i;
const STATEMENT_KIND = /^\s*"?([a-z]+)\b/i;

/** Extract table / statement kind / SQLSTATE from a store failure. Parameter values are never read. */
export function describeStoreQueryFailure(error: unknown): StoreQueryAttribution {
  const query = (error as { query?: unknown } | null)?.query;
  if (typeof query !== "string") return {};
  const statement = STATEMENT_KIND.exec(query)?.[1]?.toLowerCase();
  const match = QUERY_TABLE.exec(query.replaceAll(`"`, ""));
  // A qualified `schema.table` names the table in group 2; a bare name is group 1.
  const table = match?.[2] ?? match?.[1];
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const sqlState = typeof cause?.code === "string" ? cause.code : undefined;
  return {
    ...(table ? { table } : {}),
    ...(statement ? { statement } : {}),
    ...(sqlState ? { sqlState } : {}),
  };
}

/** The short suffix that names the attribution, or nothing when the failure carried no query. */
function attributionNote(attribution: StoreQueryAttribution): string {
  const parts = [
    attribution.statement ? `statement=${attribution.statement}` : "",
    attribution.table ? `table=${attribution.table}` : "",
    attribution.sqlState ? `sqlState=${attribution.sqlState}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `[${parts.join(" ")}] ` : "";
}

/**
 * The store failed a call. Not-found is excluded on purpose: a card that is genuinely absent
 * is a fact about the board, and reporting it in this shape would teach agents that an
 * outage made their work disappear.
 *
 * `operation` is explicit rather than inferred, because an agent must be able to tell the two
 * classes apart from the result alone: a read that failed lost nothing, a write that failed left
 * the board unchanged.
 */
export function storeErrorResult(what: string, error: unknown, operation: "read" | "write" = "read") {
  const attribution = describeStoreQueryFailure(error);
  return {
    content: [{
      type: "text" as const,
      text: `ERROR: ${what} did not reach the task store: ${reason(error)} ${attributionNote(attribution)}${STORE_RETRY_GUIDANCE}`,
    }],
    details: {
      code: "STORE_UNAVAILABLE",
      operation,
      ...(attribution.table ? { table: attribution.table } : {}),
      ...(attribution.statement ? { statement: attribution.statement } : {}),
      ...(attribution.sqlState ? { sqlState: attribution.sqlState } : {}),
    },
    isError: true,
  };
}

/**
 * A write failure. Usually the store was unreachable — say so and name the retry. But a store call can also
 * answer with a fact about the board: the row the write targeted is absent, or the write is refused there on
 * its merits. STAS-251 keeps those cases out of the retry shape on purpose — telling an agent to retry a
 * refusal teaches them to retry it, and an outage must never look like their work disappeared.
 */
export function storeWriteFailure(what: string, error: unknown) {
  const detail = reason(error);
  if (DOMAIN_PHRASE.test(detail)) {
    return storeRefusalResult(what, detail, "STORE_REFUSAL");
  }
  return storeErrorResult(what, error, "write");
}

/** How this repo's stores phrase a refusal on the merits: the row is absent, or the write is not allowed there. */
const DOMAIN_PHRASE = / (not found|does not exist|read-only)$/i;

/*
FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
`STORE_RETRY_GUIDANCE` is the right sentence for an outage and a wrong one for a rule: it says the board
recorded nothing and "Retry the call", which teaches an agent to re-propose the exact edge the board just
refused. A dependency refusal is deterministic — the same arguments always produce the same refusal — so
this guidance names the alternative actions instead. It never mentions retrying.
*/
/** What to tell an agent whose dependency edge a board rule refused, and what to do instead. */
export const DEPENDENCY_REFUSAL_GUIDANCE =
  "This edge was refused by the board's own dependency rule and nothing was persisted for it. "
  + "The board will refuse these same arguments again, so do not re-send them: choose a dependency that does not "
  + "close the loop, or park as blocked with the reason instead.";

/** The three dependency-domain refusals the store raises deterministically, keyed by their stable `code`. */
export type DependencyRefusalCode = "DEPENDENCY_CYCLE" | "SELF_SPAWNED_DEPENDENCY" | "SELF_DEFEATING_DEPENDENCY";

/** The refused edge, extracted once so the tool result and the planning-lane attribution never disagree about it. */
export interface DependencyRefusalFacts {
  readonly code: DependencyRefusalCode;
  /** The store's own one-line refusal sentence, forwarded verbatim. */
  readonly detail: string;
  /** Plain-text name of the refused edge, for a card log line and for the triage arm's message. */
  readonly summary: string;
  readonly cyclePath?: readonly string[];
  readonly taskId?: string;
  readonly dependencyId?: string;
  readonly taskTitle?: string;
  readonly matchedVerb?: string;
  readonly operandTaskId?: string;
}

/** The refused-edge vocabulary this composer owns; anything outside it stays the caller's to classify. */
const DEPENDENCY_REFUSAL_CODES: readonly DependencyRefusalCode[] = ["DEPENDENCY_CYCLE", "SELF_SPAWNED_DEPENDENCY", "SELF_DEFEATING_DEPENDENCY"];

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/*
FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
Classification keys on the stable `code` string, NOT on class identity, and that is a bundling
constraint rather than a style choice. `SelfSpawnedDependencyError` is exported from `@fusion/core`'s
main barrel but deliberately absent from `index.gate.ts`, the barrel the engine-core gate bundle
resolves, so an `instanceof` arm over all three classes would fail the merge gate while passing every
local run. `instanceof DependencyCycleError` is accepted as an ADDITIONAL signal only — it can widen
what is recognised, never narrow it, because `code` is checked first. A structurally-shaped error that
carries only `code` (the same class built against the other barrel) is therefore still a refusal.
*/
/**
 * Is this rejection a deterministic dependency-domain refusal, and which edge did it refuse?
 *
 * Returns `null` for everything else — an outage, a transient fault, an unrelated throw — so every call
 * site keeps its existing `storeWriteFailure` fallback instead of mislabelling an outage as a rule. The
 * three codes named in {@link DEPENDENCY_REFUSAL_CODES} are the whole recognised set.
 *
 * A refusal is followed through `cause` to a bounded depth: a planner session, a pi tool wrapper, or a
 * store facade can re-throw the board's refusal inside a generic `Error`, and a wrapped rule is still a
 * rule. `cause` is the only link followed and the first carrier wins, so an unrelated rejection is never
 * turned into a refusal by prose — the code has to be on something the thrower actually chained.
 */
export function dependencyDomainRefusal(error: unknown): DependencyRefusalFacts | null {
  let carrier: unknown = error;
  for (let depth = 0; carrier != null && depth <= MAX_DEPENDENCY_CAUSE_DEPTH; depth += 1) {
    const facts = dependencyRefusalFromCarrier(carrier);
    if (facts) return facts;
    carrier = (carrier as { cause?: unknown }).cause;
  }
  return null;
}

/** How far the `cause` walk goes before it gives up; a store refusal is never deeper than one wrapper. */
const MAX_DEPENDENCY_CAUSE_DEPTH = 4;

/**
 * Decide whether one carrier names a refused edge. The stable `code` decides; `instanceof DependencyCycleError`
 * is consulted only as a fallback, so it can widen what is recognised and never narrow it.
 */
function dependencyRefusalCode(declared: string | undefined, carrier: unknown): DependencyRefusalCode | null {
  if (declared && (DEPENDENCY_REFUSAL_CODES as readonly string[]).includes(declared)) {
    return declared as DependencyRefusalCode;
  }
  return carrier instanceof DependencyCycleError ? "DEPENDENCY_CYCLE" : null;
}

/** Classify ONE carrier of the chain; `null` means this link carries no dependency-domain code. */
function dependencyRefusalFromCarrier(error: unknown): DependencyRefusalFacts | null {
  const carrier = error as {
    code?: unknown;
    cyclePath?: unknown;
    taskId?: unknown;
    dependencyId?: unknown;
    taskTitle?: unknown;
    matchedVerb?: unknown;
    operandTaskId?: unknown;
  } | null;
  const declared = textField(carrier?.code);
  const code = dependencyRefusalCode(declared, error);
  if (!code) return null;

  const detail = reason(error);
  const rawCyclePath = carrier?.cyclePath;
  const cyclePath = Array.isArray(rawCyclePath)
    ? rawCyclePath.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const taskId = textField(carrier?.taskId);
  const dependencyId = textField(carrier?.dependencyId);
  const taskTitle = textField(carrier?.taskTitle);
  const matchedVerb = textField(carrier?.matchedVerb);
  const operandTaskId = textField(carrier?.operandTaskId);

  // The store's own sentence already names the loop; these branches only add a name when it did not.
  const summary = code === "DEPENDENCY_CYCLE"
    ? cyclePath && cyclePath.length > 0
      ? `refused dependency for ${taskId ?? "the task"}: ${cyclePath.join(" -> ")}`
      : detail
    : code === "SELF_SPAWNED_DEPENDENCY"
      ? dependencyId
        ? `refused dependency ${dependencyId} on ${taskId ?? "the task"} (self-spawned)`
        : detail
      : operandTaskId
        ? `refused dependency ${operandTaskId} for "${taskTitle ?? "the task"}" (matched verb "${matchedVerb ?? "unknown"}")`
        : detail;

  return {
    code,
    detail,
    summary,
    ...(cyclePath && cyclePath.length > 0 ? { cyclePath } : {}),
    ...(taskId ? { taskId } : {}),
    ...(dependencyId ? { dependencyId } : {}),
    ...(taskTitle ? { taskTitle } : {}),
    ...(matchedVerb ? { matchedVerb } : {}),
    ...(operandTaskId ? { operandTaskId } : {}),
  };
}

/*
FNXC:DependencyRefusal 2026-11-19-00:30 (RUFU-552):
STAS-258 rule 2 forbids a hand-composed store-outage message. The refusal wording lives here once and
`storeWriteFailure`'s domain arm calls the same composer, so a dependency refusal and a genuine
store refusal are the same shape differing only in `code` and in the guidance suffix.
*/
/** The one refusal result shape: the store's sentence, optionally followed by deterministic guidance. */
function storeRefusalResult(
  what: string,
  detail: string,
  code: string,
  opts?: { guidance?: string; extra?: Record<string, unknown> },
) {
  const guidance = opts?.guidance ? ` ${opts.guidance}` : "";
  return {
    content: [{ type: "text" as const, text: `ERROR: ${what} refused by the task store: ${detail}${guidance}` }],
    details: { code, ...(opts?.extra ?? {}) },
    isError: true,
  };
}

/**
 * The tool result for a refused dependency write, or `null` when this rejection is not a dependency
 * refusal and the caller must keep its existing store-outage handling.
 *
 * `what` names the half of the call the store refused, because a combined write (a step transition, a
 * title rename) can half-apply and the agent has to be able to tell the two halves apart from the
 * result alone.
 */
export function dependencyRefusalResult(what: string, error: unknown) {
  const facts = dependencyDomainRefusal(error);
  if (!facts) return null;
  const diagnostics: Record<string, unknown> = {};
  if (facts.cyclePath) diagnostics.cyclePath = facts.cyclePath;
  if (facts.taskId) diagnostics.taskId = facts.taskId;
  if (facts.dependencyId) diagnostics.dependencyId = facts.dependencyId;
  if (facts.operandTaskId) diagnostics.operandTaskId = facts.operandTaskId;
  if (facts.matchedVerb) diagnostics.matchedVerb = facts.matchedVerb;
  if (facts.taskTitle) diagnostics.taskTitle = facts.taskTitle;
  return storeRefusalResult(what, facts.detail, facts.code, {
    guidance: DEPENDENCY_REFUSAL_GUIDANCE,
    extra: diagnostics,
  });
}

/**
 * Record a refused dependency edge on the card's own agent log, best-effort.
 *
 * A refusal that only reaches the agent's tool result is half a record: the next session, the planner, and
 * an operator reading History see the card's dependency list unchanged with no explanation of why an agent
 * stopped proposing an edge. The write is never allowed to mask the refusal, so failures are swallowed here
 * and reported through `warn` — the caller must still return the refusal.
 */
export async function recordDependencyRefusal(
  facts: DependencyRefusalFacts,
  opts: {
    taskId: string;
    /** Site's own log seam, so each caller keeps the arity and run context its file already uses. */
    log: (taskId: string, action: string) => Promise<unknown>;
    /** What this call did NOT do, stated per-site: a step not transitioned, a run not aborted. */
    note?: string;
    warn?: (message: string) => void;
  },
): Promise<void> {
  const line = `Dependency write refused by the board's dependency rule - ${facts.summary}.${opts.note ? ` ${opts.note}` : ""}`;
  try {
    await opts.log(opts.taskId, line);
  } catch (logError) {
    opts.warn?.(`Failed to record a refused dependency edge on ${opts.taskId}: ${logError}`);
  }
}

/**
 * The store answered but kept the step on its old status — it refuses an out-of-order or
 * regressing transition by returning the task unchanged rather than throwing, so the returned
 * status is the only honest answer about what the board now holds.
 */
export function stepLifecycleNoopResult(opts: {
  stepIndex: number;
  stepName: string;
  requested: string;
  persisted: string;
  progress?: { done: number; total: number };
}) {
  const progressNote = opts.progress ? ` Progress: ${opts.progress.done}/${opts.progress.total} done.` : "";
  return {
    content: [{
      type: "text" as const,
      text: `Step ${opts.stepIndex} (${opts.stepName}) remains ${opts.persisted} — ${opts.requested} request ignored to preserve step lifecycle invariants. ${STEP_LIFECYCLE_GUIDANCE}${progressNote}`,
    }],
    details: {
      stepIndex: opts.stepIndex,
      requestedStatus: opts.requested,
      persistedStatus: opts.persisted,
      code: "STEP_LIFECYCLE_NOOP",
    },
    isError: true,
  };
}
