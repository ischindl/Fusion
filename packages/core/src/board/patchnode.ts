import type { Task } from "../types/task/task-core.js";
import type { PatchnodeDay, PatchnodeEntry, PatchnodeEntryKind } from "../types/task/patchnode.js";
import { extractPatchnodeProductSummary } from "./patchnode-product-summary.js";
import { deriveTaskLabelFromDescription, isHeadingShapedTaskTitle, MAX_TASK_LABEL_LENGTH } from "../ai/ai-summarize.js";

/*
FNXC:PatchnodeLedger 2026-08-28-12:16:
Patchnode is durable rather than derived because task history can be edited or soft-deleted after delivery. UTC day grouping matches DailyActivity so storage, API, chat, and dashboard assign every delivery to the same date.

FNXC:PatchnodeLedger 2026-08-28-12:16:
Title and body are denormalized point-in-time snapshots because later task updates can rewrite delivery evidence. Identity includes the delivery occurrence rather than only the task, so every re-delivery remains visible. All capture paths must use this one builder or retries and backlog repair can multiply one delivery into different rows.
*/

export function toPatchnodeDay(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : iso.trim().slice(0, 10);
}

export function toPatchnodeOccurrenceKey(iso: string): string {
  const normalized = iso.trim();
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? String(timestamp) : normalized;
}

export function buildPatchnodeEntryId(kind: PatchnodeEntryKind, taskId: string, occurrenceKey: string): string {
  return `${kind}:${taskId}:${occurrenceKey}`;
}

/**
 * Budget for the ledger label derived from a description when no title is stored.
 *
 * FNXC:PatchnodeLedger 2026-09-15-23:26:
 * FN-444 mirrors `MAX_DESCRIPTION_FALLBACK_LENGTH` from the dashboard's FN-391 projection
 * (`packages/dashboard/app/utils/taskTitleDisplay.ts`): 220 characters, no ellipsis and no suffix.
 *
 * FNXC:TaskTitleDerivation 2026-09-26-02:28:
 * RUFU-295 keeps the budget and stops sourcing it from a raw slice: it is now core's
 * `MAX_TASK_LABEL_LENGTH`, the same budget the durable title write guard collapses into, so the
 * ledger, the persisted title fallback, and the dashboard card cannot disagree about what a
 * description "says".
 */
export const PATCHNODE_DESCRIPTION_LABEL_LENGTH = MAX_TASK_LABEL_LENGTH;

type PatchnodeLabelInput = { id: string; title?: string | null; description?: string | null };

/**
 * Canonical delivery label for a ledger entry.
 *
 * FNXC:PatchnodeLedger 2026-09-15-23:26:
 * FN-444: `Task.title` is OPTIONAL and FN-391 deliberately removed every title backfill, so an
 * ordinary Fusion task stores no title at all and its on-screen label is derived by
 * `getTaskTitleDisplay`. The ledger previously fell straight from a blank title to the task id, so
 * every titleless delivery persisted `title === taskId` and the History card rendered the identifier
 * twice (metadata chip + bold line). This helper applies the same precedence so the durable snapshot
 * carries the label an operator actually recognises.
 *
 * FNXC:TaskTitleDerivation 2026-09-26-02:28:
 * This replaces the old note that said the rule was "DUPLICATED rather than imported" because core
 * cannot depend on the dashboard. That package-boundary fact still explains why the dashboard keeps
 * its own copy of the derivation (`packages/dashboard/app/utils/taskTitleDerivation.ts`, pinned by a
 * three-way parity test), but it never justified what happened HERE: this builder sliced the raw
 * first 220 characters off the description, so a spec-shaped description froze `## Pôvodný popis` —
 * or a whole multi-line markdown body — into a permanent History row that no repair pass could reach
 * (its admission was `title = task_id`). The ledger now runs the description through core's canonical
 * derivation, so the durable row agrees with the persisted title fallback by construction instead of
 * by convention. Precedence is unchanged: non-blank stored title → derived label → task id.
 */
export function buildPatchnodeSnapshotLabel(task: PatchnodeLabelInput): string {
  if (typeof task.title === "string" && task.title.trim().length > 0) return task.title;
  if (typeof task.description === "string" && task.description.trim().length > 0) {
    return deriveTaskLabelFromDescription(task.description, PATCHNODE_DESCRIPTION_LABEL_LENGTH);
  }
  return task.id.trim();
}

/*
FNXC:TaskTitleDerivation 2026-09-26-02:28:
Shapes the ledger must never carry as a label, exported as the admission rule for repairing rows that
are already persisted. FN-444's `title === task_id` missing-label marker is only ONE of them: a row
written before the derivation landed carries the raw first line of a spec, so a heading-shaped or
multi-line label is equally junk and equally permanent without a repair route. Anything else — a clean
one-line label, even one a later upstream reword has since superseded — is point-in-time history and
stays untouched.
*/
export function isPatchnodeJunkLabel(title: string | undefined | null): boolean {
  if (typeof title !== "string") return false;
  return isHeadingShapedTaskTitle(title) || /[\r\n]/.test(title.trim());
}

type PatchnodeTaskSnapshot = Pick<Task, "id" | "title" | "description" | "prompt">;

/*
FNXC:PatchnodeLedger 2026-09-15-23:26:
FN-444: `body` used to fall back to the title and then the id, which merely replaced one duplication
with another once the label was fixed — the card would have shown the label twice, or the id twice
for a task with neither title nor description. FN-444 reduced it to the point-in-time completion
summary ALONE. An empty string keeps the NOT NULL column satisfied and lets each read surface omit
the body row.

FNXC:PatchnodeLedger 2026-09-18-02:48:
FN-526 REPLACES that guarantee: the ledger body is now the plan's product summary
(`extractPatchnodeProductSummary`, `## What This Delivers` -> `## Before → After Transformation`),
never `task.summary`. The Completion Summary is a technical end-of-run report; under a History
delivery the operator wants to re-read what the task was meant to deliver. `task.summary` is
DELIBERATELY no longer read by this builder at all, and there is NO fallback to it: a plan with no
product section yields an empty body and the card shows no description line, which is the operator's
explicit request. Callers supply `prompt`; a missing or unreadable plan is simply `undefined`.
*/
export function buildPatchnodeEntryInput(
  task: PatchnodeTaskSnapshot,
  kind: PatchnodeEntryKind,
  occurredAt: string,
): PatchnodeEntry {
  const taskId = task.id.trim();
  const title = buildPatchnodeSnapshotLabel({ ...task, id: taskId });
  const body = extractPatchnodeProductSummary(task.prompt);
  const occurrenceKey = toPatchnodeOccurrenceKey(occurredAt);
  return {
    entryId: buildPatchnodeEntryId(kind, taskId, occurrenceKey),
    taskId,
    kind,
    occurrenceKey,
    day: toPatchnodeDay(occurredAt),
    occurredAt,
    title,
    body,
  };
}

export function groupPatchnodeEntriesByDay(entries: readonly PatchnodeEntry[]): PatchnodeDay[] {
  const sorted = [...entries].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return Number.isNaN(byTime) || byTime === 0 ? right.entryId.localeCompare(left.entryId) : byTime;
  });
  const grouped = new Map<string, PatchnodeEntry[]>();
  for (const entry of sorted) {
    const dayEntries = grouped.get(entry.day) ?? [];
    dayEntries.push(entry);
    grouped.set(entry.day, dayEntries);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([day, dayEntries]) => ({
      day,
      entries: dayEntries,
      completedCount: dayEntries.filter((entry) => entry.kind === "completed").length,
      revertedCount: dayEntries.filter((entry) => entry.kind === "reverted").length,
    }));
}

export function matchesPatchnodeQuery(entry: PatchnodeEntry, query: string | undefined): boolean {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.taskId, entry.title, entry.body].some((value) => value.toLocaleLowerCase().includes(needle));
}
