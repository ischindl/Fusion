import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  seedPreExistingTaskIdDuplicate,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { TaskStore } from "../../store.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_queued_episode" });

const dependency = (ids: string[]) => ({
  signature: `dependency:${[...new Set(ids)].sort().join(",")}`,
  blockedBy: ids[0] ?? null,
  overlapBlockedBy: null,
  action: `queued — unmet dependencies: ${ids.join(", ")}`,
});
const overlap = (id: string) => ({
  signature: `file-scope:${id}`,
  blockedBy: null,
  overlapBlockedBy: id,
  action: `queued — waiting for active file-scope lease ${id}`,
});

/*
FNXC:QueuedTaskLogging 2026-11-10-17:50 (RUFU-412):
The reported defect was invisible churn: the log row was already suppressed while the row write, the
`task.json` mirror rewrite, and the `task:updated` emit ran on every pass. A green log assertion
therefore proves nothing about the fix, so these cases measure the three write surfaces directly:
`updatedAt` read straight off the `tasks` row through the admin connection (never through a store read
that could itself write), the mirror's mtime (`writeTaskJsonFile` writes a tmp file and renames it, so
any rewrite moves it), and call counts on the two public store methods the seam calls. The admin read
keeps the observation side-effect-free: a reader that wrote the mirror would make the mtime signal
measure the observation instead of the transition.
*/
const readQueueRow = (taskId: string) => h.adminDb().select({
  status: schema.project.tasks.status,
  blockedBy: schema.project.tasks.blockedBy,
  overlapBlockedBy: schema.project.tasks.overlapBlockedBy,
  queuedLogEpisodeSignature: schema.project.tasks.queuedLogEpisodeSignature,
  updatedAt: schema.project.tasks.updatedAt,
}).from(schema.project.tasks).where(and(
  eq(schema.project.tasks.projectId, "__legacy_unscoped__"),
  eq(schema.project.tasks.id, taskId),
)).then((rows) => rows[0]!);

const queueWriteSpies = (store: TaskStore) => ({
  mirror: vi.spyOn(store, "writeTaskJsonFile"),
  emit: vi.spyOn(store, "emitTaskLifecycleEventSafely"),
  cleared() {
    this.mirror.mockClear();
    this.emit.mockClear();
  },
});

const mirrorMtimeMs = async (taskId: string) => (await stat(join(h.store().taskDir(taskId), "task.json"))).mtimeMs;

const queuedLogLines = async (taskId: string) => {
  const task = await h.store().getTask(taskId);
  return (task?.log ?? []).filter((entry) => entry.action.startsWith("queued —")).length;
};

pgDescribe("queued episode transition", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.afterEach();
  });

  it("logs once for an unchanged full dependency episode and again when its full set changes", async () => {
    const task = await h.store().createTask({ description: "queued task" });
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-B"]))).appended).toBe(true);
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-B"]))).appended).toBe(false);
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-C"]))).appended).toBe(true);
    const updated = await h.store().getTask(task.id);
    expect(updated.blockedBy).toBe("FN-A");
    expect(updated.log?.filter((entry) => entry.action.startsWith("queued — unmet dependencies"))).toHaveLength(2);
  });

  it("switches queue kind and re-arms after a cleared state", async () => {
    const task = await h.store().createTask({ description: "queue boundaries" });
    await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A"]));
    await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"));
    await h.store().updateTask(task.id, { status: null, blockedBy: null, overlapBlockedBy: null });
    expect((await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
    const updated = await h.store().getTask(task.id);
    expect(updated.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(3);
  });

  it("serializes separate-store producers and keeps the committed episode suppressed after reconstruction", async () => {
    const task = await h.store().createTask({ description: "concurrent queue" });
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      migrationUrlOverridden: true,
      directSessionUrl: h.testUrl(),
      directSessionProvenance: "migration-override",
    };
    const [connections, root] = await Promise.all([
      createConnectionSetFromUrl(backend, { projectId: "", useRuntimeRole: true }),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-reconstructed-")),
    ]);
    try {
      const reconstructed = new TaskStore(root, undefined, {
        asyncLayer: createAsyncDataLayer(connections, { projectId: "" }),
      });
      const results = await Promise.all(Array.from(
        { length: 8 },
        (_, index) => (index % 2 === 0 ? h.store() : reconstructed).transitionQueuedEpisode(task.id, overlap("FN-LOCK")),
      ));
      expect(results.filter((result) => result.appended)).toHaveLength(1);
      expect((await reconstructed.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(false);
      const row = (await h.adminDb().select().from(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, "__legacy_unscoped__"),
        eq(schema.project.tasks.id, task.id),
      )))[0];
      expect(row?.queuedLogEpisodeSignature).toBe("file-scope:FN-LOCK");
      expect((await reconstructed.getTask(task.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
    } finally {
      await Promise.allSettled([connections.close(), rm(root, { recursive: true, force: true })]);
    }
  });

  it("keeps same task IDs isolated between projects", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      migrationUrlOverridden: true,
      directSessionUrl: h.testUrl(),
      directSessionProvenance: "migration-override",
    };
    const [connectionsA, connectionsB, rootA, rootB] = await Promise.all([
      createConnectionSetFromUrl(backend, { projectId: "project-a", useRuntimeRole: true }),
      createConnectionSetFromUrl(backend, { projectId: "project-b", useRuntimeRole: true }),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-a-")),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-b-")),
    ]);
    try {
      const layerA = createAsyncDataLayer(connectionsA, { projectId: "project-a" });
      const layerB = createAsyncDataLayer(connectionsB, { projectId: "project-b" });
      const storeA = new TaskStore(rootA, undefined, { asyncLayer: layerA });
      const storeB = new TaskStore(rootB, undefined, { asyncLayer: layerB });
      const now = new Date().toISOString();
      const row = { id: "FN-SAME", description: "same id", column: "todo", currentStep: 0, createdAt: now, updatedAt: now };
      await insertTaskRow(layerA, row, { lineageId: null });
      /*
      FNXC:TaskIdGlobalUniqueness 2026-11-08-10:37 (RUFU-320):
      The sibling row is copied in through the admin connection rather than created: the DB-wide id claim
      now refuses a second project's write of a claimed id. This fixture models a duplicate that PREDATES
      the claim table, which is the state whose partition isolation still has to be guarded.
      */
      await seedPreExistingTaskIdDuplicate(h.adminDb(), {
        taskId: row.id,
        fromProjectId: "project-a",
        toProjectId: "project-b",
      });

      await expect(Promise.all([
        storeA.transitionQueuedEpisode(row.id, overlap("FN-LOCK")),
        storeB.transitionQueuedEpisode(row.id, overlap("FN-LOCK")),
      ])).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ appended: true }),
        expect.objectContaining({ appended: true }),
      ]));
      expect((await storeA.getTask(row.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
      expect((await storeB.getTask(row.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
    } finally {
      await Promise.allSettled([
        connectionsA.close(), connectionsB.close(), rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true }),
      ]);
    }
  });

  it("rolls back queue fields, marker, and log together when persistence fails", async () => {
    const task = await h.store().createTask({ description: "rollback queue transition" });
    await h.adminDb().execute(sql.raw(`
      CREATE FUNCTION public.fail_queued_episode_transition_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = '${task.id}' THEN RAISE EXCEPTION 'forced queued episode failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_queued_episode_transition_for_test
      BEFORE UPDATE ON project.tasks FOR EACH ROW EXECUTE FUNCTION public.fail_queued_episode_transition_for_test();
    `));
    try {
      await expect(h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).rejects.toThrow("Failed query");
      const rolledBack = await h.store().getTask(task.id);
      expect(rolledBack?.status).not.toBe("queued");
      expect(rolledBack?.queuedLogEpisodeSignature).toBeUndefined();
      expect(rolledBack?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(0);
    } finally {
      await h.adminDb().execute(sql.raw(`
        DROP TRIGGER fail_queued_episode_transition_for_test ON project.tasks;
        DROP FUNCTION public.fail_queued_episode_transition_for_test();
      `));
    }
    expect((await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
  });

  /*
  FNXC:QueuedTaskLogging 2026-11-10-17:50 (RUFU-412):
  Symptom verification. Reported 2026-09-29: 44 cards waiting behind one stationary file-scope lease
  holder had `updatedAt` advanced across one scheduler pass (13:19:31.361Z to 13:22:27.713Z) and their
  `task.json` mtimes matched those stamps, while their log carried no new entry, which proved the
  append guard was already false. The pre-fix build fails every case below whose name says "writes
  nothing": the row's `updatedAt` moves, the mirror mtime moves, and both spies record a call.
  */
  it("writes nothing on a repeated identical episode: no row update, no mirror rewrite, no event", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "queue pass N+1" });
    expect((await store.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);

    const firstRow = await readQueueRow(task.id);
    const firstMtime = await mirrorMtimeMs(task.id);
    const firstLines = await queuedLogLines(task.id);
    const spies = queueWriteSpies(store);

    expect((await store.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(false);

    const afterRow = await readQueueRow(task.id);
    expect(afterRow.updatedAt).toBe(firstRow.updatedAt);
    expect(await mirrorMtimeMs(task.id)).toBe(firstMtime);
    expect(await queuedLogLines(task.id)).toBe(firstLines);
    expect(spies.mirror).not.toHaveBeenCalled();
    expect(spies.emit).not.toHaveBeenCalled();
    // The public return still answers for the card as the row stands, log included.
    const returned = await store.transitionQueuedEpisode(task.id, overlap("FN-LOCK"));
    expect(returned.appended).toBe(false);
    expect(returned.task.status).toBe("queued");
    expect(returned.task.updatedAt).toBe(firstRow.updatedAt);
    expect((returned.task.log ?? []).filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(firstLines);
  });

  it("writes again when only the blocker changes under an unchanged signature", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "blocker correction" });
    const episode = {
      signature: "dependency:FN-A,FN-B",
      blockedBy: "FN-A",
      overlapBlockedBy: null,
      action: "queued — unmet dependencies: FN-A, FN-B",
    };
    await store.transitionQueuedEpisode(task.id, episode);
    const before = await readQueueRow(task.id);
    const spies = queueWriteSpies(store);

    expect((await store.transitionQueuedEpisode(task.id, { ...episode, blockedBy: "FN-B" })).appended).toBe(true);

    const after = await readQueueRow(task.id);
    expect(after.blockedBy).toBe("FN-B");
    // A signature-only match must never authorize the skip: the signature deliberately did not move.
    expect(after.queuedLogEpisodeSignature).toBe(episode.signature);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(spies.mirror).toHaveBeenCalledTimes(1);
    expect(spies.emit).toHaveBeenCalledTimes(1);
    expect(await queuedLogLines(task.id)).toBe(2);
  });

  it("writes again on a queue-kind switch and on a re-arm after a cleared state", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "kind switch writes" });
    await store.transitionQueuedEpisode(task.id, dependency(["FN-A"]));
    const spies = queueWriteSpies(store);

    expect((await store.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
    expect(spies.mirror).toHaveBeenCalledTimes(1);
    expect(spies.emit).toHaveBeenCalledTimes(1);
    expect((await readQueueRow(task.id)).overlapBlockedBy).toBe("FN-LOCK");

    spies.cleared();
    await store.updateTask(task.id, { status: null, blockedBy: null, overlapBlockedBy: null });
    spies.cleared();
    expect((await store.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
    expect(spies.mirror).toHaveBeenCalledTimes(1);
    expect(spies.emit).toHaveBeenCalledTimes(1);
  });

  it("treats null blocker columns as matching an explicit null, and still writes a real change", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "null normalization" });
    // A queued card whose blocker columns are SQL NULL and whose signature already matches: the `?? null`
    // normalization must read that as no change, or every waiting card would be re-stamped forever.
    await h.layer().db.execute(sql`UPDATE project.tasks SET status='queued', blocked_by=NULL, overlap_blocked_by=NULL,
      queued_log_episode_signature='file-scope:FN-LOCK' WHERE id=${task.id}`);
    const before = await readQueueRow(task.id);
    expect(before.blockedBy).toBeNull();
    const spies = queueWriteSpies(store);

    expect((await store.transitionQueuedEpisode(task.id, {
      signature: "file-scope:FN-LOCK",
      blockedBy: null,
      overlapBlockedBy: null,
      action: "queued — waiting for active file-scope lease FN-LOCK",
    })).appended).toBe(false);
    expect(spies.mirror).not.toHaveBeenCalled();
    expect(spies.emit).not.toHaveBeenCalled();
    expect((await readQueueRow(task.id)).updatedAt).toBe(before.updatedAt);

    // The same card gaining a real blocker is a real edge and must never be swallowed by normalization.
    expect((await store.transitionQueuedEpisode(task.id, overlap("FN-OTHER"))).appended).toBe(true);
    expect(spies.mirror).toHaveBeenCalledTimes(1);
    expect(spies.emit).toHaveBeenCalledTimes(1);
    const after = await readQueueRow(task.id);
    expect(after.overlapBlockedBy).toBe("FN-OTHER");
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it("leaves every waiting card untouched on a second full pass behind one holder", async () => {
    const store = h.store();
    const holder = await store.createTask({ description: "stationary lease holder" });
    const waiters = await Promise.all([1, 2, 3].map((index) => store.createTask({ description: `waiter ${index}` })));
    for (const waiter of waiters) {
      expect((await store.transitionQueuedEpisode(waiter.id, overlap(holder.id))).appended).toBe(true);
    }
    const before = await Promise.all(waiters.map((waiter) => readQueueRow(waiter.id)));
    const mtimes = await Promise.all(waiters.map((waiter) => mirrorMtimeMs(waiter.id)));
    const lines = await Promise.all(waiters.map((waiter) => queuedLogLines(waiter.id)));
    const spies = queueWriteSpies(store);

    for (const waiter of waiters) {
      expect((await store.transitionQueuedEpisode(waiter.id, overlap(holder.id))).appended).toBe(false);
    }

    expect(spies.mirror).not.toHaveBeenCalled();
    expect(spies.emit).not.toHaveBeenCalled();
    for (const [index, waiter] of waiters.entries()) {
      expect((await readQueueRow(waiter.id)).updatedAt).toBe(before[index]!.updatedAt);
      expect(await mirrorMtimeMs(waiter.id)).toBe(mtimes[index]);
      expect(await queuedLogLines(waiter.id)).toBe(lines[index]);
    }
  });

  it("keeps observing overlap-wait evidence on the pass that writes nothing", async () => {
    const store = h.store();
    const blocker = await store.createTask({ description: "predecessor" });
    const waiter = await store.createTask({ description: "waiter" });
    await store.transitionQueuedEpisode(waiter.id, overlap(blocker.id));
    const observed = (await store.listTaskOverlapWaits(waiter.id, { pendingOnly: true }))[0]!;
    expect(observed).toMatchObject({ blockerTaskId: blocker.id, phase: "observed" });
    const rowBefore = await readQueueRow(waiter.id);
    const spies = queueWriteSpies(store);

    expect((await store.transitionQueuedEpisode(waiter.id, overlap(blocker.id))).appended).toBe(false);
    expect(spies.mirror).not.toHaveBeenCalled();
    expect((await readQueueRow(waiter.id)).updatedAt).toBe(rowBefore.updatedAt);
    expect((await store.listTaskOverlapWaits(waiter.id, { pendingOnly: true })).map((wait) => wait.blockerTaskId))
      .toContain(blocker.id);

    /*
    FNXC:QueuedTaskLogging 2026-11-10-17:50 (RUFU-412):
    The re-arm half is the proof that returning before the UPDATE did not return before the
    observation: Reset stamps the wait, and the next otherwise-identical episode must still re-arm it
    while the tasks row stays byte-identical. `overlap-wait-release.pg.test.ts` covers the same
    re-arm from the release side; it belongs here too because the skip and the observation share
    this one transaction.
    */
    await store.resetTaskPublication(blocker.id, "todo");
    spies.cleared();
    const stamped = (await store.listTaskOverlapWaits(waiter.id, { pendingOnly: true }))[0]!;
    expect(stamped.observation.blockerResetAt).toEqual(expect.any(String));
    const rowBeforeRequeue = await readQueueRow(waiter.id);

    expect((await store.transitionQueuedEpisode(waiter.id, overlap(blocker.id))).appended).toBe(false);

    const rearmed = (await store.listTaskOverlapWaits(waiter.id, { pendingOnly: true }))[0]!;
    expect(rearmed.revision).toBeGreaterThan(stamped.revision);
    expect(rearmed.observation.previousBlockerResetAt).toEqual(expect.any(String));
    expect(rearmed.observation.blockerResetAt).toBeUndefined();
    expect((await readQueueRow(waiter.id)).updatedAt).toBe(rowBeforeRequeue.updatedAt);
    expect(spies.mirror).not.toHaveBeenCalled();
    expect(spies.emit).not.toHaveBeenCalled();
  });
});
