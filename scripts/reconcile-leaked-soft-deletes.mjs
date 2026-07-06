#!/usr/bin/env node
/*
FNXC:PostgresCutover 2026-07-05-13:00:
Ported from direct node:sqlite access on .fusion/fusion.db to the PostgreSQL
backend (scripts/lib/backend-db.mjs). The planning logic is pure
(planReconcileLeakedSoftDeletes) so tests exercise it with plain row arrays;
only the thin apply step touches PostgreSQL. Behavior preserved from FN-5175:
soft-deleted rows leaked outside 'archived' are moved to 'archived' with a
run-audit event per repaired row.
*/
import process from "node:process";
import { openBackend, rowsOf } from "./lib/backend-db.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let projectRoot = process.cwd();

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project-root" && args[i + 1]) {
      projectRoot = args[i + 1];
      i += 1;
    }
  }

  return {
    apply: args.includes("--apply"),
    dryRun: !args.includes("--apply"),
    projectRoot,
  };
}

/**
 * Pure planning step: given task rows ({ id, column, status, deletedAt }),
 * report the leaked soft-deletes (deletedAt set but column != 'archived').
 */
export function planReconcileLeakedSoftDeletes(rows, { runId = `synthetic-reconcile-fn-5175-${Date.now()}` } = {}) {
  const findings = rows
    .filter((row) => row.deletedAt != null && row.column !== "archived")
    .map((row) => ({ id: row.id, column: row.column, status: row.status ?? null, deletedAt: row.deletedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    rowsScanned: rows.length,
    rowsUpdated: 0,
    auditRowsInserted: 0,
    runId,
    findings,
  };
}

export async function reconcileLeakedSoftDeletes({ backend, dryRun = true, runId }) {
  const { core, asyncLayer, sql } = backend;
  const rows = rowsOf(
    await asyncLayer.db.execute(sql`
      SELECT id, "column", status, deleted_at AS "deletedAt"
      FROM project."tasks"
      WHERE deleted_at IS NOT NULL AND "column" != 'archived'
      ORDER BY id
    `),
  );
  const allCount = rowsOf(
    await asyncLayer.db.execute(sql`SELECT count(*)::int AS count FROM project."tasks"`),
  )[0]?.count ?? rows.length;

  const summary = planReconcileLeakedSoftDeletes(rows, runId ? { runId } : {});
  summary.rowsScanned = allCount;

  if (dryRun || summary.findings.length === 0) {
    return summary;
  }

  await asyncLayer.transactionImmediate(async (tx) => {
    for (const row of summary.findings) {
      await tx.execute(sql`UPDATE project."tasks" SET "column" = 'archived' WHERE id = ${row.id}`);
      await core.recordRunAuditEventWithinTransaction(tx, {
        taskId: row.id,
        agentId: "system",
        runId: summary.runId,
        domain: "database",
        mutationType: "task:soft-delete-column-reconcile",
        target: row.id,
        metadata: {
          previousColumn: row.column,
          previousStatus: row.status ?? null,
          source: "FN-5175 reconcile",
        },
      });
      summary.rowsUpdated += 1;
      summary.auditRowsInserted += 1;
    }
  });

  return summary;
}

export function formatSummary(summary, dryRun) {
  const lines = [
    dryRun ? "Mode: DRY RUN" : "Mode: APPLY",
    "id\tcolumn\tstatus\tdeletedAt",
    ...summary.findings.map((row) => `${row.id}\t${row.column}\t${row.status ?? "NULL"}\t${row.deletedAt}`),
    `Rows scanned: ${summary.rowsScanned}`,
    `Rows updated: ${summary.rowsUpdated}`,
    `Audit rows inserted: ${summary.auditRowsInserted}`,
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const { dryRun, projectRoot } = parseArgs(argv);
  const backend = await openBackend(projectRoot);

  try {
    const summary = await reconcileLeakedSoftDeletes({ backend, dryRun });
    console.log(formatSummary(summary, dryRun));
    return summary;
  } finally {
    await backend.shutdown().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
