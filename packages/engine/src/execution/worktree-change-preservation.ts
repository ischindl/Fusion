/*
FNXC:BranchBaseIdentity 2026-09-13-02:50:
RUFU-231: `preserveWorktreeChanges` was private to self-healing.ts (used before pausing on an
unrecoverable PR conflict). A zero-own-commit card whose branch tip landed only on the
remote-tracking identity now needs the same zero-loss guarantee at every checkout-release gate
(executor conflict handler, auto-recovery handler, reclaim sweep): before a checkout whose
landedness was proven remotely is released, its uncommitted tracked changes must be captured as
a recovery patch. Relocated unchanged; behavior is byte-identical to the private original.
*/
import { exec } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { formatRecoveryTimestamp } from "../healing/self-healing-path-utils.js";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);
const log = createLogger("worktree-preservation");

export async function preserveWorktreeChanges(repoDir: string, worktreePath: string, taskId: string): Promise<string | null> {
  try {
    const status = (await execAsync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
    if (!status) {
      return null;
    }

    const diff = (await execAsync("git diff HEAD --binary", { cwd: worktreePath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })).stdout;
    const recoveryDir = join(repoDir, ".fusion", "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const patchPath = join(recoveryDir, `${taskId.toLowerCase()}-${formatRecoveryTimestamp()}.patch`);
    writeFileSync(patchPath, diff, "utf-8");
    return patchPath;
  } catch (error) {
    log.warn(`Failed to preserve worktree changes for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/*
FNXC:BranchBaseIdentity 2026-09-13-03:20:
RUFU-231: a checkout RELEASE (worktree removal after a remotely-landed tip) destroys untracked
non-ignored files too, so the capture that makes the release provably zero-loss must include
them. `git add -A --intent-to-add` registers untracked paths with zero index content — the
subsequent `git diff HEAD --binary` then carries their bytes as new-file hunks. This variant is
for release flows only (the worktree is removed immediately after); flows that keep the checkout
must use `preserveWorktreeChanges` so the index is never touched.
*/
export async function preserveWorktreeChangesIncludingUntracked(
  repoDir: string,
  worktreePath: string,
  taskId: string,
): Promise<string | null> {
  try {
    const status = (await execAsync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
    if (!status) {
      return null;
    }
    await execAsync("git add -A --intent-to-add", { cwd: worktreePath, encoding: "utf-8", timeout: 30_000 }).catch(() => undefined);
    const diff = (await execAsync("git diff HEAD --binary", { cwd: worktreePath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })).stdout;
    const recoveryDir = join(repoDir, ".fusion", "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const patchPath = join(recoveryDir, `${taskId.toLowerCase()}-${formatRecoveryTimestamp()}.patch`);
    writeFileSync(patchPath, diff, "utf-8");
    return patchPath;
  } catch (error) {
    // Capture failed: undo the intent-to-add registration so a checkout that stays held (the
    // caller must not release without a patch) keeps its original `?? untracked` status view.
    await execAsync("git reset", { cwd: worktreePath, encoding: "utf-8", timeout: 30_000 }).catch(() => undefined);
    log.warn(`Failed to preserve worktree changes (incl. untracked) for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
