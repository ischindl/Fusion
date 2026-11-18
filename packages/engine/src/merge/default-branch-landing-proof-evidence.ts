/*
FNXC:DefaultBranchLandingProof 2026-11-05-16:44 (RUFU-702):
The engine-side half of the landing proof: it resolves the integration branch from the repository and
project settings, runs the shared probes over an async `execFileAsync` runner (never `execSync` — the
engine blocking-shellout rule), and makes a refusal durable. The probes and the decision themselves live in
`@fusion/core` so the core merge door (`mergeTaskImpl`) asks with the identical instrument; nothing in this
file re-implements either.

Two properties carry the whole card and are stated again at the seam that must not violate them:

**The yardstick is the resolved integration branch, never `mergeDetails.mergeTargetBranch`.** RUFU-294's
row said `mergeTargetBranch: "fusion/rufu-293"` — its own sibling branch — and the neighbouring
zero-commit door was handed exactly that field (`mergeDetails.mergeTargetBranch` at the finalize seam), so
it faithfully measured the branch-ref advance it was being asked to validate. A durability proof measured
against the claim it exists to test is how a card with 238 conflicts against `main`, whose two named test
files do not exist on `main`, reached `done`.

**An unreadable repository is a deferral, never a refusal.** A bare repo, a mid-rebase worktree, a board
with no `origin/HEAD`, or a checkout this process cannot inspect must not fabricate a delivery failure on
every card it hosts; deferral preserves today's behavior and records a diagnostic row instead.
*/

import {
  createArgvGitLandingRunner,
  describeDefaultBranchLandingRefusal,
  LANDING_PROOF_UNPROVEN_ERROR_PREFIX,
  measureDefaultBranchLandingProofWithRunner,
  resolveTaskLandingPrVehicleOpen,
  type DefaultBranchLandingProofObservation,
  type LandingProofGitRunner,
} from "@fusion/core";
import type { DASHBOARD_USER_ID, MessageCreateInput, MessageStore, MergeDetails, Task, TaskStore } from "@fusion/core";
import { deliverMailboxMessageOnce } from "../notification/mailbox-delivery.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type DatabaseMutationType } from "../util/run-audit.js";
import { resolveIntegrationBranch, type IntegrationBranchSettings } from "./integration-branch.js";

/*
FNXC:DefaultBranchLandingProof 2026-11-17-20:23 (RUFU-702, code-review P0):
The engine used to own a private `execFileAsync` runner while core's door rebuilt the same probes as a shell
string, and every review round that read the engine copy concluded the contract held. Both lanes now inject
`createArgvGitLandingRunner` (same 15 s bound, same 4 MiB read bound, argv with no shell), so there is one
executor to audit rather than two that can drift. The type stays imported because a test injects a fake.
*/
function gitRunner(repoDir: string): LandingProofGitRunner {
  return createArgvGitLandingRunner({ cwd: repoDir });
}

export type DefaultBranchLandingProofMeasurement = DefaultBranchLandingProofObservation;

export interface DefaultBranchLandingProofProbeInput {
  /** Repository the branch lives in — the SUB-REPO root for one workspace repository. */
  repoDir: string;
  settings?: IntegrationBranchSettings;
  mergeDetails?: MergeDetails | null;
  /** Overrides the resolver (tests, or a caller that already resolved it). */
  integrationBranch?: string;
  prNumber?: number | null;
  prStateOpen?: boolean;
  squashRecordedOnIntegration?: boolean;
  /** Workspace per-repo results (the aggregate card); omit for a singular repository. */
  workspaceRepoLanding?: Record<string, "proven" | "absent" | "unreadable">;
}

/** Resolve the integration branch, then read every fact the decision needs. Never guesses, never refuses. */
export async function measureDefaultBranchLandingProof(
  input: DefaultBranchLandingProofProbeInput,
): Promise<DefaultBranchLandingProofMeasurement> {
  const mergeDetails = input.mergeDetails ?? null;
  const integrationBranch = (input.integrationBranch?.trim()
    || await resolveIntegrationBranch(input.repoDir, input.settings, { logger: { warn: () => undefined } })).trim();

  return measureDefaultBranchLandingProofWithRunner({
    runGit: gitRunner(input.repoDir),
    integrationBranch,
    recordedSha: mergeDetails?.commitSha ?? null,
    landedBranchTipSha: mergeDetails?.landedBranchTipSha ?? null,
    mergeTargetBranch: mergeDetails?.mergeTargetBranch ?? null,
    mergeTargetSource: mergeDetails?.mergeTargetSource ?? null,
    prNumber: typeof input.prNumber === "number" ? input.prNumber : mergeDetails?.prNumber ?? null,
    prStateOpen: input.prStateOpen === true,
    squashRecordedOnIntegration: input.squashRecordedOnIntegration === true,
    workspaceRepoLanding: input.workspaceRepoLanding,
    noOpVerified: mergeDetails?.noOpVerifiedShortCircuit === true,
    reportsNoOp: mergeDetails?.noOpMerge === true,
  });
}

/*
FNXC:DefaultBranchLandingProof 2026-11-05-16:44 (RUFU-702):
The door a landing authority asks before it may write `mergeDetails` or move `in-review → done`.

A refusal is a WAIT, mirroring the zero-commit guard beside it: no `status` is written and `mergeRetries`
is untouched, so a card cannot be rendered `merge-failed` or spend a budget on a measurement it did not
fail. What IS written is durable and operator-visible without a DB query: one History row carrying the
fixed sentence with its reason code, a machine-matchable `error` prefix the existing recovery lanes can
match alongside `DELIVERY_UNPROVEN:`, one bounded run-audit row, and one idempotent mailbox notice per
episode. The audit row is written before the mailbox hand-off so a mailbox outage still leaves the finding
countable.
*/
export type DefaultBranchLandingDoorSource =
  | "finalize-proven-auto-merge"
  | "ai-merge-finalize"
  | "merge-runner"
  | "self-healing-landed-reconcile"
  /*
  FNXC:DefaultBranchLandingProof 2026-11-17-19:28 (RUFU-702, code-review P2):
  The shared self-healing complete-lane mover. It is a landing authority in its own right — it carries
  `mergeDetails` and performs the terminal `moveTask` — and seven recovery arms reach `done` through it,
  two of them with a `baseBranch` whose non-group fallback (`task.baseBranch ||
  task.executionStartBranch || projectDefaultBranch`) can itself name a Fusion task branch. Before this
  source existed the mover moved first and never asked, so an owned-but-not-on-main commit finalized a
  card through a door this card had not closed.
  */
  | "self-healing-complete-lane-move";

export interface DefaultBranchLandingDoorInput extends DefaultBranchLandingProofProbeInput {
  store: TaskStore;
  task: Task;
  source: DefaultBranchLandingDoorSource;
  /*
  Optional by design, matching `FinalizeProvenAutoMergeTaskOptions.messageStore`: the mailbox lives on
  `MessageStore`, which `TaskStore` does not expose. A door with no mailbox still writes the History row
  and the audit row, and `deliverMailboxMessageOnce` reports `unavailable` instead of failing the merge.
  */
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
}

export type DefaultBranchLandingDoorOutcome =
  | { disposition: "proven"; measurement: DefaultBranchLandingProofMeasurement }
  | { disposition: "deferred"; measurement: DefaultBranchLandingProofMeasurement; reason: string }
  | { disposition: "refused"; measurement: DefaultBranchLandingProofMeasurement; refusalCode: string; refusal: string };

/** Cooldown for one unproven landing being re-announced to the operator; reuses the wedge-sized window. */
export const LANDING_PROOF_NOTICE_COOLDOWN_MS = 6 * 60 * 60_000;

/** Idempotency key for the operator notice: one delivery per (card, refusal code, cooldown bucket). */
export function landingProofNoticeKey(taskId: string, refusalCode: string, now: number): string {
  const bucket = Math.floor(now / LANDING_PROOF_NOTICE_COOLDOWN_MS);
  return `system:landing-proof-unproven:${taskId}:${refusalCode}:${bucket}`;
}

function emitLandingProofAudit(
  store: TaskStore,
  taskId: string,
  mutationType: DatabaseMutationType,
  metadata: Record<string, unknown>,
): void {
  // FN-9175 bounded seam: telemetry must never become a lifecycle dependency of a delivery decision.
  emitBoundedRunAudit(store, {
    taskId,
    agentId: "merger",
    runId: generateSyntheticRunId(`landing-proof-${mutationType.split(":")[1] ?? "row"}`, taskId),
    domain: "git",
    mutationType,
    target: taskId,
    metadata,
  });
}

async function logDoorEvent(
  store: TaskStore,
  taskId: string,
  source: DefaultBranchLandingDoorSource,
  action: string,
  measurement: DefaultBranchLandingProofMeasurement,
  detail?: string,
): Promise<void> {
  try {
    await store.logEntry(
      taskId,
      `[${source}] ${action} integration=${measurement.integrationBranch} ancestry=${measurement.ancestryOutcome}`
      + ` patch=${measurement.patchEquivalentOutcome}${detail ? ` — ${detail}` : ""}`,
    );
  } catch {
    // Telemetry never changes a merge decision.
  }
}

export async function enforceDefaultBranchLandingProof(
  input: DefaultBranchLandingDoorInput,
): Promise<DefaultBranchLandingDoorOutcome> {
  /*
  Resolve the PR vehicle unless the caller already answered it. A caller that passes `false` explicitly is
  saying "this is a direct merge" and is believed; a caller that omits it is asking the door to look.
  */
  const resolvedInput: DefaultBranchLandingDoorInput = input.prStateOpen === undefined
    ? {
      ...input,
      prStateOpen: await resolveTaskLandingPrVehicleOpen(
        input.store,
        input.task,
        input.mergeDetails?.mergeTargetSource ?? input.task.mergeDetails?.mergeTargetSource ?? null,
        typeof input.prNumber === "number" ? input.prNumber : input.mergeDetails?.prNumber ?? null,
      ),
    }
    : input;
  const measurement = await measureDefaultBranchLandingProof(resolvedInput);
  const mergeDetails = resolvedInput.mergeDetails ?? resolvedInput.task.mergeDetails ?? null;
  const recordedSha = mergeDetails?.commitSha?.trim() || mergeDetails?.landedBranchTipSha?.trim() || null;
  const verdict = measurement.verdict;

  if (verdict.disposition === "proven") {
    return { disposition: "proven", measurement };
  }

  if (verdict.disposition === "deferred") {
    emitLandingProofAudit(input.store, input.task.id, "task:finalization-landing-proof-deferred", {
      taskId: input.task.id,
      source: input.source,
      integrationBranch: measurement.integrationBranch,
      integrationRefReadable: measurement.integrationRefReadable,
      recordedSha,
      reason: verdict.reason,
    });
    await logDoorEvent(input.store, input.task.id, input.source, `DEFERRED (${verdict.reason})`, measurement);
    return { disposition: "deferred", measurement, reason: verdict.reason };
  }

  const refusal = describeDefaultBranchLandingRefusal(verdict, {
    taskId: input.task.id,
    integrationBranch: measurement.integrationBranch,
    recordedSha,
  });

  /*
  The row states its own hold on its face, and `error` carries the machine-matchable prefix so the same
  recovery lanes that match `DELIVERY_UNPROVEN:` can find it. `status` is deliberately untouched: a
  refusal is not a merge failure, and writing one would burn the retry budget and render the card
  `merge-failed` over a git fact.
  */
  try {
    await input.store.updateTask(input.task.id, { error: `${LANDING_PROOF_UNPROVEN_ERROR_PREFIX} ${refusal}` });
  } catch {
    // A row write that fails must not turn into a false `proven`; the refusal is still returned.
  }
  await logDoorEvent(input.store, input.task.id, input.source, `REFUSED (${verdict.refusalCode})`, measurement, refusal);
  emitLandingProofAudit(input.store, input.task.id, "task:finalization-landing-proof-refused", {
    taskId: input.task.id,
    source: input.source,
    integrationBranch: measurement.integrationBranch,
    recordedSha,
    refusalCode: verdict.refusalCode,
    conflictCount: measurement.conflictCount,
    ancestryOutcome: measurement.ancestryOutcome,
    patchEquivalentOutcome: measurement.patchEquivalentOutcome,
  });

  const noticeInput: MessageCreateInput = {
    fromId: "system",
    fromType: "system",
    toId: "dashboard-user" as typeof DASHBOARD_USER_ID,
    toType: "user",
    type: "system",
    content: `${refusal}\n\nLanding-proof door: \`${input.source}\` · measured ${new Date().toISOString()}`,
    metadata: {
      kind: "landing-proof-unproven",
      taskId: input.task.id,
      refusalCode: verdict.refusalCode,
      integrationBranch: measurement.integrationBranch,
      recordedSha,
      conflictCount: measurement.conflictCount,
      source: input.source,
    },
  };
  await deliverMailboxMessageOnce(
    input.messageStore ?? undefined,
    noticeInput,
    landingProofNoticeKey(input.task.id, verdict.refusalCode, Date.now()),
  );

  return { disposition: "refused", measurement, refusalCode: verdict.refusalCode, refusal };
}

/** Whether a row's error is this door's own hold, so recovery lanes can recognize and clear it. */
export function isDefaultBranchLandingProofHold(task: Pick<Task, "error">): boolean {
  return typeof task.error === "string" && task.error.startsWith(LANDING_PROOF_UNPROVEN_ERROR_PREFIX);
}

/*
FNXC:DefaultBranchLandingProof 2026-11-17-19:28 (RUFU-702, code-review P2):
The clear is CAS-fenced on the LIVE row rather than on the caller's snapshot, and it reports whether it
actually cleared. Two reasons, both measured on this card:
- The row is written by the merge lane, the mover, and the census, so a snapshot read can be stale by the
  time the clear lands; clearing on a stale snapshot would erase a hold a different lane re-armed.
- Every caller must be able to tell "nothing to clear" from "cleared" and from "refused to clear": the
  census only writes its History line and its audit row on a real clear, and a mover must not announce a
  repair it did not perform.
A store without `updateTaskAtomic` keeps the plain write, which is what the pre-CAS callers already had.
*/
export async function clearDefaultBranchLandingProofHold(
  store: TaskStore,
  task: Pick<Task, "id" | "error">,
): Promise<boolean> {
  if (!isDefaultBranchLandingProofHold(task)) return false;
  let cleared = false;
  try {
    if (typeof store.updateTaskAtomic === "function") {
      await store.updateTaskAtomic(task.id, (live) => {
        if (!isDefaultBranchLandingProofHold(live)) return null;
        cleared = true;
        return { error: null };
      });
    } else {
      await store.updateTask(task.id, { error: null });
      cleared = true;
    }
  } catch {
    // A failed clear leaves the hold standing, which is the honest outcome; it never becomes a false clear.
    return false;
  }
  return cleared;
}

export { LANDING_PROOF_UNPROVEN_ERROR_PREFIX };
