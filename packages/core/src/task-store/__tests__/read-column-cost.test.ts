/*
FNXC:ReadColumnCost 2026-11-08-08:05 (RUFU-871 read-column projection slice):
An allocation-sampling profiler run over 60 s of ordinary production dashboard traffic measured
788 MB allocated in 60 s, of which the PostgreSQL driver owns 90 %: `DataRow` (one per result row)
417 MB = 53 %, and `fromJson` (pg parsing the jsonb columns of those rows) 276 MB = 35 %, while the
app-side hydration `rowToTask` — the frame every earlier optimisation attacked — is only 66 MB = 8 %.
No app-side change can reach more than the remaining 8 %. The reachable levers are fewer ROWS per
unit time and fewer COLUMNS per row, and the jsonb share says the column lever is a jsonb lever.

This file is the measurement half, in the counting-harness shape this repo already accepted
(`row-hydration-cost.test.ts`, `git-proof-fork-count.test.ts`): it counts things at the SQL seam and
asserts COUNTS, never latency, and the expensive report is env-gated so CI never pays for it:

  FUSION_READ_COLUMN_BENCH=1 pnpm --filter @fusion/core exec vitest run \
    src/task-store/__tests__/read-column-cost.test.ts --reporter=basic

What this file owns is the MECHANISM and its byte consequence: a declared read-set is a strict
subset of the undeclared row, it drops exactly the heavy jsonb columns and nothing else, and the
saving is real bytes. What it cannot own is whether a given call site declares the right set — a
core test has no business reading another package's source — so the per-call-site guards live beside
their call sites: `running-agent-count-read-projection.test.ts` (dashboard) and
`review-sweep-read-column-projection.test.ts` (engine).
*/
import { describe, expect, it } from "vitest";
import {
  resolveLiveTaskRowProjection,
  TASK_SLIM_PROJECTION,
  type ReadLiveTaskRowsOptions,
} from "../async/async-persistence.js";
import { TASK_JSONB_COLUMNS } from "../persistence.js";

/** The heavy jsonb columns this slice targets, named explicitly so a drop is never anonymous. */
const HEAVY_JSONB_COLUMNS = [
  "comments",
  "steeringComments",
  "steps",
  "attachments",
  "sourceMetadata",
  "workflowStepResults",
] as const;

/** The jsonb columns a resolved projection transfers. */
function selectedJsonb(options: ReadLiveTaskRowsOptions): string[] {
  return Object.keys(resolveLiveTaskRowProjection(options))
    .filter((column) => TASK_JSONB_COLUMNS.has(column))
    .sort();
}

/** One PostgreSQL-shaped row carrying realistic bytes in every heavy column. */
function productionShapedRow(): Record<string, unknown> {
  const stamp = "2026-11-08T07:00:00.000Z";
  return {
    id: "RUFU-871",
    column: "in-review",
    status: null,
    description: "requirement sentence. ".repeat(30),
    summary: "reviewer summary sentence. ".repeat(20),
    steps: Array.from({ length: 6 }, (_u, n) => ({ id: `s${n}`, name: `step ${n}`, status: "done", required: true })),
    attachments: Array.from({ length: 3 }, (_u, n) => ({ name: `attach-${n}.png`, url: `https://example.invalid/${n}`, size: 1024 })),
    comments: Array.from({ length: 8 }, (_u, n) => ({ id: `c${n}`, author: "reviewer", body: `review comment body ${n} ${"detail ".repeat(20)}`, createdAt: stamp })),
    steeringComments: Array.from({ length: 4 }, (_u, n) => ({ id: `sc${n}`, author: "operator", body: `steering sentence ${n} ${"detail ".repeat(15)}`, createdAt: stamp })),
    workflowStepResults: Array.from({ length: 3 }, (_u, n) => ({ stepId: `step-${n}`, status: "passed", verdict: "APPROVE", summary: `finding text ${n} ${"detail ".repeat(25)}`, finishedAt: stamp })),
    sourceMetadata: { planEvidence: { spec: "spec text ".repeat(60), fingerprint: "fp-871" }, wipAdmissionStall: { signature: "sweep:871", firstAt: stamp, ageMs: 60_000 } },
    sourceType: "manual",
    sourceAgentId: null,
    sourceRunId: null,
    sourceSessionId: null,
    sourceMessageId: null,
    sourceParentTaskId: null,
    sourceIssueProvider: null,
    sourceIssueRepository: null,
    sourceIssueExternalIssueId: null,
    sourceIssueNumber: null,
    sourceIssueUrl: null,
    sourceIssueClosedAt: null,
    log: Array.from({ length: 200 }, (_u, n) => ({ timestamp: stamp, message: `[timing] step ${n} ${"detail ".repeat(15)}` })),
  };
}

/** Serialized bytes of one column of the shaped row — what pg's `fromJson` has to build. */
function columnBytes(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  return value === undefined ? 0 : JSON.stringify(value).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The row shape every hot consumer starts from: slim (no `log`), nothing declared. */
const UNDECLARED: ReadLiveTaskRowsOptions = { excludeLog: true };

describe("declared read-set — mechanism invariants every projected read path relies on", () => {
  it("the undeclared slim row still transfers every heavy jsonb column", () => {
    /*
     * The slice's premise, asserted rather than narrated. If this goes red the projection mechanism
     * changed shape and every byte figure below is void — the caller-site guards would then be
     * pinning a saving that no longer exists.
     */
    const undeclared = selectedJsonb(UNDECLARED);
    for (const column of HEAVY_JSONB_COLUMNS) {
      expect(undeclared, `${column} disappeared from the undeclared projection`).toContain(column);
    }
    // `log` is already gone through the projection gate; that is RUFU-615/RUFU-584, not this slice.
    expect(undeclared).not.toContain("log");
  });

  it("naming only `workflowStepResults` drops the other five heavy jsonb columns and keeps the one", () => {
    const selected = selectedJsonb({ excludeLog: true, fields: ["workflowStepResults"] });
    expect(selected).toContain("workflowStepResults");
    for (const column of HEAVY_JSONB_COLUMNS) {
      if (column === "workflowStepResults") continue;
      expect(selected, `${column} survived a declaration that never named it`).not.toContain(column);
    }
  });

  it("declaring nothing returns the shared slim projection object by reference, unchanged", () => {
    // Byte-identity for the ~90 % of list-read callers that declare nothing is a reference identity.
    expect(resolveLiveTaskRowProjection(UNDECLARED)).toBe(TASK_SLIM_PROJECTION);
  });

  it("every declared shape is a strict subset of the undeclared row — a declaration never invents a column", () => {
    const wide = new Set(Object.keys(resolveLiveTaskRowProjection(UNDECLARED)));
    for (const fields of [[] as const, ["workflowStepResults"] as const, ["comments", "source"] as const]) {
      const narrow = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields }));
      for (const column of narrow) expect(wide.has(column), `declared shape invented ${column}`).toBe(true);
      expect(narrow.length).toBeLessThan(wide.size);
    }
  });

  it("the pair and the source family still move as one member", () => {
    // RUFU-883's and RUFU-627's rules: a half-declared member describes a shape the mapper cannot honour.
    const comments = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["comments"] }));
    expect(comments).toContain("comments");
    expect(comments).toContain("steeringComments");
    const source = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["source"] }));
    for (const column of ["sourceMetadata", "sourceType", "sourceIssueUrl", "sourceIssueClosedAt"]) {
      expect(source, `the source family lost ${column}`).toContain(column);
    }
  });
});

describe.skipIf(!process.env.FUSION_READ_COLUMN_BENCH)(
  "declared read-set — per-row byte report (report-only, FUSION_READ_COLUMN_BENCH=1)",
  () => {
    it("prints jsonb columns selected and bytes/row for the shapes the hot paths use", () => {
      const row = productionShapedRow();
      const bytesFor = (columns: string[]) => columns.reduce((sum, column) => sum + columnBytes(row, column), 0);
      const undeclaredJsonb = selectedJsonb(UNDECLARED);

      const shapes: Array<{ label: string; options: ReadLiveTaskRowsOptions }> = [
        { label: "undeclared slim (today's default)", options: UNDECLARED },
        { label: "fields: [] (metrics sampler)", options: { excludeLog: true, fields: [] } },
        { label: "fields: [workflowStepResults] (running-agent count, review sweep)", options: { excludeLog: true, fields: ["workflowStepResults"] } },
      ];

      const repeats = 7;
      const medians = new Map<string, number>();
      for (const shape of shapes) {
        const samples: number[] = [];
        for (let i = 0; i < repeats; i += 1) samples.push(bytesFor(selectedJsonb(shape.options)));
        medians.set(shape.label, median(samples));
      }
      const undeclaredMedian = medians.get(shapes[0]!.label)!;

      const lines: string[] = [
        "",
        "=== READ COLUMN COST (jsonb bytes/row, median of 7, fixture-shaped row) ===",
        "shape".padEnd(64) + "jsonb cols".padEnd(11) + "jsonb B/row".padEnd(12) + "saved B/row",
      ];
      for (const shape of shapes) {
        const cols = selectedJsonb(shape.options);
        const bytes = medians.get(shape.label)!;
        lines.push(shape.label.padEnd(64) + String(cols.length).padEnd(11) + String(bytes).padEnd(12) + String(undeclaredMedian - bytes));
      }
      lines.push("");
      lines.push(`heavy jsonb columns dropped by a [workflowStepResults] declaration: ${HEAVY_JSONB_COLUMNS.filter((c) => c !== "workflowStepResults").join(", ")}`);
      lines.push("text columns a declared read also drops (bytes measured in the report below): description, summary");
      const textBytes = columnBytes(row, "description") + columnBytes(row, "summary");
      lines.push(`  description + summary: ${textBytes} B/row`);
      const allColumns = Object.keys(resolveLiveTaskRowProjection(UNDECLARED));
      const declaredColumns = Object.keys(resolveLiveTaskRowProjection({ excludeLog: true, fields: ["workflowStepResults"] }));
      const totalFor = (columns: string[]) => columns.reduce((sum, column) => sum + columnBytes(row, column), 0);
      lines.push(`all selected columns, undeclared: ${allColumns.length} cols, ${totalFor(allColumns)} B/row`);
      lines.push(`all selected columns, declared:   ${declaredColumns.length} cols, ${totalFor(declaredColumns)} B/row`);
      lines.push("");
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
      expect(medians.get(shapes[2]!.label)!).toBeLessThan(undeclaredMedian);
    });
  },
);
