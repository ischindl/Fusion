import { describe, expect, it, vi } from "vitest";
import {
  rekeyFallbackProjectPartition,
  stampMigratedProjectRows,
} from "../../postgres/migration-stamping.js";

function queryText(query: unknown): string {
  return (query as { queryChunks?: Array<{ value: string[] }> }).queryChunks
    ?.flatMap((chunk) => chunk.value).join("") ?? "";
}

/*
FNXC:SchemaLockDeadline 2026-09-23-07:10:
STAS-251 gave every boot-critical advisory lock a bounded wait, which prepends a
transaction-local `set_config('lock_timeout', …)` to the session. This file's subject is the
ORDER of the semantic statements, so the lock-setting preamble is filtered rather than
re-indexed; the bound itself is proven behaviorally in schema-mutation-lock-timeout.test.ts.
*/
function isLockTimeoutPreamble(statement: string): boolean {
  return statement.includes("set_config('lock_timeout'");
}

function recordingDb(statements: string[]) {
  const execute = vi.fn(async (query: unknown) => {
    const text = queryText(query);
    if (!isLockTimeoutPreamble(text)) statements.push(text);
    return [];
  });
  return {
    transaction: vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => (
      callback({ execute })
    )),
  };
}

describe("migration stamping advisory-lock order", () => {
  it("locks out schema DDL before scanning every project-owned table", async () => {
    const statements: string[] = [];

    await rekeyFallbackProjectPartition(
      recordingDb(statements) as never,
      "local-fallback",
      "project-registered",
    );

    expect(statements[0]).toContain("fusion:sqlite-migration-state");
    expect(statements[1]).toContain("information_schema.columns");
  });

  it("locks out schema DDL before stamping migrated rows across tables", async () => {
    const statements: string[] = [];

    await stampMigratedProjectRows(recordingDb(statements) as never, {
      projectId: "project-registered",
      rootDir: "/project",
    });

    expect(statements[0]).toContain("fusion:sqlite-migration-state");
    expect(statements[1]).toContain("fusion_sqlite_migrations");
  });
});
