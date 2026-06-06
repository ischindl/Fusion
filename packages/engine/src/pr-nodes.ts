// PR node handlers for the unified PR-entity review loop (U3).
//
// Three first-class node kinds whose handlers own the PR side effects and emit
// outcomes the graph routes on:
//   - pr-create  : open (or reuse) the PR and write the entity to `open` /`failed`
//   - pr-respond : run the review-response loop body (U5 fills the real body;
//                  U3 delegates to an injected callback defaulting to a no-op)
//   - pr-merge   : tool-side merge with `expectedHeadOid` (reconcile, U4,
//                  corroborates the terminal `merged` write — the node never does)
//
// All handlers are idempotent, fast (no indefinite waits — those are holds, U4),
// and fail-closed. The engine NEVER imports the dashboard GitHubClient: every
// GitHub side effect is an injected callback wired from the CLI composition layer
// (mirroring how `createGroupPr`/`syncGroupPr` are wired). That keeps the engine
// free of the dashboard dependency (FN-3049: static imports only, no dashboard
// client) and unit-testable with fakes.

import {
  isPrEntityActionable,
  type PrEntity,
  type PrEntityCreateInput,
  type PrEntityUpdate,
  type TaskDetail,
  type WorkflowIrNode,
} from "@fusion/core";

import type { WorkflowNodeHandler } from "./workflow-graph-executor.js";

/**
 * The narrow slice of the store the PR node handlers need. Declared structurally
 * (not as the full `TaskStore`) so the engine stays decoupled from the concrete
 * store and the handlers stay trivially fakeable in tests.
 */
export interface PrNodeStore {
  /** Create-or-reuse the single non-terminal entity for a source (AE6 idempotency). */
  ensurePrEntityForSource(input: PrEntityCreateInput): PrEntity;
  getPrEntity(id: string): PrEntity | null;
  getActivePrEntityBySource(sourceType: PrEntity["sourceType"], sourceId: string): PrEntity | null;
  updatePrEntity(id: string, patch: PrEntityUpdate): PrEntity;
}

/** Identity of the PR an entity is created for, resolved from the task + node. */
export interface PrSourceDescriptor extends PrEntityCreateInput {}

/** Input for the injected `createPr` callback (the dashboard GitHubClient wrapper). */
export interface PrCreateCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
}

/** Result of a successful PR creation — the GitHub-mirror fields the node persists. */
export interface PrCreateCallResult {
  prNumber: number;
  prUrl: string;
  /** Resolved head commit OID, persisted so `pr-merge` can pass `expectedHeadOid`. */
  headOid?: string;
}

/** Input for the injected `mergePr` callback. */
export interface PrMergeCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
  /** The head OID the merge is gated on (defeats the push/merge race, U2/U6). */
  expectedHeadOid?: string;
}

/**
 * Discriminated result of the injected `mergePr` callback. The callback wraps the
 * dashboard `mergePr`, which throws `PrStaleHeadError` on a head-moved race; the
 * wrapper catches it and returns `{ status: "stale-head" }` so the engine never
 * imports the dashboard error class. Any other failure should be thrown so the
 * handler classifies it as a benign retryable outcome.
 */
export type PrMergeCallResult =
  | { status: "merged-requested" }
  | { status: "stale-head" };

/** Input for the injected `respond` callback (U5 implements the real body). */
export interface PrRespondCallInput {
  task: TaskDetail;
  node: WorkflowIrNode;
  entity: PrEntity;
  context: Record<string, unknown>;
}

/**
 * Result of the injected `respond` callback. `outcome` is the routing value the
 * `pr-respond` node emits (drives the bounded-rework edge back to await-review):
 *   - "fixed"          : a fix was pushed; loop back to await-review
 *   - "disagreed-only" : nothing actionable / all threads disagreed; leave open
 */
export interface PrRespondCallResult {
  value: "fixed" | "disagreed-only";
  contextPatch?: Record<string, unknown>;
}

/**
 * Dependencies the PR node handlers close over. All injected from the CLI
 * composition layer where importing the dashboard GitHubClient IS allowed; the
 * engine receives only plain callbacks + a structural store accessor.
 */
export interface PrNodeDeps {
  /** Structural store accessor (the engine already owns the store instance). */
  getStore(): PrNodeStore;
  /**
   * Resolve the PR source identity for a `pr-create` node from the task + node.
   * The CLI wiring derives sourceType/sourceId (task id or branch-group id),
   * repo, and head/base branch from the task's branch-naming + tracking config.
   */
  resolvePrSource(task: TaskDetail, node: WorkflowIrNode): Promise<PrSourceDescriptor> | PrSourceDescriptor;
  /** Open the PR on GitHub. Throws on failure (the node records `failed`). */
  createPr(input: PrCreateCallInput): Promise<PrCreateCallResult>;
  /** Merge the PR tool-side with `expectedHeadOid`. Returns a discriminated result. */
  mergePr(input: PrMergeCallInput): Promise<PrMergeCallResult>;
  /**
   * Run the review-response body (U5). Defaults to a no-op returning
   * `disagreed-only` when omitted, so U3 ships a routable-but-inert pr-respond.
   */
  respond?: (input: PrRespondCallInput) => Promise<PrRespondCallResult>;
  /** Optional audit sink, called with a stable reason on every routable failure. */
  audit?: (reason: string, detail: string) => void;
}

/**
 * The CLI-injected slice of {@link PrNodeDeps}: only the GitHub side-effect
 * callbacks (which close over the dashboard `GitHubClient`) plus the source
 * resolver and audit sink. The engine binds `getStore` itself (it owns the store
 * instance) via {@link buildPrNodeDeps}, so the CLI layer never needs a store
 * reference. Mirrors how `createGroupPr`/`syncGroupPr` are injected as plain
 * callbacks from the CLI composition layer.
 */
export interface PrNodeGithubOps {
  resolvePrSource: PrNodeDeps["resolvePrSource"];
  createPr: PrNodeDeps["createPr"];
  mergePr: PrNodeDeps["mergePr"];
  respond?: PrNodeDeps["respond"];
  audit?: PrNodeDeps["audit"];
}

/**
 * Assemble full {@link PrNodeDeps} from the engine-owned store + the CLI-injected
 * GitHub ops. Used by the runtime/executor wiring so the CLI layer stays free of
 * any store reference and the engine never imports the dashboard client.
 */
export function buildPrNodeDeps(getStore: () => PrNodeStore, ops: PrNodeGithubOps): PrNodeDeps {
  return {
    getStore,
    resolvePrSource: ops.resolvePrSource,
    createPr: ops.createPr,
    mergePr: ops.mergePr,
    respond: ops.respond,
    audit: ops.audit,
  };
}

function classifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the three PR node handlers from injected deps. Mirrors the seam-injection
 * pattern (`createStepReviewHandler` / `createParseStepsHandler`): the engine
 * graph layer stays engine-agnostic and unit-testable with fakes.
 */
export function createPrNodeHandlers(deps: PrNodeDeps): Record<
  "pr-create" | "pr-respond" | "pr-merge",
  WorkflowNodeHandler
> {
  const audit = (reason: string, detail: string): void => {
    try {
      deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  };

  // ── pr-create ──────────────────────────────────────────────────────────────
  // Ensure the entity in `creating`, call GitHub, flip to `open` on success or
  // `failed` (routable, NOT a thrown error) on failure. Re-entry on an already
  // open entity is a no-op emitting value:"open" (AE6 create-or-reuse idempotency).
  const prCreate: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();

    let source: PrSourceDescriptor;
    try {
      source = await deps.resolvePrSource(ctx.task, node);
    } catch (err) {
      const detail = `pr-create node '${node.id}' could not resolve PR source: ${classifyError(err)}`;
      audit("pr-create-source-error", detail);
      // No entity yet → fail closed with a routable outcome.
      return { outcome: "failure", value: "source-error" };
    }

    // Create-or-reuse the single live entity (the store enforces the partial
    // unique index, so re-entry never mints a second entity).
    const entity = store.ensurePrEntityForSource({
      ...source,
      state: source.state ?? "creating",
    });

    // Idempotent re-entry: an already-open entity with a persisted PR is a no-op.
    if (entity.state === "open" && entity.prNumber != null) {
      return { outcome: "success", value: "open" };
    }

    // Ensure the row is in `creating` before the side effect (so a crash mid-flight
    // leaves a recoverable state, not a stale `failed`).
    const creating = entity.state === "creating" ? entity : store.updatePrEntity(entity.id, { state: "creating" });

    let created: PrCreateCallResult;
    try {
      created = await deps.createPr({ task: ctx.task, node, entity: creating });
    } catch (err) {
      const reason = classifyError(err);
      audit("pr-create-failed", `pr-create node '${node.id}' creation failed: ${reason}`);
      // Failure is a ROUTABLE outcome — the graph routes on value:"failed". Record
      // the classified reason and the failed state; never throw.
      store.updatePrEntity(creating.id, { state: "failed", failureReason: reason });
      return { outcome: "success", value: "failed" };
    }

    store.updatePrEntity(creating.id, {
      state: "open",
      prNumber: created.prNumber,
      prUrl: created.prUrl,
      headOid: created.headOid ?? null,
    });
    return { outcome: "success", value: "open" };
  };

  // ── pr-merge ───────────────────────────────────────────────────────────────
  // Merge tool-side with `expectedHeadOid` from the entity. Does NOT write the
  // terminal `merged` state — the reconcile (U4) corroborates that from GitHub.
  // A stale-head race emits value:"stale-head" leaving the entity open; a clean
  // merge request emits value:"merged-requested".
  const prMerge: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();
    const entity = store.getActivePrEntityBySource("task", ctx.task.id)
      ?? store.getActivePrEntityBySource("branch-group", ctx.task.id);

    if (!entity) {
      audit("pr-merge-no-entity", `pr-merge node '${node.id}' found no live PR entity for task ${ctx.task.id}`);
      return { outcome: "failure", value: "no-entity" };
    }

    // Unverified entities (imported legacy state GitHub has not corroborated) are
    // a hard gate (R19): never merge on stale state — emit a benign outcome.
    if (!isPrEntityActionable(entity)) {
      audit("pr-merge-not-actionable", `pr-merge node '${node.id}' entity ${entity.id} not actionable (unverified/terminal)`);
      return { outcome: "success", value: "not-actionable" };
    }

    let result: PrMergeCallResult;
    try {
      result = await deps.mergePr({
        task: ctx.task,
        node,
        entity,
        expectedHeadOid: entity.headOid,
      });
    } catch (err) {
      // A non-stale merge error is benign/retryable — never throw out of the
      // handler, and never write `merged`. Route a routable failure value.
      const reason = classifyError(err);
      audit("pr-merge-error", `pr-merge node '${node.id}' merge failed: ${reason}`);
      return { outcome: "failure", value: "merge-error" };
    }

    if (result.status === "stale-head") {
      // The head moved since we read `expectedHeadOid`; leave the entity open so a
      // re-evaluation merges against the new head. Never write `merged`.
      return { outcome: "success", value: "stale-head" };
    }

    // Merge requested cleanly. Do NOT write `merged` here — reconcile corroborates.
    return { outcome: "success", value: "merged-requested" };
  };

  // ── pr-respond ─────────────────────────────────────────────────────────────
  // Delegate to the injected `respond` callback (U5 implements the real body).
  // Defaults to a no-op returning value:"disagreed-only". Increments the entity's
  // responseRounds (the R8 iteration-cap counter, survives restart).
  const prRespond: WorkflowNodeHandler = async (node, ctx) => {
    const store = deps.getStore();
    const entity = store.getActivePrEntityBySource("task", ctx.task.id)
      ?? store.getActivePrEntityBySource("branch-group", ctx.task.id);

    if (!entity) {
      audit("pr-respond-no-entity", `pr-respond node '${node.id}' found no live PR entity for task ${ctx.task.id}`);
      return { outcome: "failure", value: "no-entity" };
    }

    // Unverified/terminal entities are not responded to (R19 hard gate).
    if (!isPrEntityActionable(entity)) {
      audit("pr-respond-not-actionable", `pr-respond node '${node.id}' entity ${entity.id} not actionable (unverified/terminal)`);
      return { outcome: "success", value: "not-actionable" };
    }

    // Bump the rework-cycle counter (R8 cap backing; persisted).
    store.updatePrEntity(entity.id, { responseRounds: entity.responseRounds + 1 });

    if (!deps.respond) {
      // U3 default: inert but routable. U5 wires the real review-response run.
      return { outcome: "success", value: "disagreed-only" };
    }

    let result: PrRespondCallResult;
    try {
      result = await deps.respond({ task: ctx.task, node, entity, context: ctx.context });
    } catch (err) {
      const reason = classifyError(err);
      audit("pr-respond-error", `pr-respond node '${node.id}' response run failed: ${reason}`);
      return { outcome: "failure", value: "respond-error" };
    }

    return { outcome: "success", value: result.value, contextPatch: result.contextPatch };
  };

  return {
    "pr-create": prCreate,
    "pr-respond": prRespond,
    "pr-merge": prMerge,
  };
}
