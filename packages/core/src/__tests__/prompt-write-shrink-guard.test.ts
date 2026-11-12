/*
FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
Store-seam (PG harness, real filesystem) proof that the material-shrink guard binds the AUTHORITATIVE
prompt write and that its authorization threads all the way through the public `updateTask` seam.
Symptom reproduction (RUFU-519): accept a ~20 KB spec, then send back only its first ~1.6 KB — the shape a
model-side truncation produces, where received payload equals landed file so the existing read-back sees a
zero diff. The call must reject with PROMPT_SHRINK_REJECTED while the on-disk byte length is unchanged.
These assertions run on the PostgreSQL harness because the guard is a filesystem comparison against the
bytes already on disk; the pure-helper and fs-mocked branch cases live in prompt-write-integrity.test.ts.
*/
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writePromptFileAtomic, promptByteLength, PROMPT_SHRINK_MIN_PRIOR_BYTES } from "../task-store/prompt-file.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../__test-utils__/pg-test-harness.js";

function makeSpec(targetBytes: number, marker: string): string {
  // One `## Mission` section (never duplicated) padded to at least `targetBytes` UTF-8 bytes.
  const head = `# Task spec\n\n## Mission\n\n${marker}\n`;
  const filler = "detail ".repeat(Math.max(1, Math.ceil((targetBytes - head.length) / 7)));
  return head + filler;
}

async function promptBytes(harness: PgTestHarness, taskId: string): Promise<number> {
  const raw = await readFile(join(harness.store.taskDir(taskId), "PROMPT.md"), "utf-8");
  return promptByteLength(raw);
}

pgDescribe("PROMPT.md material-shrink guard at the authoritative store seam", () => {
  let harness: PgTestHarness | null = null;

  async function fresh(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_prompt_shrink" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("refuses a material shrink of an accepted spec and leaves the on-disk bytes unchanged", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "card whose spec is truncated by a model-side send" });
      const big = makeSpec(20000, "the accepted specification");
      await h.store.updateTask(task.id, { prompt: big });
      const afterAccept = await promptBytes(h, task.id);
      expect(afterAccept).toBeGreaterThanOrEqual(20000);

      // The exact RUFU-519 shape: send back only the first ~1.6 KB of the very same spec.
      const truncated = big.slice(0, 1600);
      let thrown: unknown;
      try {
        await h.store.updateTask(task.id, { prompt: truncated });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message.startsWith("PROMPT_SHRINK_REJECTED:")).toBe(true);
      // The refusal is a total no-op: the previously accepted bytes are still exactly what is on disk.
      expect(await promptBytes(h, task.id)).toBe(afterAccept);
    } finally {
      await teardown();
    }
  });

  it("authorizes a deliberate slim replacement through the public seam (proves the flag reaches the guard)", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "operator deliberately shortens an accepted spec" });
      const big = makeSpec(20000, "the accepted specification");
      await h.store.updateTask(task.id, { prompt: big });
      const truncated = big.slice(0, 1600);

      // Without the flag this is the refusal above; with it, the operator's intent lands.
      await h.store.updateTask(task.id, { prompt: truncated, promptShrinkAuthorized: true });
      expect(await promptBytes(h, task.id)).toBe(promptByteLength(truncated));
    } finally {
      await teardown();
    }
  });

  it("permits a legitimate slim edit that stays above half the prior bytes", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "author edits a long spec down, but not by half" });
      const big = makeSpec(20000, "the accepted specification");
      await h.store.updateTask(task.id, { prompt: big });
      // 12 KB is above half of a 20 KB spec, so it is a legitimate edit, not a material shrink.
      const slimmer = makeSpec(12000, "trimmed but not halved");
      await h.store.updateTask(task.id, { prompt: slimmer });
      expect(await promptBytes(h, task.id)).toBe(promptByteLength(slimmer));
    } finally {
      await teardown();
    }
  });

  it("leaves a title-only heading sync untouched by the guard on a 5 KB spec", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "card whose title changes after its spec is accepted" });
      await h.store.updateTask(task.id, { prompt: makeSpec(5200, "a real spec body") });
      // A rename rewrites the heading line in place; the guard never fires and the body survives intact.
      await h.store.updateTask(task.id, { title: "Renamed card" });
      const raw = await readFile(join(h.store.taskDir(task.id), "PROMPT.md"), "utf-8");
      expect(raw).not.toContain("PROMPT_SHRINK_REJECTED");
      expect(raw).toContain("a real spec body");
      expect(promptByteLength(raw)).toBeGreaterThanOrEqual(PROMPT_SHRINK_MIN_PRIOR_BYTES);
    } finally {
      await teardown();
    }
  });

  /*
  FNXC:PromptWriteIntegrity 2026-11-11-23:58 (RUFU-534):
  Reopening a card to `todo` resets its `### Step N:` checkboxes through a size-neutral rewrite derived
  from the file already on disk. It is a lifecycle writer, not an intent to replace the spec, so it must
  keep working on a spec past the floor: neither the shrink guard nor landed-byte compensation may refuse
  it. Asserted on a real `todo -> in-progress -> todo` move so the guard is exercised on the shipped path.
  */
  it("never blocks the reopen checkbox reset on a spec past the shrink floor", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "card that will be reopened after its spec is accepted" });
      const spec = makeSpec(20000, "the accepted specification") + "\n### Step 0: Preflight\n\n- [x] done step\n";
      await h.store.updateTask(task.id, { prompt: spec });

      await h.store.moveTask(task.id, "todo");
      await h.store.moveTask(task.id, "in-progress");
      await h.store.moveTask(task.id, "todo");

      const raw = await readFile(join(h.store.taskDir(task.id), "PROMPT.md"), "utf-8");
      // The reset landed and the bulk of the accepted spec survived it.
      expect(raw).toContain("- [ ] done step");
      expect(raw).toContain("the accepted specification");
      expect(promptByteLength(raw)).toBeGreaterThanOrEqual(20000 - 200);
    } finally {
      await teardown();
    }
  });

  it("can always restore previous prompt bytes through the primitive (the guard lives in updateTask, not the writer)", async () => {
    const h = await fresh();
    try {
      const task = await h.store.createTask({ description: "proves the compensating restore is never shrink-blocked" });
      const big = makeSpec(20000, "the accepted specification");
      await h.store.updateTask(task.id, { prompt: big });
      // The compensating restore re-publishes what the same call just read via the primitive directly.
      // It must land byte-for-byte regardless of shrink: the guard is not in the primitive.
      const restore = makeSpec(1000, "prior bytes restored");
      await writePromptFileAtomic(join(h.store.taskDir(task.id), "PROMPT.md"), restore);
      expect(await promptBytes(h, task.id)).toBe(promptByteLength(restore));
    } finally {
      await teardown();
    }
  });
});
