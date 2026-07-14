/*
FNXC:PostgresCutover 2026-07-05-13:00:
The script now targets the PostgreSQL backend; the FN-3899 recovery logic is
pure (planRecoverBlockedBy over plain rows), so this test injects rows instead
of seeding a SQLite fixture. Soft-deleted rows never reach the planner — the
backend query filters `deleted_at IS NULL` — so the FN-5528 case is modeled by
omitting deleted rows from the injected set.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planRecoverBlockedBy } from "../recover-stale-blocked-by.mjs";

function setupTasksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-3899-"));
  const tasksDir = path.join(dir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  return { dir, tasksDir };
}

function writePrompt(tasksDir, taskId, scopeLines) {
  const taskDir = path.join(tasksDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const bullets = scopeLines.map((line) => `- \`${line}\``).join("\n");
  fs.writeFileSync(path.join(taskDir, "PROMPT.md"), `# Task\n\n## File Scope\n${bullets}\n`);
}

test("clears stale blocker when blocker is terminal", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-DONE", ["packages/dashboard/app/App.tsx"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-DONE", column: "done", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-DONE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    const finding = findings.find((f) => f.taskId === "FN-BLOCKED");
    assert.equal(finding?.reason, "blocker-terminal:done");
    assert.equal(finding?.newBlocker, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves valid blocker when overlap remains active", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-ACTIVE", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-ACTIVE", column: "in-progress", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-ACTIVE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    const finding = findings.find((f) => f.taskId === "FN-BLOCKED");
    assert.equal(finding?.reason, "unchanged");
    assert.equal(finding?.newBlocker, "FN-ACTIVE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flags in-review blocker without worktree", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-MISSING-SCOPE", ["packages/engine/src/scheduler.ts"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-MISSING-SCOPE", column: "in-review", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-MISSING-SCOPE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    assert.equal(findings.find((f) => f.taskId === "FN-BLOCKED")?.reason, "blocker-in-review-without-worktree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("treats soft-deleted blockers as missing and never plans for deleted dependents (FN-5528)", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-LIVE-DEPENDENT", ["packages/core/src/store.ts"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL", ["packages/engine/src/self-healing.ts"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL-DEP", ["packages/engine/src/self-healing.ts"]);

    // FN-DELETED-BLOCKER and FN-DELETED-TODO are soft-deleted: the backend
    // query filters them out with `deleted_at IS NULL`, so they are absent.
    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-LIVE-DEPENDENT", column: "todo", blockedBy: "FN-DELETED-BLOCKER", worktree: null, paused: 0 },
        { id: "FN-LIVE-TERMINAL", column: "done", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-LIVE-TERMINAL-DEP", column: "todo", blockedBy: "FN-LIVE-TERMINAL", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-DEPENDENT")?.reason, "blocker-missing");
    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-TERMINAL-DEP")?.reason, "blocker-terminal:done");
    assert.equal(findings.some((f) => f.taskId === "FN-DELETED-TODO"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
