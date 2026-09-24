/*
 * RUFU-283: the row-presence authority has to name WHICH state holds an id.
 *
 * `taskIdExistsAnywhere` returns one boolean for three different facts — live row, soft-delete
 * tombstone, archive snapshot — and every consumer that has to explain a vanished card inherits that
 * collapse. RUFU-225 is the concrete cost: FN-6783's orphan re-import skipped re-import because the
 * id "existed somewhere", which was true of a tombstone and true of an absent row alike, so the
 * suppression was correct and silent either way. This test pins the distinction the boolean cannot
 * express, against the real backend rather than a fake that could not get it wrong.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("task-id presence names live, tombstoned, and absent (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_vanished_presence",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });
  afterAll(h.afterAll);

  it("separates a live row from a soft-delete tombstone and from a fully absent id", async () => {
    const store = h.store();
    const live = await store.createTask({ title: "live", description: "live", column: "todo" });
    const softDeleted = await store.createTask({ title: "gone", description: "gone", column: "todo" });
    await store.deleteTask(softDeleted.id);
    const absentId = `${live.id.slice(0, -3)}ZZZ`;

    const presence = await store.resolveTaskIdPresenceForIds([live.id, softDeleted.id, absentId]);

    expect(presence.get(live.id)).toMatchObject({
      rowExistsAnywhere: true,
      liveRowExists: true,
      tombstoned: false,
      inArchive: false,
    });

    // The tombstone is the state that used to be indistinguishable from "live": the id is still
    // reserved, so every create/duplicate/refine path refuses, yet no board read resolves it.
    expect(presence.get(softDeleted.id)).toMatchObject({
      rowExistsAnywhere: true,
      liveRowExists: false,
      tombstoned: true,
      inArchive: false,
    });
    expect(presence.get(softDeleted.id)!.tombstonedAt).toBeTruthy();

    // A fully absent id carries no presence row at all — the case FN-6783 was built for.
    expect(presence.has(absentId)).toBe(false);

    // The collapse this primitive exists to replace: the legacy boolean reports all three ids the
    // same way for the two that exist, and cannot tell a tombstone from a live card.
    await expect(store.taskIdExistsAnywhere(live.id)).resolves.toBe(true);
    await expect(store.taskIdExistsAnywhere(softDeleted.id)).resolves.toBe(true);
    await expect(store.taskIdExistsAnywhere(absentId)).resolves.toBe(false);
  });
});
