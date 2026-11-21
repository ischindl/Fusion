/*
FNXC:TaskDetailPromptResilience 2026-07-10-15:00:
Symptom verification for the "task write API returns 500 for nearly everything" report:
GET/DELETE/PATCH/retry/reset/archive on a task all 500'd for every task (healthy ones
too) while the board list and create worked. Root cause: getTask — the shared load for
the entire per-task API — reads PROMPT.md directly and unguarded, so any read failure
(a root-owned PROMPT.md from a prior `sudo` run → EACCES, PROMPT.md being a directory →
EISDIR, etc.) threw and bricked every per-task operation, whereas the slim board list
never touches PROMPT.md.

Original symptom: getTask throws on an unreadable PROMPT.md, 500ing all per-task ops.
Exact reproduction: replace a task's PROMPT.md with a directory so readFile raises EISDIR.
Assertion it is gone: getTask resolves with the row (prompt degraded to ""), and a
representative mutation still succeeds — the per-task API is no longer bricked.

Migrated from the removed SQLite `new TaskStore(root)` path (VAL-REMOVAL-005) to the
PostgreSQL test harness via `createTaskStoreForTest`. The harness provides a
backend-mode TaskStore (`asyncLayer` injected) backed by an isolated PG database plus a
real temp `rootDir` where `.fusion/tasks/{id}/PROMPT.md` lives, so the filesystem
resilience assertions are unchanged.
*/
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDuplicateRedirectOnlyPrompt, parseExplicitDuplicateMarker } from "../duplicates/explicit-duplicate-marker.js";
import { buildBootstrapPrompt } from "../mesh/mesh-task-replication.js";
import { buildOriginalDescriptionSection, extractOriginalDescriptionBody } from "../tasks/original-description-policy.js";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";

pgDescribe("getTask PROMPT.md read resilience (task-write-API 500 regression)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_prompt_resilience" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("returns the task detail (and mutations still work) when PROMPT.md cannot be read", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const task = await store.createTask({ description: "task whose PROMPT.md becomes unreadable" });

      // Baseline: a healthy task detail loads and carries the prompt text.
      const baseline = await store.getTask(task.id);
      expect(baseline.id).toBe(task.id);
      expect(typeof baseline.prompt).toBe("string");

      // Make PROMPT.md unreadable deterministically: replace the file with a
      // directory so `readFile` raises EISDIR (mirrors the EACCES a root-owned
      // PROMPT.md produces, without depending on chmod/uid semantics).
      const promptPath = join(h.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      rmSync(promptPath, { force: true });
      mkdirSync(promptPath, { recursive: true });
      expect(existsSync(promptPath)).toBe(true);

      // The read path (GET /api/tasks/:id) must NOT throw — it degrades to an
      // empty prompt instead of 500ing.
      const detail = await store.getTask(task.id);
      expect(detail.id).toBe(task.id);
      expect(detail.prompt).toBe("");

      // The board read paths must survive too — listTasks/searchTasks slim-sync
      // steps from PROMPT.md for stepless tasks and would otherwise reject their
      // Promise.all and 500 the whole board/search on one unreadable file.
      const listed = await store.listTasks({ slim: true });
      expect(listed.some((t) => t.id === task.id)).toBe(true);
      const found = await store.searchTasks("unreadable", { slim: true });
      expect(Array.isArray(found)).toBe(true);

      // The mutation path must stay usable too. These store methods back the
      // reported failing endpoints and each independently touches PROMPT.md:
      //   PATCH   -> updateTask (title/description PROMPT.md heading sync)
      //   reset   -> moveTask reopen-to-todo (resetPromptCheckboxes) + updateStep
      //   delete  -> deleteTask
      // A read failure in that PROMPT.md work must not brick the DB mutation.
      await expect(store.updateTask(task.id, { title: "renamed with broken PROMPT.md" })).resolves.toBeTruthy();
      const afterMutation = await store.getTask(task.id);
      expect(afterMutation.title).toBe("renamed with broken PROMPT.md");

      // Atomicity: an *explicit* prompt write that can't hit disk (PROMPT.md is a
      // directory → EISDIR) must reject AND leave the accompanying field change
      // uncommitted — no partial commit of the row with a stale prompt.
      await expect(
        store.updateTask(task.id, { prompt: "new spec body", title: "atomic-should-not-apply" }),
      ).rejects.toThrow();
      const afterFailedPromptWrite = await store.getTask(task.id);
      expect(afterFailedPromptWrite.title).toBe("renamed with broken PROMPT.md");

      // reset path: advance the task then reopen to todo, which triggers
      // resetPromptCheckboxes against the unreadable PROMPT.md. (New tasks start
      // in `triage`, so step through todo → in-progress → todo.)
      await expect(store.moveTask(task.id, "todo")).resolves.toBeTruthy();
      await expect(store.moveTask(task.id, "in-progress")).resolves.toBeTruthy();
      await expect(store.moveTask(task.id, "todo")).resolves.toBeTruthy();

      // Directly updating a step whose definition lives only in the unreadable
      // PROMPT.md genuinely cannot succeed, but the error must name the real
      // cause (PROMPT.md) rather than a misleading "task has 0 steps".
      await expect(store.updateStep(task.id, 0, "in-progress")).rejects.toThrow(/PROMPT\.md/);

      await expect(store.deleteTask(task.id)).resolves.toBeTruthy();
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;

/*
FNXC:OriginalDescriptionInPrompt 2026-11-20-23:55 (RUFU-775):
Symptom verification, run through the real TaskStore so the production write path is what gets proven:
the reported sequence was a planner's `fn_task_prompt_write` of a one-line duplicate verdict followed by
`fn_task_update(description=...)`, and the store's cosmetic title/description sync then spliced an
`## Original Description` block built from the NEW description onto the 20 B file. The consequence is a
behaviour claim, not a formatting one: `parseExplicitDuplicateMarker` requires exactly one non-blank
line, so the smeared file stopped reading as a parked duplicate and the engine saw a plan.

Original symptom: after a description write, PROMPT.md became marker + multi-line block and the parser
returned null; on a real spec the same write replaced the operator's recorded intake text.
Exact reproduction: below, writing the file, calling `store.updateTask`, and re-reading from disk.
Assertion it is gone: the bytes are unchanged, the parser still answers with the same canonicalId, and
`isDuplicateRedirectOnlyPrompt` stays true. A helper-level test would not prove this seam.
*/
pgDescribe("PROMPT.md integrity across description writes (RUFU-775)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_prompt_integrity" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  function promptPathFor(h: PgTestHarness, taskId: string): string {
    return join(h.rootDir, ".fusion", "tasks", taskId, "PROMPT.md");
  }

  it("a description write cannot smear a duplicate redirect or un-park the card", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const task = await store.createTask({
        title: "Redirected intake",
        description: "Operator intake text that the planner later re-summarized.",
      });
      const promptPath = promptPathFor(h, task.id);
      const marker = "DUPLICATE: RUFU-665\n";
      await writeFile(promptPath, marker, "utf-8");

      // Pre-state: the verdict is on disk and the parser recognises it.
      const before = await readFile(promptPath, "utf-8");
      expect(before).toBe(marker);
      expect(parseExplicitDuplicateMarker(before)).toEqual({ canonicalId: "RUFU-665" });

      // Step 3 of the reported reproduction: the description write, on its own.
      await store.updateTask(task.id, { description: "Planner-authored replacement prose." });

      const after = await readFile(promptPath, "utf-8");
      expect(after).toBe(marker);
      expect(after).not.toContain("Original Description");
      expect(parseExplicitDuplicateMarker(after)).toEqual({ canonicalId: "RUFU-665" });
      const row = await store.getTask(task.id);
      expect(isDuplicateRedirectOnlyPrompt(after, row.title)).toBe(true);
      // The row still records the edit — only the file is protected.
      expect(row.description).toBe("Planner-authored replacement prose.");

      // A combined title+description write goes through the same branch, including the heading
      // splice, and still leaves the verdict byte-for-byte intact.
      await store.updateTask(task.id, { title: "Redirected intake, retitled", description: "Third text." });
      const afterCombined = await readFile(promptPath, "utf-8");
      expect(afterCombined).toBe(marker);
      expect(parseExplicitDuplicateMarker(afterCombined)).toEqual({ canonicalId: "RUFU-665" });
      expect((await store.getTask(task.id)).title).toBe("Redirected intake, retitled");
    } finally {
      await teardown();
    }
  });

  it("a description edit preserves the recorded Original Description while still retitling the spec", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const OPERATOR_TEXT = "Operator's verbatim request, with a `## Mission` line quoted inline.";
      const task = await store.createTask({ title: "Real spec", description: OPERATOR_TEXT });
      const promptPath = promptPathFor(h, task.id);
      await writeFile(
        promptPath,
        `# Task: ${task.id} - Real spec\n\n**Created:** 2026-11-20\n\n` +
          buildOriginalDescriptionSection(OPERATOR_TEXT) +
          `\n## Mission\n\nPlanned work.\n`,
        "utf-8",
      );

      await store.updateTask(task.id, { title: "Real spec, retitled", description: "Planner paraphrase." });

      const after = await readFile(promptPath, "utf-8");
      // The record survives: no paraphrase in the file, exactly one heading, body unchanged.
      expect(after).not.toContain("Planner paraphrase.");
      expect(after.match(/## Original Description/g)).toHaveLength(1);
      expect(extractOriginalDescriptionBody(after)).toBe(OPERATOR_TEXT);
      // The cosmetic title splice still runs, in the same call, on the same file.
      expect(after.split("\n")[0]).toBe(`# Task: ${task.id} - Real spec, retitled`);
      expect((await store.getTask(task.id)).description).toBe("Planner paraphrase.");
    } finally {
      await teardown();
    }
  });

  it("a bootstrap-stub card still rebuilds its seed prompt on a description edit", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const task = await store.createTask({ title: "Fresh idea", description: "First intake text." });
      const promptPath = promptPathFor(h, task.id);
      expect(await readFile(promptPath, "utf-8")).toBe(buildBootstrapPrompt(task.id, "Fresh idea", "First intake text."));

      await store.updateTask(task.id, { description: "Corrected intake text." });

      // The rebuild branch is untouched by the write-mode split, so the seed stays in sync and
      // keeps its exact equality used by isUnplannedSeedPrompt (which is what Reset relies on too).
      expect(await readFile(promptPath, "utf-8")).toBe(buildBootstrapPrompt(task.id, "Fresh idea", "Corrected intake text."));
    } finally {
      await teardown();
    }
  });
});
