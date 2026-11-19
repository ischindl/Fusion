/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
`lockCurrentPlanWhilePlanningLocked` is the single production site that throws
`UnavailablePlanLockError`, and all three approval surfaces (triage finalization, the graph Plan Review
node, the dashboard human-approve route) call it. Classifying the refusal HERE is therefore the whole
named-cause contract; asserting it anywhere less would leave the funnel free to throw a verdict-less
error while a probe elsewhere looked correct.

The three live-state inputs the probe cannot derive from text are exercised separately, because each
changes the sentence an operator reads: the spec path (from `store.taskDir`), the pause state (read from
the live row, not from the caller), and the on-disk spec's absence (the caller's prompt string survives a
deleted file, so only the disk read can name that class).
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { isUnavailablePlanLockError } from "../../planner/spec-lock.js";
import type { TaskStore } from "../../store.js";

const MISSIONLESS_SPEC = `# Task: FN-7001 - Widget with no mission

## File Scope

- packages/core/src/widget.ts

## Steps

1. Build widget

## Completion Criteria

- [ ] Widget works
`;

const LOCKABLE_SPEC = MISSIONLESS_SPEC.replace(
  "## File Scope",
  "## Mission\n\nBuild a widget whose plan locks.\n\n## File Scope",
);

pgDescribe("spec-lock unavailable probe carried by the store funnel (RUFU-535)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_spec_lock_probe" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });
  afterEach(h.afterEach);

  async function cardWithSpec(spec: string | null) {
    const task = await store.createTask({ description: "Widget with a mission-less spec" });
    const promptPath = join(store.taskDir(task.id), "PROMPT.md");
    await mkdir(store.taskDir(task.id), { recursive: true });
    await rm(promptPath, { force: true });
    if (spec !== null) await writeFile(promptPath, spec, "utf8");
    return { task, promptPath };
  }

  it("carries the named cause, the spec path, and the recovery owner on the thrown error", async () => {
    const { task, promptPath } = await cardWithSpec(MISSIONLESS_SPEC);

    const error = await store.lockCurrentPlan(task.id, "fingerprint", MISSIONLESS_SPEC).catch((err: unknown) => err);
    expect(isUnavailablePlanLockError(error)).toBe(true);
    if (!isUnavailablePlanLockError(error)) return;

    expect(error.reason).toBe("mission-missing");
    expect(error.unavailableSections).toEqual(["mission"]);
    // The legacy string contract three fixtures pin stays byte-exact even with a verdict attached.
    expect(error.message).toBe("Cannot lock an unavailable plan: mission-missing");

    const probe = error.probe;
    expect(probe).toBeDefined();
    expect(probe).toMatchObject({
      status: "unavailable",
      reason: "mission-missing",
      missingSection: "mission",
      expectedHeading: "## Mission",
      disposition: "unapprovable",
      recoveryOwner: "planner-respec",
    });
    expect(probe?.promptPath).toBe(promptPath);
    expect(probe?.summary).toContain(task.id);
    expect(probe?.summary).toContain(promptPath);
    expect(probe?.summary).toContain("## Mission");
    expect(probe?.summary).not.toContain("Operator description headings are not the cause");
  });

  it("hands the recovery to the operator when the live row is paused", async () => {
    const { task } = await cardWithSpec(MISSIONLESS_SPEC);
    await store.updateTask(task.id, { userPaused: true, paused: true });

    const error = await store.lockCurrentPlan(task.id, "fingerprint", MISSIONLESS_SPEC).catch((err: unknown) => err);
    if (!isUnavailablePlanLockError(error)) throw new Error("expected an unavailable plan lock error");
    expect(error.probe).toMatchObject({ disposition: "unapprovable", recoveryOwner: "operator" });
  });

  it("names an absent on-disk spec as prompt-file-missing even when the caller supplied prompt text", async () => {
    const { task, promptPath } = await cardWithSpec(null);

    const error = await store.lockCurrentPlan(task.id, "fingerprint", MISSIONLESS_SPEC).catch((err: unknown) => err);
    if (!isUnavailablePlanLockError(error)) throw new Error("expected an unavailable plan lock error");
    expect(error.probe).toMatchObject({ disposition: "prompt-file-missing", recoveryOwner: "operator" });
    expect(error.probe?.summary).toContain(promptPath);
  });

  it("locks the control spec and carries no verdict at all", async () => {
    const { task } = await cardWithSpec(LOCKABLE_SPEC);

    const lock = await store.lockCurrentPlan(task.id, "fingerprint", LOCKABLE_SPEC);
    expect(lock.currentPlanHash).toBeTruthy();
    expect(lock.plan.status).toBe("available");
    expect(lock.plan.contentHash).toBeTruthy();
  });
});
