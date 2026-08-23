/*
FNXC:ReviewConvergence 2026-08-22-05:35:
FN-149 compares review rounds by the binary patch the reviewer received. Both singular and workspace
reviews use this helper so an unchanged code loop has one durable, content-addressed definition.
*/
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Returns no signal for an absent/empty/unreadable diff; a failed probe must never invent progress. */
export async function computeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined): Promise<string | undefined> {
  if (!worktreePath || !baseRef) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--binary", `${baseRef}..HEAD`], { cwd: worktreePath, encoding: "utf8" });
    return stdout ? createHash("sha256").update(stdout).digest("hex") : undefined;
  } catch {
    return undefined;
  }
}
