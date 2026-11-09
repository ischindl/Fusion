/**
 * RUFU-904: a task id owned by two DIFFERENT projects is informational; only a duplicate inside ONE
 * project is an anomaly.
 *
 * FNXC:TaskIdClaimScope 2026-11-09-08:57 (RUFU-904):
 * RUFU-320 made the cross-project pair a blocking anomaly, but `project.tasks` is keyed
 * `(project_id, id)` and every runtime read is RLS-bound, so two projects each minting `RUFU-001` overwrote
 * nothing and aliases nothing a bound store can see. Measured against production on 2026-11-08: 74 ids exist
 * in more than one project (created 2026-07-04..2026-09-27, all pre-dating the claim registry) across
 * RunFusion proj_9326d74a133b421a, alfawise proj_87bc5b3f35624449 and vllm-rocm proj_ab8b3ac6277e43a0, and
 * `distributed_task_id_reservations` holds independent `RUFU-001` rows per project. The banner copy that
 * shipped with that verdict told the operator to "rename the affected cards or archive the duplicate" —
 * i.e. to destroy live cards in projects that are not his to silence a warning about a string.
 *
 * Both arms of the verdict are pinned here, plus the control that keeps the anomaly assertion non-vacuous:
 * the same detector, same fake, same corpus shape, differing only in whether the second owner is a sibling
 * project or the project itself.
 */

import { describe, expect, it } from "vitest";

import { detectTaskIdIntegrityAnomaliesAsync } from "../postgres/async-task-id-integrity.js";

const OWN_PROJECT = "proj_9326d74a133b421a";
const SIBLING_PROJECT = "proj_87bc5b3f35624449";

interface Corpus {
  /** `id` values in `<schema>.tasks` for the scanned project. */
  activeIds?: string[];
  /** `id` values in `<schema>.archived_tasks` for the scanned project. */
  archivedIds?: string[];
  /** Allocator rows for the scanned project; empty keeps the sequence/prefix classes out of the result. */
  state?: Array<{ prefix: string; next_sequence: number }>;
  /** Rows the claim join returns: this project's id, owned DB-wide by another partition. */
  foreignOwners?: Array<{ id: string; owner: string }>;
}

/**
 * Render a Drizzle `sql` fragment back to text so the double can answer the statement it was asked.
 *
 * The fragment exposes `queryChunks` and no `toSQL()`, and a nested fragment (`sql.raw(...)`, an
 * interpolated `SQL` filter) carries its own `queryChunks` rather than a `value`, so the walk recurses.
 * Bound parameters are dropped: the dispatch keys are table names, which are always inline.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(query ?? "");
  let text = "";
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    const nested = (chunk as { queryChunks?: unknown[]; value?: unknown } | null);
    if (Array.isArray(nested?.queryChunks)) {
      text += sqlText(nested);
      continue;
    }
    if (Array.isArray(nested?.value)) {
      text += nested!.value!.map((part) => (typeof part === "string" ? part : "")).join("");
    }
  }
  return text;
}

/**
 * A read-path double for the async detector.
 *
 * Only the five statements the detector issues are scripted, dispatched on the table each statement names,
 * and an unrecognised statement RAISES rather than answering empty — a double that silently returns "no
 * rows" for a query it did not understand is exactly the fail-open shape RUFU-331/333 removed from the
 * detector itself, and it would let a green run prove nothing.
 */
function fakeDb(corpus: Corpus): { execute: (query: unknown) => Promise<unknown[]> } {
  const activeIds = corpus.activeIds ?? [];
  const archivedIds = corpus.archivedIds ?? [];
  const state = corpus.state ?? [];
  const foreignOwners = corpus.foreignOwners ?? [];

  return {
    async execute(query: unknown) {
      const text = sqlText(query);
      if (text.includes("central.global_task_id_claim")) return foreignOwners;
      if (text.includes("archived_tasks")) return archivedIds.map((id) => ({ id }));
      if (text.includes("distributed_task_id_state")) return state;
      if (text.includes(".tasks")) return activeIds.map((id) => ({ id }));
      throw new Error(`unscripted statement: ${text.slice(0, 80)}`);
    },
  };
}

describe("detectTaskIdIntegrityAnomaliesAsync cross-project classification", () => {
  it("reports an id owned by two different projects as informational, with status ok and no anomaly", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb({
        activeIds: ["RUFU-001"],
        state: [],
        foreignOwners: [{ id: "RUFU-001", owner: SIBLING_PROJECT }],
      }) as never,
      { projectId: OWN_PROJECT },
    );

    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
    expect(report.crossProjectDuplicates).toEqual([
      {
        prefix: "RUFU",
        affectedIds: ["RUFU-001"],
        ownerProjectIds: [SIBLING_PROJECT],
        note: expect.stringContaining("unique per project"),
      },
    ]);
  });

  it("names no rename or archive remedy for a cross-project pair", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb({
        activeIds: ["RUFU-001"],
        foreignOwners: [{ id: "RUFU-001", owner: SIBLING_PROJECT }],
      }) as never,
      { projectId: OWN_PROJECT },
    );

    const [duplicate] = report.crossProjectDuplicates ?? [];
    expect(duplicate?.note).toBeTruthy();
    expect(duplicate?.note).not.toMatch(/rename|archive|database-wide/i);
    expect(JSON.stringify(report.anomalies)).not.toMatch(/rename|archive/i);
  });

  it("keeps the same id held twice inside ONE project an anomaly", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb({ activeIds: ["RUFU-001", "RUFU-001"], state: [] }) as never,
      { projectId: OWN_PROJECT },
    );

    expect(report.status).toBe("anomaly");
    expect(
      report.anomalies.filter((anomaly) => anomaly.kind === "duplicate_active_id").map((anomaly) => anomaly.affectedIds),
    ).toEqual([["RUFU-001"]]);
    // The two-key task row is what keeps both copies alive; the verdict must not claim otherwise.
    expect(report.crossProjectDuplicates).toBeUndefined();
  });

  it("records no informational field at all when the scan has no project partition to compare against", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb({ activeIds: ["RUFU-001"], state: [] }) as never,
    );

    expect(report.status).toBe("ok");
    expect(report.crossProjectDuplicates).toBeUndefined();
  });
});
