/*
FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
Direct behavioral coverage for the sweep-failure family. RUFU-898 exists because a caught sweep
exception left nothing persistent, so the guarantees that matter here are all row-shaped: one row per
window per subject, no row of the other level, `target` never empty, `taskId` absent on a pass row, and
above all no error prose anywhere in the row. Each of those is asserted as a row, not as a source-string
read — an audit row whose metadata leaked the exception sentence would still satisfy a grep.

The hostile-sink half is mandated by `docs/run-audit.md` → Emit-seam policy: a new engine emitter ships
with a behavioral sink-health regression, not only a routing assertion.
*/
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEDGE_RENOTIFY_COOLDOWN_MS } from "@fusion/core";
import {
  SWEEP_CANDIDATE_FAILURE_EVENT,
  SWEEP_FAILURE_STAGES,
  SWEEP_FAILURE_SWEEPS,
  SWEEP_PASS_FAILURE_EVENT,
  claimSweepFailureEpisode,
  emitSweepFailureAudit,
  sweepCandidateFailureKey,
  sweepFailureMetadata,
  sweepPassFailureKey,
  type SweepFailureStage,
} from "../self-healing/sweep-failure-audit.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

/** A wall-clock instant safely inside one cooldown bucket (bucket 0 is never the boundary). */
const NOW = Date.parse("2026-11-18T09:00:00.000Z");

function sink() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    store: { recordRunAuditEvent: vi.fn(async (row: Record<string, unknown>) => { rows.push(row); }) },
  };
}

/* Every call site builds its own report, so a test that wants dedupe to bite passes one shared memo. */
const passReport = (over: Partial<{
  sweep: (typeof SWEEP_FAILURE_SWEEPS)[number];
  error: unknown;
  store: unknown;
  memo: Map<string, number>;
  now: number;
  candidateFailureCount: number;
}> = {}) => ({
  sweep: "recover-review-tasks-with-failed-pre-merge-steps" as const,
  error: new Error("workflowDefinitionEpoch is not a function"),
  store: undefined,
  memo: new Map<string, number>(),
  now: NOW,
  ...over,
});

const candidateReport = (over: Partial<{
  sweep: (typeof SWEEP_FAILURE_SWEEPS)[number];
  error: unknown;
  store: unknown;
  memo: Map<string, number>;
  now: number;
  stage: SweepFailureStage;
  taskId: string;
}> = {}) => ({
  ...passReport(over),
  stage: "revive" as SweepFailureStage,
  taskId: "RUFU-898",
  ...over,
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("sweep failure audit — the dedupe window", () => {
  it("writes one pass row per window and re-opens on the next bucket", async () => {
    const { rows, store } = sink();
    const memo = new Map<string, number>();
    const base = { store: store as never, memo };

    await expect(emitSweepFailureAudit(passReport(base))).resolves.toBe(true);
    await expect(emitSweepFailureAudit(passReport(base))).resolves.toBe(false);
    expect(rows).toHaveLength(1);

    // A persistent failure must stay countable: the next window announces again, exactly once.
    await expect(emitSweepFailureAudit(passReport({ ...base, now: NOW + WEDGE_RENOTIFY_COOLDOWN_MS })))
      .resolves.toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("keys a candidate row per card and per arm, and never borrows the pass window", async () => {
    const { rows, store } = sink();
    const memo = new Map<string, number>();
    const base = { store: store as never, memo, now: NOW };

    await emitSweepFailureAudit(candidateReport({ ...base, taskId: "RUFU-A" }));
    await emitSweepFailureAudit(candidateReport({ ...base, taskId: "RUFU-A" }));
    await emitSweepFailureAudit(candidateReport({ ...base, taskId: "RUFU-A", stage: "no-verdict-recovery" }));
    await emitSweepFailureAudit(candidateReport({ ...base, taskId: "RUFU-B" }));
    await emitSweepFailureAudit(passReport(base));

    // 3 candidate arms (two cards + a second arm on the first card) plus one pass row.
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.mutationType === SWEEP_CANDIDATE_FAILURE_EVENT)).toHaveLength(3);
    expect(rows.filter((row) => row.mutationType === SWEEP_PASS_FAILURE_EVENT)).toHaveLength(1);
  });

  it("prunes stamps older than one window so the memo stays bounded and a stale stamp cannot be immortal", () => {
    const memo = new Map<string, number>([["stale", NOW - WEDGE_RENOTIFY_COOLDOWN_MS], ["future", NOW + 60_000]]);

    expect(claimSweepFailureEpisode(memo, sweepPassFailureKey("reconcile-abandoned-planning-sessions", NOW), NOW)).toBe(true);
    expect([...memo.keys()]).toEqual([
      sweepPassFailureKey("reconcile-abandoned-planning-sessions", NOW),
    ]);
  });

  it("builds each key from the sweep, the subject, and the bucket alone", () => {
    expect(sweepPassFailureKey("reconcile-abandoned-planning-sessions", NOW))
      .toBe(`reconcile-abandoned-planning-sessions:pass:${Math.floor(NOW / WEDGE_RENOTIFY_COOLDOWN_MS)}`);
    expect(sweepCandidateFailureKey("recover-review-tasks-with-failed-pre-merge-steps", "RUFU-A", "revive", NOW))
      .toBe(`recover-review-tasks-with-failed-pre-merge-steps:candidate:RUFU-A:revive:${Math.floor(NOW / WEDGE_RENOTIFY_COOLDOWN_MS)}`);
  });
});

describe("sweep failure audit — the row shape", () => {
  it("passes the whole pass failure through with a non-empty target and no taskId at all", async () => {
    const { rows, store } = sink();

    await emitSweepFailureAudit(passReport({ store: store as never, candidateFailureCount: 3 }));

    const [row] = rows;
    expect(row).toBeDefined();
    expect(row!.mutationType).toBe(SWEEP_PASS_FAILURE_EVENT);
    // RUFU-430: `target` is NOT NULL, and an absent `taskId` means "no card is attributable" — never "".
    expect(row!.target).toBe("recover-review-tasks-with-failed-pre-merge-steps");
    expect("taskId" in row!).toBe(false);
    expect(row!.agentId).toBe("self-healing");
    expect(row!.domain).toBe("database");
    expect(row!.metadata).toEqual({
      sweep: "recover-review-tasks-with-failed-pre-merge-steps",
      outcome: "aborted",
      candidateFailureCount: 3,
    });
  });

  it("carries the card id in both target and taskId on a candidate row and names the arm", async () => {
    const { rows, store } = sink();

    await emitSweepFailureAudit(candidateReport({ store: store as never, stage: "candidate-repair" as SweepFailureStage }));

    const [row] = rows;
    expect(row!.mutationType).toBe(SWEEP_CANDIDATE_FAILURE_EVENT);
    expect(row!.target).toBe("RUFU-898");
    expect(row!.taskId).toBe("RUFU-898");
    expect(row!.metadata).toEqual({
      sweep: "recover-review-tasks-with-failed-pre-merge-steps",
      taskId: "RUFU-898",
      stage: "candidate-repair",
    });
  });

  it("holds the exact metadata key set for every sweep and arm in the closed vocabularies", async () => {
    const { rows, store } = sink();

    for (const sweep of SWEEP_FAILURE_SWEEPS) {
      await emitSweepFailureAudit(passReport({ sweep, store: store as never, memo: new Map(), now: NOW }));
      for (const stage of SWEEP_FAILURE_STAGES) {
        await emitSweepFailureAudit(candidateReport({
          sweep, stage, store: store as never, memo: new Map(), now: NOW,
        }));
      }
    }

    expect(rows).toHaveLength(SWEEP_FAILURE_SWEEPS.length * (1 + SWEEP_FAILURE_STAGES.length));
    for (const row of rows) {
      const keys = Object.keys(row!.metadata as Record<string, unknown>).sort();
      expect(keys).toEqual(row!.mutationType === SWEEP_PASS_FAILURE_EVENT
        ? ["candidateFailureCount", "outcome", "sweep"]
        : ["stage", "sweep", "taskId"]);
      expect(String(row!.target).length).toBeGreaterThan(0);
    }
  });

  it("keeps an injected error sentence and filesystem path out of every part of the row", async () => {
    const { rows, store } = sink();
    const SENTINENCE = "ENOENT impossible-merge-recovery-sentence";
    const PATH = "/home/operator/.fusion/worktrees/secret-tree";

    await emitSweepFailureAudit(passReport({
      store: store as never,
      error: new Error(`${SENTINENCE} at ${PATH}`),
    }));
    await emitSweepFailureAudit(candidateReport({ store: store as never, error: `${SENTINENCE} ${PATH}` }));

    for (const row of rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(SENTINENCE);
      expect(serialized).not.toContain(PATH);
    }
  });

  it("makes an error prose unrepresentable: the metadata builder takes no error parameter", () => {
    expect(sweepFailureMetadata({ sweep: "reconcile-abandoned-planning-sessions" })).toEqual({
      sweep: "reconcile-abandoned-planning-sessions",
      outcome: "aborted",
      candidateFailureCount: 0,
    });
    // A candidate row needs BOTH the arm and the card; a half-report degrades to the pass shape.
    expect(sweepFailureMetadata({ sweep: "reconcile-abandoned-planning-sessions", stage: "candidate-repair" }))
      .toEqual({ sweep: "reconcile-abandoned-planning-sessions", outcome: "aborted", candidateFailureCount: 0 });
  });
});

describe("sweep failure audit — hostile sinks cannot become a lifecycle dependency", () => {
  const hostileSinks: Array<[string, unknown]> = [
    ["absent", {}],
    ["throwing", { recordRunAuditEvent: () => { throw new Error("sink exploded"); } }],
    ["rejecting", { recordRunAuditEvent: () => Promise.reject(new Error("sink rejected")) }],
    ["null store", null],
  ];

  it.each(hostileSinks)("a %s sink leaves the claimed episode and the caller's path unchanged", async (_name, store) => {
    const memo = new Map<string, number>();
    const base = { store: store as never, memo };
    const emitted = await emitSweepFailureAudit(passReport(base));

    // The row was claimed and handed to the seam; the seam absorbs the sink. The caller's `return 0`
    // is untouched, and the memo state is identical to the healthy case.
    expect(emitted).toBe(true);
    const second = await emitSweepFailureAudit(passReport(base));
    expect(second).toBe(false);
  });

  it("a never-settling sink returns inside the seam's own bound on fake timers", async () => {
    vi.useFakeTimers();
    const store = { recordRunAuditEvent: () => new Promise<never>(() => undefined) };
    const emitted = emitSweepFailureAudit(passReport({ store: store as never }));

    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 10);

    await expect(emitted).resolves.toBe(true);
  });
});

describe("sweep failure audit — declaration parity", () => {
  /*
  FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
  RUFU-263's lesson, cloned: `emitBoundedRunAudit`'s loose arm accepts ANY string, so an undeclared
  literal compiles silently and nothing fails until someone queries for the event. The stranded family
  guards itself in `stranded-continuation-owner-routing.test.ts`; this guards `sweep:*` the same way,
  scanning the module that owns the constants and the file that calls them.
  */
  const unionSource = readFileSync(new URL("../util/run-audit.ts", import.meta.url), "utf8");
  const emitterSources = [
    "../self-healing/sweep-failure-audit.ts",
    "../self-healing.ts",
  ].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));

  it("declares every sweep: event type it emits", () => {
    const unionStart = unionSource.indexOf("export type DatabaseMutationType");
    expect(unionStart).toBeGreaterThan(-1);
    const declared = new Set(
      (unionSource.slice(unionStart).match(/"([a-zA-Z]+:[a-zA-Z0-9:_-]+)"/g) ?? []).map((raw) => raw.slice(1, -1)),
    );

    const emitted = new Set<string>();
    for (const source of emitterSources) {
      for (const match of source.match(/"sweep:[a-z0-9-]+"/g) ?? []) emitted.add(match.slice(1, -1));
    }

    expect([...emitted].sort()).toEqual([SWEEP_CANDIDATE_FAILURE_EVENT, SWEEP_PASS_FAILURE_EVENT].sort());
    for (const event of emitted) expect(declared.has(event), event).toBe(true);
  });

  it("keeps the family out of the curated delivery-pipeline catalogue", async () => {
    const catalogue = await readFileSync(new URL("../run-audit/run-audit-catalogue.ts", import.meta.url), "utf8");
    expect(catalogue).not.toContain(SWEEP_PASS_FAILURE_EVENT);
    expect(catalogue).not.toContain(SWEEP_CANDIDATE_FAILURE_EVENT);
  });
});

/*
FNXC:SweepFailureAudit 2026-11-18-18:32 (RUFU-898) — Step 4, the ownership half:
RUFU-898's defect was that a swallow-and-continue catch produced NO observable trace, and the cheapest
way to reopen it is a future refactor that rewrites one of these methods and drops the emit while every
behavioral test stays green — the candidate/pass assertions here would fail, but only for the arms they
happen to drive. This is a structural guard on the two MEASURED instances: each named sweep's own body
must still carry its own observation, per arm, plus the pass-level candidate tally. It asserts code
constructs, never comments, so it cannot be appeased by restoring prose.
*/
describe("sweep failure audit — the two measured instances stay instrumented", () => {
  const selfHealingSource = readFileSync(new URL("../self-healing.ts", import.meta.url), "utf8");

  /** One method's source, from its declaration to the next `async` member of the class. */
  const methodBody = (signature: string) => {
    const start = selfHealingSource.indexOf(signature);
    expect(start, `missing sweep declaration: ${signature}`).toBeGreaterThan(-1);
    const next = selfHealingSource.indexOf("\n  async ", start + signature.length);
    return selfHealingSource.slice(start, next === -1 ? selfHealingSource.length : next);
  };

  it("keeps the review-revival sweep observing both of its arms and its pass-level abort", () => {
    const body = methodBody("async recoverReviewTasksWithFailedPreMergeSteps(");
    const emits = body.match(/emitSweepFailureAudit\(/g) ?? [];
    // Three arms were measured silent: the no-verdict re-seed, the revival, and the outer pass catch.
    expect(emits.length).toBeGreaterThanOrEqual(3);
    expect(body).toContain('sweep: "recover-review-tasks-with-failed-pre-merge-steps"');
    expect(body).toContain('stage: "no-verdict-recovery"');
    expect(body).toContain('stage: "revive"');
    // A pass row that lost its tally could no longer tell an early abort from late damage.
    expect(body).toContain("candidateFailureCount");
  });

  it("keeps the abandoned-planning sweep observing its candidate arm and its pass-level abort", () => {
    const body = methodBody("async reconcileAbandonedPlanningSessions(");
    const emits = body.match(/emitSweepFailureAudit\(/g) ?? [];
    expect(emits.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('sweep: "reconcile-abandoned-planning-sessions"');
    expect(body).toContain('stage: "candidate-repair"');
    expect(body).toContain("candidateFailureCount");
  });

  it("keeps every emitted sweep name a member of the closed vocabulary", () => {
    /*
    Scoped to the CALL SITE, not to every `sweep:` in the file: `self-healing.ts` already carries an
    unrelated `sweep: "stuck-in-progress"` label from another domain, and a ratchet that reads it as a
    family member is a false positive that would be "fixed" by widening the vocabulary.
    */
    const declared = new Set<string>(SWEEP_FAILURE_SWEEPS as readonly string[]);
    const emitted = [...selfHealingSource.matchAll(/emitSweepFailureAudit\(\{\s*\n?\s*sweep: "([a-z0-9-]+)"/g)]
      .map((match) => match[1]!);
    // Both measured instances really do call through the family, from inside the class.
    expect(new Set(emitted)).toEqual(new Set([
      "recover-review-tasks-with-failed-pre-merge-steps",
      "reconcile-abandoned-planning-sessions",
    ]));
    for (const sweep of emitted) expect(declared.has(sweep), sweep).toBe(true);
  });
});
