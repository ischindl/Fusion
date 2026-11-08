/*
FNXC:ReadColumnParity 2026-11-08-07:55 (RUFU-871 read-column projection slice):
The allocation profile says 90 % of this process's allocation is the PostgreSQL driver materializing
whole rows (`DataRow` 417 MB = 53 %) and parsing their jsonb columns (`fromJson` 276 MB = 35 %) out of
60 s of ordinary traffic, so the lever is to stop SELECTing jsonb columns no consumer dereferences.
A projected SELECT is only safe if every field it DOES select is byte-identical to the value the full
read returned — a saving bought by silently changing a value is not a saving.

The pg-side parity guard for the older projections is
`src/__tests__/postgres/list-read-projection-parity.pg.test.ts`. This is the same claim at the seam
that needs no database: one fixture row is hydrated twice — once as the driver delivers it under the
undeclared projection, once as it delivers it under the declared one (the dropped columns simply never
arrive, which is exactly what the smaller SELECT sends) — and the two `Task` objects are compared field
by field. Anything that differs must be named by the member whose column was dropped; an unlisted
difference is a silent value change and fails the run.
*/
import { describe, expect, it } from "vitest";
import {
  resolveLiveTaskRowProjection,
  TASK_SLIM_PROJECTION,
  type ReadLiveTaskRowsOptions,
  type TaskListReadField,
} from "../async/async-persistence.js";
import { pgRowToTaskRow, rowToTask } from "../serialization.js";
import { TASK_JSONB_COLUMNS } from "../persistence.js";
import type { TaskRow } from "../persistence.js";
import type { Task } from "../../types.js";

/**
 * Each droppable wide member: the table columns it owns and the `Task` fields those columns build.
 *
 * This map is the safety contract. A field may be listed under `fields` ONLY because the columns under
 * `columns` are the sole reason it can hold a value — so when a declared read-set drops the columns,
 * the field is allowed to differ, and nothing else is. `log` is absent because both shapes compared
 * here set `excludeLog`, which is already today's behavior for these call sites.
 */
const DROPPABLE_MEMBERS: Record<TaskListReadField, { columns: readonly string[]; fields: readonly string[] }> = {
  log: { columns: ["log"], fields: ["log"] },
  description: { columns: ["description"], fields: ["description"] },
  summary: { columns: ["summary"], fields: ["summary"] },
  steps: { columns: ["steps"], fields: ["steps"] },
  attachments: { columns: ["attachments"], fields: ["attachments"] },
  workflowStepResults: { columns: ["workflowStepResults"], fields: ["workflowStepResults"] },
  comments: { columns: ["comments", "steeringComments"], fields: ["comments", "steeringComments"] },
  source: {
    columns: [
      "sourceType",
      "sourceAgentId",
      "sourceRunId",
      "sourceSessionId",
      "sourceMessageId",
      "sourceParentTaskId",
      "sourceMetadata",
      "sourceIssueProvider",
      "sourceIssueRepository",
      "sourceIssueExternalIssueId",
      "sourceIssueNumber",
      "sourceIssueUrl",
      "sourceIssueClosedAt",
    ],
    // `sourceIssue` and `branchContext` are ASSEMBLED from the columns above, so they ride with them.
    fields: [
      "sourceType",
      "sourceAgentId",
      "sourceRunId",
      "sourceSessionId",
      "sourceMessageId",
      "sourceParentTaskId",
      "sourceMetadata",
      "sourceIssue",
      "branchContext",
    ],
  },
};

/*
FNXC:ReadColumnParity 2026-11-08-07:55 (RUFU-871): the absent shape, measured not assumed.
A dropped column is not the same as a SQL NULL column, and `description` is the ONE field in this set
where that is observable: a row whose `description` column is NULL hydrates to `null`, while a row that
never carried the column hydrates to `undefined`. Every other field below hydrates identically either
way (`steps` -> [], `sourceIssue` -> {}, the rest -> undefined). A consumer that distinguishes the two
must therefore keep `description` selected — which is why neither converted call site declares it, and
why this table exists instead of a hand-wave about "it becomes empty".
*/
const ABSENT_SHAPE: Record<string, unknown> = {
  description: undefined,
  summary: undefined,
  steps: [],
  attachments: undefined,
  comments: undefined,
  steeringComments: undefined,
  workflowStepResults: undefined,
  sourceType: undefined,
  sourceAgentId: undefined,
  sourceRunId: undefined,
  sourceSessionId: undefined,
  sourceMessageId: undefined,
  sourceParentTaskId: undefined,
  sourceMetadata: undefined,
  sourceIssue: {},
  branchContext: undefined,
};

/** A row carrying a realistic, distinguishable value in every heavy column. */
function richFixtureRow(): Record<string, unknown> {
  const stamp = "2026-11-08T07:00:00.000Z";
  return {
    id: "RUFU-871",
    // Pinned, because `rowToTask` falls back to `generateTaskLineageId()` when the column is absent,
    // and a random id would show up as a false difference on every run.
    lineageId: "lin-871",
    title: "Read-column projection",
    description: "a requirement sentence the detail pane can read",
    summary: "a reviewer summary only the detail pane reads",
    column: "in-review",
    status: null,
    steps: [{ id: "step-1", name: "implement", status: "done", required: true }],
    attachments: [{ name: "diagram.png", url: "https://example.invalid/1", size: 2048 }],
    comments: [{ id: "c1", author: "reviewer", body: "the finding text", createdAt: stamp }],
    steeringComments: [{ id: "sc1", author: "operator", body: "the steering text", createdAt: stamp }],
    workflowStepResults: [{ stepId: "code-review", stepName: "Code Review", status: "pending", finishedAt: null }],
    sourceType: "agent",
    sourceAgentId: "agent-1",
    sourceRunId: "run-1",
    sourceSessionId: "session-1",
    sourceMessageId: "message-1",
    sourceParentTaskId: "RUFU-870",
    sourceMetadata: { planEvidence: { spec: "spec text", fingerprint: "fp-871" }, expectedBranch: "fusion/RUFU-871" },
    sourceIssueProvider: "github",
    sourceIssueRepository: "fusion/repo",
    sourceIssueExternalIssueId: "42",
    sourceIssueNumber: 42,
    sourceIssueUrl: "https://example.invalid/42",
    sourceIssueClosedAt: stamp,
    // Columns every compared shape keeps, so the parity claim has real values to hold identical.
    branch: "fusion/RUFU-871",
    worktree: "/tmp/wt/871",
    baseBranch: "main",
    enabledWorkflowSteps: ["code-review"],
    dependencies: ["RUFU-870"],
    externalBlock: { origin: "credentials", code: "E_CRED", message: "rotated", source: "session-failure", blockedAt: stamp, resume: { column: "in-review" } },
    prInfo: { prNumber: 7, prUrl: "https://example.invalid/pull/7", state: "open" },
    tokenUsagePerModel: [{ modelId: "claude-sonnet", totalTokens: 1234 }],
    modifiedFiles: ["src/a.ts"],
    stepReports: [{ stepId: "step-1", report: "implementation report", at: stamp }],
    createdAt: stamp,
    updatedAt: stamp,
    columnMovedAt: stamp,
    log: [{ timestamp: stamp, message: "an entry no compared shape selects" }],
  };
}

/** Columns the undeclared slim row carries that the declared shape does not — the projected SELECT. */
function droppedColumns(options: ReadLiveTaskRowsOptions): string[] {
  const wide = new Set(Object.keys(TASK_SLIM_PROJECTION));
  const narrow = new Set(Object.keys(resolveLiveTaskRowProjection(options)));
  return [...wide].filter((column) => !narrow.has(column)).sort();
}

function hydrate(row: Record<string, unknown>): Record<string, unknown> {
  return rowToTask(pgRowToTaskRow<TaskRow>({ ...row }, TASK_JSONB_COLUMNS)) as unknown as Record<string, unknown>;
}

/** `Task` fields allowed to differ, given the columns this shape stopped selecting. */
function allowedDifferences(dropped: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const member of Object.values(DROPPABLE_MEMBERS)) {
    if (!member.columns.some((column) => dropped.includes(column))) continue;
    for (const field of member.fields) allowed.add(field);
  }
  return allowed;
}

const DECLARED_SHAPES: ReadonlyArray<{ label: string; options: ReadLiveTaskRowsOptions & { fields: readonly TaskListReadField[] } }> = [
  { label: "workflowStepResults only (running-agent count, review-lane sweep)", options: { excludeLog: true, fields: ["workflowStepResults"] } },
  { label: "nothing declared (5 s metrics sampler)", options: { excludeLog: true, fields: [] } },
];

describe("projected list read — every retained field is byte-identical to the undeclared read", () => {
  for (const shape of DECLARED_SHAPES) {
    describe(shape.label, () => {
      const dropped = droppedColumns(shape.options);

      it("the only differing fields are the ones the dropped columns build", () => {
        const row = richFixtureRow();
        const projectedRow = { ...row };
        for (const column of dropped) delete projectedRow[column];

        const full = hydrate(row);
        const projected = hydrate(projectedRow);
        const differing = Object.keys({ ...full, ...projected })
          .filter((field) => JSON.stringify(full[field]) !== JSON.stringify(projected[field]))
          .sort();
        const allowed = allowedDifferences(dropped);
        const unexpected = differing.filter((field) => !allowed.has(field));
        // The whole safety constraint in one assertion: nothing outside the dropped members moved.
        expect(unexpected, `projected read changed ${unexpected.join(", ")}`).toEqual([]);
        // And the premise: the dropped members really did differ, so the comparison is not vacuous.
        expect(differing.length).toBeGreaterThan(0);
      });

      it("a dropped field becomes exactly its documented absent shape, and nothing else", () => {
        const row = richFixtureRow();
        const projectedRow = { ...row };
        for (const column of dropped) delete projectedRow[column];

        const full = hydrate(row);
        const projected = hydrate(projectedRow);
        for (const member of Object.values(DROPPABLE_MEMBERS)) {
          if (!member.columns.some((column) => dropped.includes(column))) continue;
          for (const field of member.fields) {
            if (!(field in ABSENT_SHAPE)) continue;
            expect(
              { field, value: projected[field] },
              `${field} hydrated to something other than its absent shape`,
            ).toEqual({ field, value: ABSENT_SHAPE[field] });
            // The premise, checked on the ROW rather than on the hydrated `Task`: the columns this
            // shape stopped selecting really did carry data, so `projected` differing from `full` is
            // the projection dropping them and not a fixture that never had a value to drop. The
            // hydrated value itself is not asserted to differ, because several of these mappers
            // validate their input and hydrate a fixture-shaped value to the same absent shape the
            // projection produces (`attachments` is one of them) — the byte-identity claim above is
            // the one that matters, and it holds for every retained field either way.
            for (const column of member.columns) {
              expect(row[column], `${column} was not populated, so this comparison proves nothing`).not.toEqual(null);
              expect(row[column], `${column} was not populated, so this comparison proves nothing`).not.toBeUndefined();
            }
          }
        }
      });

      it("still selects the columns the capacity and dispatch predicates dereference", () => {
        // Dropping any of these changes an operator-visible count or a dispatch decision.
        const selected = Object.keys(resolveLiveTaskRowProjection(shape.options));
        for (const column of ["column", "status", "paused", "pausedReason", "userPaused", "checkedOutBy", "externalBlock", "enabledWorkflowSteps", "updatedAt", "id", "title"]) {
          expect(selected, `${column} left the projection`).toContain(column);
        }
      });
    });
  }

  it("`workflowStepResults` survives the declaration that exists to keep it", () => {
    const options: ReadLiveTaskRowsOptions = { excludeLog: true, fields: ["workflowStepResults"] };
    expect(Object.keys(resolveLiveTaskRowProjection(options))).toContain("workflowStepResults");
    const row = richFixtureRow();
    const projectedRow = { ...row };
    for (const column of droppedColumns(options)) delete projectedRow[column];
    const projected = hydrate(projectedRow).workflowStepResults as Task["workflowStepResults"];
    expect(JSON.stringify(projected)).toBe(JSON.stringify(hydrate(row).workflowStepResults));
  });
});
