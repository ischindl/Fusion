import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_overlap_wait" });
const overlap = (id: string) => ({
  signature: `file-scope:${id}`,
  blockedBy: null,
  overlapBlockedBy: id,
  action: `queued behind ${id}`,
});

pgDescribe("overlap wait persistence", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("drains historical model-verdict phases idempotently without losing delivery proof", async () => {
    const [firstBlocker, secondBlocker, waiting] = await Promise.all([
      h.store().createTask({ description: "first holder" }),
      h.store().createTask({ description: "second holder" }),
      h.store().createTask({ description: "waiting" }),
    ]);
    await h.store().transitionQueuedEpisode(waiting.id, overlap(firstBlocker.id));
    await h.store().transitionQueuedEpisode(waiting.id, overlap(secondBlocker.id));
    const episodes = await h.store().listTaskOverlapWaits(waiting.id);
    await h.layer().db.execute(sql`ALTER TABLE project.task_overlap_waits DROP CONSTRAINT ck_task_overlap_wait_phase`);
    await h.layer().db.execute(sql`ALTER TABLE project.task_overlap_waits ADD CONSTRAINT ck_task_overlap_wait_phase CHECK (phase IN ('observed','analyzing','freshness-pending','revalidation-pending','repair-required','ready','delivered','cancelled'))`);
    await h.layer().db.execute(sql`UPDATE project.task_overlap_waits SET phase = 'revalidation-pending', receipt = ${JSON.stringify({ decision: "revalidate", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [{ repository: ".", landedSha: "abc" }], decisionFingerprint: "old-1", briefing: "Use the delivered shared contract", revalidationVerdict: "REVISE", invalidatedPromise: "old promise", decidedAt: new Date().toISOString() })}::jsonb WHERE episode_id = ${episodes[0]!.episodeId}`);
    await h.layer().db.execute(sql`UPDATE project.task_overlap_waits SET phase = 'repair-required', receipt = ${JSON.stringify({ decision: "revalidate", freshness: "proven", commonFiles: [], deliveryProofs: [{ repository: ".", landedSha: "def" }], decisionFingerprint: "old-2", revalidationVerdict: "REVISE", invalidatedPromise: "old promise", decidedAt: new Date().toISOString() })}::jsonb WHERE episode_id = ${episodes[1]!.episodeId}`);
    const migration = await readFile(new URL("../../postgres/migrations/0078_fn_375_overlap_revalidation_drain.sql", import.meta.url), "utf8");
    await h.layer().db.execute(sql.raw(migration));
    await h.layer().db.execute(sql.raw(migration));

    const drained = await h.store().listTaskOverlapWaits(waiting.id);
    expect(drained).toHaveLength(2);
    expect(drained.every((episode) => episode.phase === "ready")).toBe(true);
    expect(drained.find((episode) => episode.episodeId === episodes[0]!.episodeId)?.receipt).toMatchObject({ decision: "briefing", deliveryProofs: [{ landedSha: "abc" }] });
    expect(drained.find((episode) => episode.episodeId === episodes[1]!.episodeId)?.receipt).toMatchObject({ decision: "resume", deliveryProofs: [{ landedSha: "def" }] });
    expect(JSON.stringify(drained)).not.toMatch(/revalidationVerdict|invalidatedPromise/);
  });

  it("keeps one durable episode when an identical wait is republished and its marker clears", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null, status: null });

    const episodes = await h.store().listTaskOverlapWaits(waiting.id);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ blockerTaskId: blocker.id, phase: "observed", revision: 1 });
  });

  it("preserves A then C as separate unconsumed observations", async () => {
    const [a, c, waiting] = await Promise.all([
      h.store().createTask({ description: "A" }),
      h.store().createTask({ description: "C" }),
      h.store().createTask({ description: "waiting" }),
    ]);
    await h.store().transitionQueuedEpisode(waiting.id, overlap(a.id));
    await h.store().transitionQueuedEpisode(waiting.id, overlap(c.id));
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null, status: null });
    expect((await h.store().listTaskOverlapWaits(waiting.id, { pendingOnly: true })).map((row) => row.blockerTaskId)).toEqual([a.id, c.id]);
  });

  it("fences stale owners and writes the release receipt with its task log atomically", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
    expect(claim?.phase).toBe("analyzing");
    await expect(h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-2" })).resolves.toBeNull();

    const receipt = {
      decision: "briefing" as const,
      freshness: "proven" as const,
      commonFiles: ["src/shared.ts"],
      deliveryProofs: [{ repository: ".", landedSha: "abc", landedFiles: ["src/shared.ts"] }],
      decisionFingerprint: "decision-1",
      decidedAt: new Date().toISOString(),
    };
    const completed = await h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1", receipt });
    expect(completed).toMatchObject({ phase: "ready", receipt });
    expect((await h.store().getTask(waiting.id)).log?.filter((entry) => entry.dedupeKey?.startsWith("overlap-wait-release:"))).toHaveLength(1);
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
  The nominal path: a task WITH a plan, claiming and publishing a complete unchanged execution identity, must
  be released. This case was absent, and the identity fence was consequently never exercised end to end — the
  positive test below passes NO identity (short-circuiting the comparison) and the negative tests expect a
  refusal, which the defect produced for the wrong reason. FN-359/FN-362 were refused 122 times each because
  publication compared the caller's prompt hash against `sha256(row.prompt)` on a table with no `prompt` column.
  */
  it("releases a planned task whose execution identity is unchanged between claim and publication", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse `sharedApi`", worktree: "/work/waiting", branch: "fusion/waiting", branchWriteOrigin: "engine", checkoutLeaseEpoch: 3 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const live = await h.store().getTask(waiting.id);
    const identity = {
      taskLineageId: live.lineageId,
      planFingerprint: createHash("sha256").update(live.prompt!).digest("hex"),
      checkoutEpoch: "3",
      worktree: "/work/waiting",
      branch: "fusion/waiting",
      headSha: "head-1",
      repository: ".",
    };
    const claim = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-1", checkoutEpoch: "3", executionIdentity: identity,
    });
    expect(claim).toMatchObject({ phase: "analyzing", planFingerprint: identity.planFingerprint });

    const completed = await h.store().completeTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1",
      executionIdentity: identity,
      receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "decision-1", decidedAt: new Date().toISOString() },
    });
    expect(completed).toMatchObject({ phase: "ready" });
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
  A claim must never erase the durable plan fingerprint. Freshness publication compares the live plan
  identity against this durable claim; a null-wipe would make a stale generation appear current.
  */
  it("preserves the durable plan fingerprint across a claim that supplies no identity", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const first = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-1", executionIdentity: { planFingerprint: "plan-1" },
    });
    expect(first?.planFingerprint).toBe("plan-1");
    const reclaimed = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: first!.revision, owner: "executor-2",
    });
    expect(reclaimed?.planFingerprint).toBe("plan-1");
  });

  it("rejects a completion after the claimed plan or checkout identity changes", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse old contract", worktree: "/work/old", checkoutLeaseEpoch: 1 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    expect((await h.store().getTask(waiting.id)).prompt).toBe("## Mission\nUse old contract");
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = {
      planFingerprint: createHash("sha256").update("## Mission\nUse old contract").digest("hex"),
      worktree: "/work/old",
      checkoutEpoch: "1",
      headSha: "head-old",
      repository: ".",
    };
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1", checkoutEpoch: "1", executionIdentity: identity });
    expect(claim).not.toBeNull();
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse new contract", worktree: "/work/new" });
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id,
      episodeId: observed.episodeId,
      expectedRevision: claim!.revision,
      owner: "executor-1",
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "stale", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-13-05:10:
  Runtime completion accepts only the remaining deterministic overlap phases; retired model-revalidation
  phases are exercised by the historical-drain test above rather than submitted through the live contract.
  */
  it.each(["freshness-pending", "ready", "delivered"] as const)(
    "persists the %s phase declared by OverlapWaitPhase",
    async (phase) => {
      const blocker = await h.store().createTask({ description: "holder" });
      const waiting = await h.store().createTask({ description: "waiting" });
      await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
      const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
      const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
      const completed = await h.store().completeTaskOverlapWait({
        taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1", phase,
        receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: `phase-${phase}`, decidedAt: new Date().toISOString() },
      });
      expect(completed).toMatchObject({ phase });
    },
  );

  it("rejects completion when the claimed checkout epoch disappears from the durable task", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: 7 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = { checkoutEpoch: "7" };
    const claim = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-epoch", checkoutEpoch: "7", executionIdentity: identity,
    });
    expect(claim).not.toBeNull();

    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: null } as any);
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision,
      owner: "executor-epoch", executionIdentity: identity,
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "epoch-cleared", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("analyzing");
  });

  it("keeps merger-published workspace rename and deletion proof after the blocker is deleted", async () => {
    const blocker = await h.store().createTask({ description: "workspace holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().publishTaskOverlapDeliveries(blocker.id, [
      { blockerTaskId: blocker.id, blockerLineageId: blocker.lineageId, repository: "repo-a", target: "main", landedSha: "sha-repo-a", evidence: "workspace-landing", paths: [{ repository: "repo-a", previousPath: "src/old.ts", path: "src/shared.ts", status: "renamed" }] },
      { blockerTaskId: blocker.id, blockerLineageId: blocker.lineageId, repository: "repo-b", target: "main", landedSha: "sha-repo-b", evidence: "workspace-landing", paths: [{ repository: "repo-b", path: "src/other.ts", status: "deleted" }] },
    ]);
    await h.store().deleteTask(blocker.id);

    const [episode] = await h.store().listTaskOverlapWaits(waiting.id);
    expect((episode?.observation as any)?.deliveries).toEqual([
      expect.objectContaining({ repository: "repo-a", paths: [{ repository: "repo-a", previousPath: "src/old.ts", path: "src/shared.ts", status: "renamed" }] }),
      expect.objectContaining({ repository: "repo-b", paths: [{ repository: "repo-b", path: "src/other.ts", status: "deleted" }] }),
    ]);
  });

  it("rejects recaptured HEAD, target, repository, node incarnation, and checkout epoch races", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: 1, checkoutNodeId: "execute" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = { taskLineageId: waiting.lineageId, planFingerprint: "plan-1", headSha: "head-1", repository: "repo-a", target: "main", nodeId: "execute", nodeInstanceId: "instance-1", checkoutEpoch: "1" };
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1", checkoutEpoch: "1", executionIdentity: identity });
    expect(claim).not.toBeNull();
    for (const patch of [
      { headSha: "head-2" }, { repository: "repo-b" }, { target: "release" },
      { nodeId: "verify" }, { nodeInstanceId: "instance-2" }, { checkoutEpoch: "2" },
      // A plan revision landing mid-analysis must still refuse publication.
      { planFingerprint: "plan-2" },
    ]) {
      await expect(h.store().completeTaskOverlapWait({
        taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1",
        executionIdentity: { ...identity, ...patch },
        receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "race", decidedAt: new Date().toISOString() },
      })).resolves.toBeNull();
    }
  });

  it("invalidates an in-flight generation on Reset", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
    await h.store().resetTaskPublication(waiting.id, "triage");
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id,
      episodeId: observed.episodeId,
      expectedRevision: claim!.revision,
      owner: "executor-1",
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "stale", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("cancelled");
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-15-22:24:
  The row half of the drift probe asserted on its own. The existing drain test applies the migration SQL
  directly, so it never exercises the probe that decides whether an upgraded database still needs the drain.
  A database can already carry the rebuilt 6-phase constraint and still hold the retired rows the drain exists
  to migrate, and that is exactly where the probe must keep reporting work: if only the constraint half were
  wired these rows would stay stranded forever while the migration read as permanently applied. The fixture
  first proves this harness is steady-state, so nothing else can explain the later apply, then re-creates the
  constraint NOT VALID over the current 6-phase definition. NOT VALID states that separation honestly: it lets
  the fixture keep a retired row PostgreSQL would otherwise reject, so no row is deleted to set the case up,
  while pg_get_constraintdef reports none of the retired phases — the constraint half answering `false`.
  */
  it("applies the drain through the probe when only the retired-phase rows drifted", async () => {
    const blocker = await h.store().createTask({ description: "row-half holder" });
    const waiting = await h.store().createTask({ description: "row-half waiter" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const episode = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const db = h.layer().db;

    const phaseConstraint = async () => ((await db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
      FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'project'
         AND t.relname = 'task_overlap_waits'
         AND c.conname = 'ck_task_overlap_wait_phase'
    `)) as unknown as Array<{ def: string; validated: boolean }>)[0]!;

    // Control: the steady-state harness must report no drift, or the later apply proves nothing.
    await expect(applySchemaBaseline(db, { pluginHooks: [] })).resolves.toEqual({ applied: false, pluginHooksRun: 0 });

    // Retire the row under the widened 8-phase definition, then restore the 6-phase CHECK as NOT VALID so the
    // row survives while the constraint half of the probe reads clean.
    await db.execute(sql`ALTER TABLE project.task_overlap_waits DROP CONSTRAINT ck_task_overlap_wait_phase`);
    await db.execute(sql`
      ALTER TABLE project.task_overlap_waits
        ADD CONSTRAINT ck_task_overlap_wait_phase
        CHECK (phase IN ('observed','analyzing','freshness-pending','revalidation-pending','repair-required','ready','delivered','cancelled'))
    `);
    await db.execute(sql`UPDATE project.task_overlap_waits SET phase = 'revalidation-pending' WHERE episode_id = ${episode.episodeId}`);
    await db.execute(sql`ALTER TABLE project.task_overlap_waits DROP CONSTRAINT ck_task_overlap_wait_phase`);
    await db.execute(sql`
      ALTER TABLE project.task_overlap_waits
        ADD CONSTRAINT ck_task_overlap_wait_phase
        CHECK (phase IN ('observed','analyzing','freshness-pending','ready','delivered','cancelled')) NOT VALID
    `);

    const retiredRowOnly = await phaseConstraint();
    expect(retiredRowOnly.def).toMatch(/CHECK/);
    expect(retiredRowOnly.def).not.toMatch(/revalidation-pending|repair-required/);

    // Only the row half can explain this apply.
    await expect(applySchemaBaseline(db, { pluginHooks: [] })).resolves.toEqual({ applied: true, pluginHooksRun: 0 });

    const drained = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    expect(drained.phase).toBe("ready");
    const drainedConstraint = await phaseConstraint();
    expect(drainedConstraint.validated).toBe(true);
    expect(drainedConstraint.def).not.toMatch(/revalidation-pending|repair-required/);

    // The probe must not re-fire on a database that is now genuinely drained.
    await expect(applySchemaBaseline(db, { pluginHooks: [] })).resolves.toEqual({ applied: false, pluginHooksRun: 0 });
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
  FN-429. A delivery rewritten by an integration-branch rebase keeps its patch and Fusion trailers while
  changing SHA, so the proven rewrite must survive in the durable receipt: that is what lets Retry, an engine
  restart, or a deleted worktree resume without re-deriving the proof. The revision/owner fence stays the sole
  admission, so a stale revision or a foreign owner still publishes nothing.
  */
  it("round-trips a reconciled rewritten delivery proof under the revision and owner fence", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
    const receipt = {
      decision: "briefing" as const,
      freshness: "proven" as const,
      commonFiles: ["src/shared.ts"],
      deliveryProofs: [{ repository: ".", target: "main", landedSha: "9ff2f99683c6", reconciledSha: "b98b32fd4b96", reconciliationProof: "patch-id+task-trailer", landedFiles: ["src/shared.ts"], freshness: "proven" as const }],
      decisionFingerprint: "reconciled-1",
      decidedAt: new Date().toISOString(),
    };

    await expect(h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1", receipt })).resolves.toBeNull();
    await expect(h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-2", receipt })).resolves.toBeNull();
    const completed = await h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1", receipt });

    expect(completed?.receipt?.deliveryProofs[0]).toMatchObject({ landedSha: "9ff2f99683c6", reconciledSha: "b98b32fd4b96", reconciliationProof: "patch-id+task-trailer" });
    const reread = (await h.store().listTaskOverlapWaits(waiting.id))[0];
    expect(reread?.receipt?.deliveryProofs[0]).toMatchObject({ landedSha: "9ff2f99683c6", reconciledSha: "b98b32fd4b96", reconciliationProof: "patch-id+task-trailer" });
  });
});
