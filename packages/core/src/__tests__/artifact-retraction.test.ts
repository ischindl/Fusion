/*
FNXC:ArtifactRetraction 2026-11-11-12:08 (RUFU-433):
Store-level contract for the artifact tombstone, driven against a REAL PostgreSQL-backed TaskStore.

Why a PG harness and not the in-memory fake: three of the six behaviors under test are column facts —
that `retracted_at`/`retracted_by`/`retract_reason` exist, that a pre-0097 row (NULL tombstone) reads as
valid, and that the metadata-only `listArtifacts` select actually names them. A fake store can assert a
filter's *shape* and would pass happily while the migration never ran, which is the exact failure class
`migration-wiring-integrity.test.ts` exists for one layer up.

The invariant every case protects: a retracted artifact must never present itself as live input anywhere,
and must never be silently readable — while the row itself, its file, and its card trace all survive.
*/
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_BASELINE_VERSION } from "../postgres/schema-applier.js";
import type { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../__test-utils__/pg-test-harness.js";

/** The runId `retractArtifactImpl` stamps, so a test reads only its own rows. */
function auditRunId(artifactId: string, action: "retract" | "restore"): string {
  return `artifact-retraction:${artifactId}:${action}`;
}

pgDescribe("artifact retraction (RUFU-433)", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_artifact_retraction" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  async function makeTask(title: string): Promise<string> {
    const task = await store.createTask({ title, description: "RUFU-433 tombstone fixture" });
    return task.id;
  }

  async function makeArtifact(input: { taskId?: string; title: string; authorId?: string }): Promise<string> {
    const artifact = await store.registerArtifact({
      type: "document",
      title: input.title,
      content: `body of ${input.title}`,
      mimeType: "text/markdown",
      authorId: input.authorId ?? "agent-reviewer",
      authorType: "agent",
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
    return artifact.id;
  }

  it("hides a retracted artifact from every default read and reveals it only on explicit opt-in", async () => {
    const taskId = await makeTask("Card holding a review artifact");
    const id = await makeArtifact({ taskId, title: "Review assessment (APPROVE)" });

    expect(await store.listArtifacts({ taskId })).toHaveLength(1);

    await store.retractArtifact(id, { reason: "Registered against the wrong head", actorId: "agent-reviewer", actorType: "agent" });

    // The default read must not find it: this is the "not findable by an ordinary browse" requirement.
    expect(await store.listArtifacts({ taskId })).toEqual([]);
    expect(await store.listArtifacts({})).toEqual([]);
    expect(await store.getArtifacts(taskId)).toEqual([]);

    // The opt-in read finds it, labelled, with the tombstone attached.
    const revealed = await store.listArtifacts({ taskId, includeRetracted: true });
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toMatchObject({
      id,
      retractedBy: "agent-reviewer",
      retractReason: "Registered against the wrong head",
    });
    expect(revealed[0]!.retractedAt).toBeTruthy();

    /*
    FNXC:ArtifactRetraction 2026-11-11-12:14 (RUFU-433): the per-task read carries the same opt-in, and it
    is asserted rather than assumed because the card's VOID rendering is the only surface that can show the
    reason; a per-task read that could never return the row would make the tombstone unrenderable there.
    */
    const revealedPerTask = await store.getArtifacts(taskId, { includeRetracted: true });
    expect(revealedPerTask).toHaveLength(1);
    expect(revealedPerTask[0]).toMatchObject({ id, retractReason: "Registered against the wrong head" });
  });

  it("keeps the row present with its tombstone — a retraction is a tombstone, never a delete", async () => {
    const taskId = await makeTask("Card whose artifact gets withdrawn");
    const id = await makeArtifact({ taskId, title: "Mis-attached screenshot" });

    const retracted = await store.retractArtifact(id, {
      reason: "Attached to the wrong card",
      actorId: "agent-reviewer",
      actorType: "agent",
    });

    // The named read still resolves the row, which is what lets the VOID header be served at all.
    const stored = await store.getArtifact(id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(id);
    expect(stored!.title).toBe("Mis-attached screenshot");
    expect(stored!.retractedBy).toBe("agent-reviewer");
    expect(stored!.retractReason).toBe("Attached to the wrong card");
    expect(stored!.retractedAt).toBe(retracted.retractedAt);
  });

  it("ships the three tombstone columns physically, so a pre-0097 row reads as valid by absence", async () => {
    const taskId = await makeTask("Card with a legacy artifact");
    const id = await makeArtifact({ taskId, title: "Artifact written before migration 0097" });

    /*
    Direct information_schema read: this is the assertion that the migration actually reached the database,
    which no fake store can give. It then writes NULLs through raw SQL — the shape every row written before
    0097 already has — and checks the read layer calls that "valid", not "unknown".
    */
    const layer = (store as unknown as { asyncLayer: { db: { execute: (sql: unknown) => Promise<Array<Record<string, unknown>>> } } }).asyncLayer;
    const { sql } = await import("drizzle-orm");
    const columns = await layer.db.execute(sql.raw(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = 'project' AND table_name = 'artifacts'"
      + " AND column_name IN ('retracted_at','retracted_by','retract_reason')",
    ));
    const rows = Array.isArray(columns) ? columns : (columns as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    expect(rows.map((r) => r.column_name).sort()).toEqual(["retract_reason", "retracted_at", "retracted_by"]);

    await layer.db.execute(sql.raw(`UPDATE project.artifacts SET retracted_at = NULL, retracted_by = NULL, retract_reason = NULL WHERE id = '${id}'`));

    const stored = await store.getArtifact(id);
    expect(stored).not.toBeNull();
    expect(stored!.retractedAt).toBeUndefined();
    expect(stored!.retractedBy).toBeUndefined();
    expect(stored!.retractReason).toBeUndefined();
    // And it is still in the default (hide-retracted) list.
    expect(await store.listArtifacts({ taskId })).toHaveLength(1);
  });

  it("refuses a retraction with no reason, a blank reason, and an unknown artifact", async () => {
    const taskId = await makeTask("Card with an artifact that needs a reason");
    const id = await makeArtifact({ taskId, title: "Needs a reason" });

    await expect(store.retractArtifact(id, { reason: "", actorId: "agent-reviewer", actorType: "agent" }))
      .rejects.toThrow(/reason/i);
    await expect(store.retractArtifact(id, { reason: "     ", actorId: "agent-reviewer", actorType: "agent" }))
      .rejects.toThrow(/reason/i);
    await expect(store.retractArtifact("00000000-0000-4000-8000-000000000000", {
      reason: "nothing here", actorId: "agent-reviewer", actorType: "agent",
    })).rejects.toThrow(/not found/i);

    // Nothing was written by the refused calls: the artifact is still live.
    expect(await store.listArtifacts({ taskId })).toHaveLength(1);
  });

  it("refuses to edit a retracted artifact's content — a VOID row is not a live editing surface", async () => {
    const taskId = await makeTask("Card with an artifact that must stop being editable");
    const id = await makeArtifact({ taskId, title: "Retracted then edited?" });
    await store.retractArtifact(id, { reason: "False claim", actorId: "agent-reviewer", actorType: "agent" });

    await expect(store.updateArtifact(id, { content: "quietly rewritten" }))
      .rejects.toThrow(/retracted/i);
    const stored = await store.getArtifact(id);
    expect(stored!.content).toBe("body of Retracted then edited?");
  });

  it("restores a retracted artifact to the default list, clearing all three tombstone columns", async () => {
    const taskId = await makeTask("Card whose artifact comes back");
    const id = await makeArtifact({ taskId, title: "Restored after the operator checked" });
    await store.retractArtifact(id, { reason: "Suspected false", actorId: "agent-reviewer", actorType: "agent" });
    expect(await store.listArtifacts({ taskId })).toEqual([]);

    await store.restoreArtifact(id, { actorId: "operator", actorType: "user" });

    expect(await store.listArtifacts({ taskId })).toHaveLength(1);
    const stored = await store.getArtifact(id);
    expect(stored!.retractedAt).toBeUndefined();
    expect(stored!.retractedBy).toBeUndefined();
    expect(stored!.retractReason).toBeUndefined();
  });

  it("refuses to restore an artifact that was never retracted", async () => {
    const id = await makeArtifact({ title: "Never retracted, so nothing to restore" });
    await expect(store.restoreArtifact(id, { actorId: "operator", actorType: "user" }))
      .rejects.toThrow(/not retracted/i);
  });

  it("writes no task row, no workflow step result, no column, and no pause", async () => {
    const taskId = await makeTask("Card that must not move");
    const id = await makeArtifact({ taskId, title: "Withdrawn claim" });
    const before = await store.getTask(taskId);
    expect(before).not.toBeNull();

    await store.retractArtifact(id, { reason: "Wrong head", actorId: "agent-reviewer", actorType: "agent" });

    const after = await store.getTask(taskId);
    expect(after).not.toBeNull();
    // Every lifecycle-bearing field is byte-identical; only `updatedAt` legitimately moves, and only
    // because History tracing touched the card's log, which is not a lifecycle field.
    for (const key of ["column", "status", "paused", "pausedReason", "userPaused", "workflowStepResults", "branch", "worktree"] as const) {
      expect(after![key]).toEqual(before![key]);
    }
    expect(after!.workflowStepResults ?? {}).toEqual(before!.workflowStepResults ?? {});
  });

  it("traces the retraction on the card's History and records it in run-audit without the reason prose", async () => {
    const taskId = await makeTask("Card that must remember the withdrawal");
    const reason = "Merged the wrong ahead/behind census into the verdict body";
    const id = await makeArtifact({ taskId, title: "Review assessment (false)" });

    await store.retractArtifact(id, { reason, actorId: "agent-reviewer", actorType: "agent" });
    await store.flushRunAuditSink();

    /*
    FNXC:ArtifactRetraction 2026-11-11-12:10 (RUFU-433): the card trace is asserted on `task.log` (the
    History the operator reads in the task's History tab), NOT on the agent log. `store.logEntry` appends
    a History entry whose text lands in `action`; the agent-log stream carries agent runtime rows only.
    Asserting the wrong surface here would have made a real retraction look untraceable.
    */
    const card = await store.getTask(taskId);
    const trace = card?.log?.find((entry) => (entry.action ?? "").includes("Retracted artifact"));
    expect(trace).toBeDefined();
    expect(trace!.action).toContain("Review assessment (false)");
    expect(trace!.action).toContain("agent-reviewer");
    expect(trace!.action).toContain(reason);

    const audit = (await store.getRunAuditEventsAsync({ runId: auditRunId(id, "retract") })).filter(
      (event) => event.mutationType === "artifact:retracted",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({
      artifactId: id,
      outcome: "retracted",
      actorType: "agent",
      reasonChars: reason.length,
      taskId,
    });
    // The reason sentence is a count here, never the text.
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("ahead/behind");
  });

  it("records an artifact with no parent task with an audit row and no card trace", async () => {
    const id = await makeArtifact({ title: "Task-less registry artifact" });
    await store.retractArtifact(id, { reason: "Duplicate of another registry entry", actorId: "agent-reviewer", actorType: "agent" });
    await store.flushRunAuditSink();

    const audit = (await store.getRunAuditEventsAsync({ runId: auditRunId(id, "retract") })).filter(
      (event) => event.mutationType === "artifact:retracted",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).not.toHaveProperty("taskId");
  });

  it("collapses a same-actor repeat to one write and one audit row, and refuses a different actor", async () => {
    const taskId = await makeTask("Card behind a retried retraction");
    const id = await makeArtifact({ taskId, title: "Retried retraction" });
    const first = await store.retractArtifact(id, { reason: "False claim", actorId: "agent-reviewer", actorType: "agent" });
    await store.flushRunAuditSink();

    const again = await store.retractArtifact(id, { reason: "False claim", actorId: "agent-reviewer", actorType: "agent" });
    await store.flushRunAuditSink();
    // A retry of a half-delivered call must not drift the tombstone clock.
    expect(again.retractedAt).toBe(first.retractedAt);

    const rows = (await store.getRunAuditEventsAsync({ runId: auditRunId(id, "retract") })).filter(
      (event) => event.mutationType === "artifact:retracted",
    );
    expect(rows).toHaveLength(1);

    // A second actor cannot overwrite the first retractors attribution.
    await expect(store.retractArtifact(id, { reason: "Mine instead", actorId: "agent-other", actorType: "agent" }))
      .rejects.toThrow(/already retracted/i);
  });

  it("publishes artifact:retracted so an open gallery can drop the false row without a reload", async () => {
    const seen: Array<{ id: string; retractedAt?: string }> = [];
    const listener = (artifact: { id: string; retractedAt?: string }): void => { seen.push(artifact); };
    store.on("artifact:retracted", listener);
    try {
      const id = await makeArtifact({ title: "Event-carried retraction" });
      await store.retractArtifact(id, { reason: "Superseded", actorId: "agent-reviewer", actorType: "agent" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.id).toBe(id);
      expect(seen[0]!.retractedAt).toBeTruthy();
    } finally {
      store.off("artifact:retracted", listener);
    }
  });
});

/*
FNXC:PgTestSkipHonesty 2026-11-11-12:15 (RUFU-433):
`pgDescribe` SKIPS when FUSION_PG_TEST_URL_BASE is unset and vitest still exits 0, so a green run of the
suite above can mean the tombstone columns were never touched. This block therefore asserts the facts that
NEED no database, and asserts them for real rather than describing them: the shipped migration must name
exactly the columns the row mapper writes, and the applier must register that exact basename. A column
added to the migration without a mapper, or a mapper field with no column, fails here on any machine with
or without a PG backend — which is what makes this a guard rather than a note.
*/
describe("artifact retraction wiring (no PostgreSQL backend required)", () => {
  const MIGRATION_BASENAME = "0097_rufu_433_artifact_retraction.sql";

  function migrationSql(): string {
    return readFileSync(new URL(`../postgres/migrations/${MIGRATION_BASENAME}`, import.meta.url), "utf8");
  }

  /** snake_case in SQL, camelCase in drizzle: `retracted_at` -> `retractedAt`. */
  function camelOf(column: string): string {
    return column.replace(/_(\w)/g, (_all, chr: string) => chr.toUpperCase());
  }

  it("adds only the three tombstone columns, additively", () => {
    const sql = migrationSql();
    const added = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)].map((match) => match[1]).sort();
    expect(added).toEqual(["retract_reason", "retracted_at", "retracted_by"]);
    /*
    Additive-only contract, checked on STATEMENT LINES ONLY (a line opening with an uppercase SQL verb).
    The migration's own rationale comment says "delete" and "drop" while explaining why it does neither, so
    scanning raw file text fails on prose and would teach the next author to delete the comment to get green.
    */
    const statements = sql.split("\n").map((line) => line.trim()).filter((line) => /^[A-Z]+ /.test(line));
    expect(statements.length).toBe(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^ALTER TABLE project\.artifacts ADD COLUMN IF NOT EXISTS [a-z_]+ text;$/);
    }
  });

  it("registers the migration in the applier so it cannot silently never run", () => {
    const applier = readFileSync(new URL("../postgres/schema-applier.ts", import.meta.url), "utf8");
    expect(applier).toContain(MIGRATION_BASENAME);
    expect(SCHEMA_BASELINE_VERSION).toBe("0097");
  });

  it("maps every column the migration adds, in BOTH row mappers, so a tombstone can never read as live", () => {
    /*
    FNXC:ArtifactRetraction 2026-11-11-12:17 (RUFU-433): two functions turn one ArtifactRow into one
    Artifact (serialization.rowToArtifact for store.rowToArtifact, the async helper for every PG read).
    Checking only one would let the other return a retracted row with no tombstone, which is the invariant
    violation this whole card exists to prevent, so both are named.
    */
    const mappers = [
      "../task-store/async/async-comments-attachments.ts",
      "../task-store/serialization.ts",
    ].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));
    const added = [...migrationSql().matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)].map((match) => match[1]);
    for (const mapper of mappers) {
      for (const column of added) {
        expect(mapper).toContain(camelOf(column));
      }
    }
  });
});
