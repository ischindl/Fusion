import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { auditBranchCrossContamination } from "../audit-branch-cross-contamination.mjs";

function run(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("flags branch as tainted when foreign task commits are present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-4409-audit-"));
  try {
    run(dir, "git", ["init", "-b", "main"]);
    run(dir, "git", ["config", "user.name", "Fusion"]);
    run(dir, "git", ["config", "user.email", "noreply@runfusion.ai"]);

    fs.writeFileSync(path.join(dir, "README.md"), "base\n");
    run(dir, "git", ["add", "README.md"]);
    run(dir, "git", ["commit", "-m", "chore: base"]);
    run(dir, "git", ["checkout", "-b", "fusion/fn-0001"]);
    fs.writeFileSync(path.join(dir, "feature.txt"), "foreign\n");
    run(dir, "git", ["add", "feature.txt"]);
    run(dir, "git", ["commit", "-m", "feat(FN-0002): foreign work", "-m", "Fusion-Task-Id: FN-0002"]);

    const fusionDir = path.join(dir, ".fusion");
    fs.mkdirSync(fusionDir, { recursive: true });
    const dbPath = path.join(fusionDir, "fusion.db");
    run(dir, "sqlite3", [dbPath, `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, branch TEXT, baseCommitSha TEXT, "column" TEXT);`]);
    run(dir, "sqlite3", [dbPath, `INSERT INTO tasks (id, title, branch, baseCommitSha, "column") VALUES ('FN-0001', 'Task 1', 'fusion/fn-0001', NULL, 'in-progress');`]);

    const report = auditBranchCrossContamination({ projectRoot: dir });
    assert.equal(report.taintedTaskCount, 1);
    const task = report.tasks.find((entry) => entry.taskId === "FN-0001");
    assert.ok(task);
    assert.equal(task.tainted, true);
    assert.equal(task.recommendation, "force-reset");
    assert.equal(task.baseResolutionSource.startsWith("merge-base("), true);
    assert.equal(task.taintedCommits[0].foreignTaskId, "FN-0002");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
