import {
  BUILTIN_WORKFLOWS,
  DEFAULT_WORKFLOW_ID,
  emitBoundedRunAudit,
  getPostMergeEvidenceGateStatuses,
  getRequiredPostMergeEvidenceDecision,
  isCompleteColumn,
  parseWorkflowIr,
  resolveColumnFlags,
  resolveCompleteColumnGateEvidence,
  type CompleteColumnGateFinding,
  type PostMergeEvidenceContract,
  type PostMergeProducerSurfaceObservation,
  type TaskStore,
  type Task,
  type WorkflowIr,
} from "@fusion/core";
import { resolvePostMergeEvidenceContract } from "../merge/post-merge-evidence-contract.js";
import { resolvePostMergeProducerSurface } from "../merge/post-merge-producer-surface.js";

/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
REPORT-ONLY detection for cards that are ALREADY miscompleted — a card standing in a complete-trait column
whose required gate evidence is refused or absent. RUFU-272 is the motivating card: landed `aa35098cc8`,
`column: done`, `mergeConfirmed: true`, and a durable `post-merge-verification / failed / REVISE` row that
could never retract the move. Measured across `.fusion/tasks` at 2026-09-27: 14 cards in that shape plus 7
more with the gate enabled and zero result rows.

Why reporting is the deliverable rather than repair. Lifecycle containment (FN-207/FN-217) forbids an
automatic backward move out of a terminal lane, and no verdict may be fabricated. `reconcileLandedReviewTask`
answers a `done` card carrying a post-merge evidence blocker with `{outcome:"ineligible", reason:
"not-in-review"}`, so no existing sweep names these cards at all — the operator's only signal was
`fn task reconcile` saying something false. This sweep therefore changes NOTHING about the card: no column
move, no status write, no pause, no step result, no continuation. It writes exactly three observations —
one run-audit row, one History line, one mailbox notice per window — so the operator decides.

Reuse over re-derive: the evidence verdict comes from `resolveCompleteColumnGateEvidence`, the ONE shipped
classifier (RUFU-406) that the store's move guard and the merge door also read. A second opinion here would
be a second truth about what "refused" means, which is the failure this whole task exists to remove.

FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
The classifier alone was blind to the LARGER half of the measured population. Its post-merge arm reports a
DURABLE NEGATIVE only — a `missing` post-merge row is deliberately never a finding there, because a card that
has not merged yet legitimately has no post-merge evidence and must not be refused entry to the very lane
where that evidence gets produced. That divergence is correct for the MOVE seam and wrong for a sweep that
only ever looks at cards that already stand in a complete column WITH durable landing proof: for those, the
absence IS the violation, and it is exactly the 7-of-21 shape (RUFU-263/248/232/230/229/226/205 — gate
enabled, ZERO result rows) this task was filed for. Mounting only the classifier therefore reported RUFU-272
(the card with the `failed / REVISE` row) and stayed silent about every card that never got a row at all.

The absence question already has a shipped owner, so this sweep asks IT instead of writing its own rule:
`getRequiredPostMergeEvidenceDecision` — the same ladder the auto-merge finalizer, the re-seed lane, and
three self-healing sites read. It answers `resumable` for state `missing` and stays silent for
`not-applicable`, which is what carries the RUFU-429 delivery-shape, RUFU-430 no-reporter, and RUFU-450
producer-unreachable exemptions into this sweep for free. Reporting a workspace card or a reporter-less
board's landed card would recreate RUFU-283's notice flood, so the exemptions are honoured rather than
re-derived here. The two authorities' findings are merged and de-duplicated per gate, and the MOVE-side
classifier is untouched — widening it would refuse node entry for a card that has not merged yet.
*/

/** Sweep registration name, shared by self-healing's registration and this module's log lines. */
export const COMPLETE_LANE_EVIDENCE_SWEEP_NAME = "reconcile-complete-lane-gate-evidence";

/** The run-audit mutation type for one reported card. Deliberately OUTSIDE the curated delivery-pipeline
 *  catalogue, which is locked table-for-table against docs/run-audit.md's curated rows; documented there in
 *  prose, exactly like RUFU-462's `runtime:heap-ceiling` and RUFU-279's `memory:*` trio. */
export const COMPLETE_LANE_EVIDENCE_FINDING_EVENT = "task:complete-lane-gate-evidence-finding";

/** Metadata key carrying this sweep's episode record on the card. Key-level patch only, never a whole-field
 *  write, so an unrelated `sourceMetadata` owner is never clobbered. */
export const COMPLETE_LANE_EVIDENCE_METADATA_KEY = "completeLaneEvidenceEpisode";

/*
An episode refresh floor. A sustained finding stays COUNTABLE without becoming a row flood: the measured
pre-fix rate for one wedged card under a polled sweep was one record per pass (RUFU-393), so the key is
time, not the pass.
*/
export const COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS = 15 * 60 * 1000;

export interface CompleteLaneEvidenceEpisode {
  /** `(state, lane, gateIds)` digest — the wait's identity. Deliberately excludes any counter, because a
   *  key that grows every cycle is the RUFU-442 defect (a bound whose identity changed each pass). */
  signature: string;
  state: CompleteColumnGateFinding["state"];
  lane: CompleteColumnGateFinding["lane"];
  gateIds: string[];
  firstAt: string;
  lastRecordedAt: string;
  recordCount: number;
}

export interface CompleteLaneEvidenceFinding {
  taskId: string;
  column: string;
  workflowId: string;
  findings: CompleteColumnGateFinding[];
  signature: string;
  /** The sweep's own clock, carried so the notice's UTC-day bucket is measured on the SAME clock the bounded
   *  episode used. A notice that read the wall clock while the sweep ran on an injected one could not have
   *  its dedupe window tested at all, and a back-dated pass would announce a future day. */
  now: number;
}

/** The complete-trait column ids a board can hold cards in, taken from every workflow definition it ships.
 *  Keys on the TRAIT, never on a `done`/`published` name literal, because marketing's terminal lane is
 *  `published` and a custom workflow may name it anything. */
export function collectCompleteColumnIds(irs: Iterable<WorkflowIr | undefined>): string[] {
  const ids = new Set<string>();
  for (const ir of irs) {
    if (!ir) continue;
    for (const column of (ir as { columns?: Array<{ id: string }> }).columns ?? []) {
      if (isCompleteColumn(resolveColumnFlags(column as never))) ids.add(column.id);
    }
  }
  return [...ids];
}

/** The episode identity for a card's refusing set, byte-stable across passes. */
export function completeLaneEvidenceSignature(
  taskId: string,
  findings: readonly CompleteColumnGateFinding[],
): string {
  const parts = findings
    .map((finding) => `${finding.lane}:${finding.gateId}:${finding.state}`)
    .sort()
    .join("|");
  return `${taskId}:${parts}`;
}

/** Decide whether a card's episode should be recorded on THIS pass: a new signature always, an unchanged
 *  one at most once per refresh floor. */
export function shouldRecordEpisode(
  episode: CompleteLaneEvidenceEpisode | undefined,
  signature: string,
  now: number,
  floorMs = COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS,
): boolean {
  if (!episode || episode.signature !== signature) return true;
  const last = Date.parse(episode.lastRecordedAt);
  return !Number.isFinite(last) || now - last >= floorMs;
}

/** Parse every workflow definition the board ships, built-ins first, tolerating one unreadable graph. */
async function resolveWorkflowIrs(store: TaskStore): Promise<Map<string, WorkflowIr>> {
  const irs = new Map<string, WorkflowIr>();
  for (const builtin of BUILTIN_WORKFLOWS) {
    if (!builtin.ir) continue;
    try {
      irs.set(builtin.id, typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir);
    } catch {
      // An unreadable built-in is a different defect with its own reporter; never mask the sweep.
    }
  }
  const listDefinitions = (store as unknown as {
    listWorkflowDefinitions?: (options?: { includeDisabledBuiltins?: boolean }) => Promise<
      Array<{ id: string; ir: string | WorkflowIr }>
    >;
  }).listWorkflowDefinitions?.bind(store);
  if (listDefinitions) {
    try {
      for (const definition of await listDefinitions({ includeDisabledBuiltins: true })) {
        if (irs.has(definition.id)) continue;
        try {
          irs.set(definition.id, typeof definition.ir === "string" ? parseWorkflowIr(definition.ir) : definition.ir);
        } catch {
          // A custom graph that fails to parse keeps its own error surface; nothing to report here.
        }
      }
    } catch {
      // A store that cannot enumerate definitions still covers every built-in lane.
    }
  }
  return irs;
}

/*
The requirement authority's two non-finalizable outcomes, typed structurally rather than by import: core
owns the discriminated union (`RequiredPostMergeEvidenceDecision`) but does not re-export it, and widening a
public surface is not this sweep's call. The shape is read, never re-derived — `getRequiredPostMergeEvidenceDecision`
is still the only place the outcome is decided.
*/
export type OwedPostMergeDecision =
  | { outcome: "resumable"; gateId: string }
  | { outcome: "blocked"; gateId: string; reason: string };

/** Map the requirement authority's outcome onto this sweep's finding-state enum (byte-compatible with the
 *  classifier's own vocabulary, so one History sentence covers both authorities). Exported so the mapping is
 *  pinned directly: every blocked reason except `pending`/`skipped` collapses onto `not-approved`, and a
 *  future reason added to the ladder must be judged rather than silently defaulting. */
export function postMergeFindingState(
  decision: OwedPostMergeDecision,
): CompleteColumnGateFinding["state"] {
  if (decision.outcome === "resumable") return "missing";
  switch (decision.reason) {
    case "pending":
      return "in-flight";
    case "skipped":
      return "unwaived-skip";
    // failed | not-approved | duplicate — a durable answer that is not an approval.
    default:
      return "not-approved";
  }
}

/** Sort exactly like the classifier does, so `findings[0]` means the same thing whichever authority wrote it. */
function sortFindings(findings: CompleteColumnGateFinding[]): CompleteColumnGateFinding[] {
  return findings.sort((a, b) =>
    a.lane === b.lane ? a.gateId.localeCompare(b.gateId) : a.lane === "pre-merge" ? -1 : 1,
  );
}

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
The post-merge absence half of a card's finding set. Two shipped facts decide its cost: the requirement
ladder is pure and synchronous, while the RUFU-450 producer-surface exemption rests on two git probes.
So the ladder is consulted FIRST without a surface (cheap), and the probes are paid for only on a card that
the contract-aware ladder already calls `missing` — a landed card whose gate approved, or whose requirement
is `not-applicable` by delivery shape or by a board with no CI reporter, never shells out at all.

An unavailable observation resolves `undefined`, which the core rule reads as "no verdict, keep the demand",
so an unreadable repository keeps reporting the card rather than quietly exempting it.
*/
export async function resolveOwedPostMergeFinding(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr,
  contract: PostMergeEvidenceContract | undefined,
  producerSurfaceFor: (task: Task) => Promise<PostMergeProducerSurfaceObservation | undefined>,
): Promise<CompleteColumnGateFinding | undefined> {
  let owesAbsence = false;
  try {
    owesAbsence = getPostMergeEvidenceGateStatuses(task, ir, contract).some((status) => status.state === "missing");
  } catch {
    return undefined;
  }
  if (!owesAbsence) return undefined;

  const surface = await producerSurfaceFor(task).catch(() => undefined);
  const decision = await getRequiredPostMergeEvidenceDecision(store, task, contract, surface).catch(() => null);
  if (!decision || decision.outcome === "finalizable") return undefined;
  return { gateId: decision.gateId, lane: "post-merge", state: postMergeFindingState(decision) };
}

export interface CompleteLaneEvidenceSweepSummary {
  findings: number;
  recorded: number;
  suppressed: number;
  cards: string[];
}

export interface CompleteLaneEvidenceSweepOptions {
  /** Injectable clock, for the bounded-episode legs. */
  now?: number;
  /** Mailbox half of the report. Injected so a mailbox outage cannot undo the durable record. */
  noticeFor?: (finding: CompleteLaneEvidenceFinding) => Promise<boolean>;
  /*
  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
  The two async inputs the post-merge requirement ladder needs, injectable for the same reason RUFU-430 and
  RUFU-450 made them injectable on their own lanes: the contract is a repo/secret read and the producer
  surface is two git probes. Production resolves them exactly as the auto-merge finalizer does — the
  contract once per pass (the resolver caches per project root), the surface per candidate card — and an
  unresolvable observation keeps the shipped demand rather than silently exempting the card.
  */
  contract?: PostMergeEvidenceContract;
  producerSurfaceFor?: (task: Task) => Promise<PostMergeProducerSurfaceObservation | undefined>;
}

/**
 * Enumerate cards sitting in a complete-trait column whose required gate evidence refuses or is still owed,
 * and record the ones this pass is allowed to record. Report-only: writes no column, status, pause, step
 * result, or continuation. Returns the pass summary; a sweep with nothing to report writes nothing.
 */
export async function reconcileCompleteLaneGateEvidence(
  store: TaskStore,
  options: CompleteLaneEvidenceSweepOptions = {},
): Promise<CompleteLaneEvidenceSweepSummary> {
  const now = options.now ?? Date.now();
  const summary: CompleteLaneEvidenceSweepSummary = { findings: 0, recorded: 0, suppressed: 0, cards: [] };

  const irs = await resolveWorkflowIrs(store);
  const completeColumns = collectCompleteColumnIds(irs.values());
  if (completeColumns.length === 0) return summary;

  /* Resolved once per pass, beside the lane enumeration — the same "one observation per pass" discipline
     the finalizer states for this contract, so every card on this pass is judged against one board fact. */
  const contract = options.contract
    ?? await resolvePostMergeEvidenceContract(store, { auditHost: store }).catch(() => undefined);
  const producerSurfaceFor = options.producerSurfaceFor
    ?? ((task: Task) => resolvePostMergeProducerSurface(store, task));

  for (const column of completeColumns) {
    let cards: Task[];
    try {
      // NOT slim: the classifier reads `enabledWorkflowSteps`, `workflowStepResults`, `executionMode`,
      // `humanPlanApproval`, and `workspaceWorktrees`, and a slim row silently reads as "no evidence".
      cards = await store.listTasks({ column });
    } catch {
      continue;
    }

    for (const task of cards) {
      /* The card's OWN workflow decides what it owes; the default IR is not a proxy for a custom one.
         But a card with NO selection row is not an unknown card -- it runs the project default workflow,
         which is exactly the shape every RUFU-272-era card had. Falling through there would have made this
         sweep blind to the entire population it exists to report. */
      const selection = await (store as unknown as {
        getTaskWorkflowSelectionAsync?: (id: string) => Promise<{ workflowId: string } | undefined>;
      }).getTaskWorkflowSelectionAsync?.(task.id);
      const workflowId = selection?.workflowId ?? DEFAULT_WORKFLOW_ID;
      const ir = irs.get(workflowId);
      if (!ir) continue;

      /*
      FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P0):
      The candidate predicate is a DURABLE LANDING, not a lane. A card standing in a complete column with no
      `mergeConfirmed` proof never delivered anything, so its problem is not "the operator must decide about
      landed work" — it is the shape RUFU-406's move guard and `getTaskMergeBlocker` already own, and those
      doors refuse it on every future move and record their own refusal. Reporting it here would put two
      authorities' sentences on one card for one cause, and would silently redefine this sweep's reported
      population away from the landed-and-unverified cards the measurement named (RUFU-272 landed `aa35098cc8`
      before it was reported). This is also the predicate the RUFU-450 exemption itself is gated on, so the
      sweep and the exemption answer the same question about the same card.
      */
      if (task.mergeDetails?.mergeConfirmed !== true) continue;

      const evidence = resolveCompleteColumnGateEvidence({ ir, task });
      const findings = [...evidence.findings];
      const postMergeOwed = await resolveOwedPostMergeFinding(store, task, ir, contract, producerSurfaceFor);
      if (postMergeOwed && !findings.some(
        (finding) => finding.lane === postMergeOwed.lane && finding.gateId === postMergeOwed.gateId,
      )) {
        findings.push(postMergeOwed);
      }
      sortFindings(findings);
      if (findings.length === 0) continue;

      summary.findings += 1;
      summary.cards.push(task.id);
      const first = findings[0];
      const signature = completeLaneEvidenceSignature(task.id, findings);
      const prior = (task.sourceMetadata as Record<string, unknown> | undefined)?.[
        COMPLETE_LANE_EVIDENCE_METADATA_KEY
      ] as CompleteLaneEvidenceEpisode | undefined;

      if (!shouldRecordEpisode(prior, signature, now)) {
        summary.suppressed += 1;
        continue;
      }

      const episode: CompleteLaneEvidenceEpisode = {
        signature,
        state: first.state,
        lane: first.lane,
        gateIds: findings.map((finding) => finding.gateId),
        firstAt: prior?.signature === signature ? prior.firstAt : new Date(now).toISOString(),
        lastRecordedAt: new Date(now).toISOString(),
        recordCount: (prior?.signature === signature ? prior.recordCount : 0) + 1,
      };

      /* The episode is the durable bind: it is what bounds the row, so an episode write that was refused
         must NOT be followed by an emission — otherwise the bound is decorative. */
      try {
        await store.updateTask(task.id, {
          sourceMetadataPatch: { [COMPLETE_LANE_EVIDENCE_METADATA_KEY]: episode },
        });
      } catch {
        summary.suppressed += 1;
        continue;
      }

      await emitBoundedRunAudit(store, {
        agentId: "self-healing",
        runId: `${COMPLETE_LANE_EVIDENCE_SWEEP_NAME}:${task.id}`,
        // The top-level `taskId` is what populates `run_audit_events.task_id`; without it the row exists
        // but cannot be found per card, which is the only query an operator has (RUFU-439's shape).
        taskId: task.id,
        mutationType: COMPLETE_LANE_EVIDENCE_FINDING_EVENT,
        target: `task:${task.id}`,
        metadata: {
          taskId: task.id,
          column,
          workflowId,
          lane: first.lane,
          state: first.state,
          gateCount: findings.length,
          recordCount: episode.recordCount,
          outcome: "reported",
        },
      });

      try {
        await store.logEntryOnce(task.id, {
          action: `Complete-lane evidence finding: ${findings
            .map((finding) => `'${finding.gateId}' (${finding.lane}, ${finding.state})`)
            .join(", ")} — the card sits in a complete column without approving evidence. Nothing was moved; an operator decision is required.`,
          dedupeKey: `${COMPLETE_LANE_EVIDENCE_SWEEP_NAME}:${signature}`,
          windowMs: COMPLETE_LANE_EVIDENCE_REFRESH_FLOOR_MS,
        });
      } catch {
        // A card without the once-seam still gets its audit row; the History line is the nicer surface.
      }

      summary.recorded += 1;

      if (options.noticeFor) {
        try {
          await options.noticeFor({
            taskId: task.id,
            column,
            workflowId,
            findings,
            signature,
            now,
          });
        } catch {
          // A mailbox outage cannot undo the durable record made above.
        }
      }
    }
  }

  return summary;
}
