/*
FNXC:LaneLegGate 2026-11-11-23:20 (RUFU-425, W4):
The checkout-emptiness prover answers "is there anything here to preserve?", and an affirmative is what
releases a file-scope lease and authorises removing a checkout. That makes it the seam where a
wrong-repository measurement is most expensive: a leg whose directory is EMPTY makes
`git status --porcelain` answer for the project that CONTAINS the leg, so a clean superproject around a
leg holding nothing produced a confident `empty`.

These fixtures are real git for the same reason the classifier's are: the empty-leg shape is produced by
`git worktree add` of a superproject that declares a submodule, and no fake reproduces it honestly.

Three promises, in priority order:
1. an unmeasurable leg never yields `empty` (it yields `unknown`, which every consumer already treats
   as a holder),
2. a leg that IS its own repository is proven exactly as before — the guard must not over-refuse, and
3. the ref-only proof mode for a directory that is genuinely gone still works, because that mode is the
   designed answer for a released worktree and predates this guard.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CheckoutEmptinessProver } from "../checkout-emptiness.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

async function scratch(tag: string): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `rufu-425-${tag}-`)));
  tempRoots.push(base);
  return base;
}

async function configure(dir: string): Promise<void> {
  await git(["-C", dir, "config", "user.email", "leg@example.com"], dir);
  await git(["-C", dir, "config", "user.name", "Leg Fixture"], dir);
}

async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir], path.dirname(dir));
  await configure(dir);
  await writeFile(path.join(dir, "note.txt"), "base\n", "utf-8");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "chore: base"], dir);
  return await git(["rev-parse", "HEAD"], dir);
}

/** A capture over the two board writes a refusal is allowed to make, so "exactly one" is assertable. */
function recordingStore() {
  const history: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const store = {
    logEntry: async (_id: string, action: string): Promise<unknown> => {
      history.push(action);
      return undefined;
    },
    recordRunAuditEvent: async (input: Record<string, unknown>): Promise<unknown> => {
      audit.push(input);
      return undefined;
    },
  };
  // Arity is carried by the production type; the capture only needs the two members the seam uses.
  return { store: store as never, history, audit };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("checkout-emptiness prover - a leg that is not its own repository", () => {
  it("an empty member leg never answers `empty`, and the refusal is recorded once", async () => {
    const base = await scratch("w4-empty");
    const upstream = path.join(base, "upstream");
    await initRepo(upstream);
    const root = path.join(base, "root");
    await initRepo(root);
    await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "member"], root);
    await git(["commit", "-q", "-m", "chore: declare member leg"], root);
    const wt = path.join(base, "wt");
    await git(["worktree", "add", "-q", wt, "HEAD"], root);
    const legPath = path.join(wt, "member");
    const baseSha = await git(["rev-parse", "HEAD"], root);

    // The affordance, asserted before the guard: the leg is empty and the superproject around it is clean.
    expect(await git(["status", "--porcelain"], wt)).toBe("");

    const capture = recordingStore();
    const prover = new CheckoutEmptinessProver({ rootDir: root, store: capture.store });
    const proofs = await prover.proveTask({
      id: "RUFU-425",
      workspaceWorktrees: { member: { worktreePath: legPath, branch: "fusion/rufu-425", baseCommitSha: baseSha } },
    });

    expect(proofs.get("member"), "a leg that reads the enclosing tree must never be proven empty").toBe("unknown");
    expect(capture.history).toHaveLength(1);
    expect(capture.history[0]).toContain("lane-leg-empty");
    await vi.waitFor(() => expect(capture.audit).toHaveLength(1));
    expect(capture.audit[0]).toMatchObject({
      mutationType: "worktree:lane-leg-refusal",
      target: "member",
      metadata: expect.objectContaining({ code: "lane-leg-empty", repository: "member", legCount: 1 }),
    });
    // A filesystem path belongs to the card, never to the audit row.
    expect(JSON.stringify(capture.audit[0])).not.toContain(legPath);
  }, 90_000);

  it("the announcement is bounded while the protection is not", async () => {
    const base = await scratch("w4-floor");
    const root = path.join(base, "root");
    await initRepo(root);
    const wt = path.join(base, "wt");
    await git(["worktree", "add", "-q", wt, "HEAD"], root);
    const legPath = path.join(wt, "not-a-repository");
    await mkdir(legPath, { recursive: true });
    const task = {
      id: "RUFU-425",
      workspaceWorktrees: { "not-a-repository": { worktreePath: legPath, branch: "fusion/rufu-425" } },
    } as never;

    const capture = recordingStore();
    const prover = new CheckoutEmptinessProver({ rootDir: root, store: capture.store });
    const first = await prover.proveTask(task);
    const second = await prover.proveTask(task, { force: true });

    expect(first.get("not-a-repository")).toBe("unknown");
    expect(second.get("not-a-repository"), "the verdict must be re-measured every pass even when the notice is bounded").toBe("unknown");
    expect(capture.history, "one refusal sentence per window, not one per scheduling pass").toHaveLength(1);
  }, 90_000);

  it("the refusal runs before any git subprocess is asked about the leg", async () => {
    const base = await scratch("w4-forkfree");
    const root = path.join(base, "root");
    await initRepo(root);
    const wt = path.join(base, "wt");
    await git(["worktree", "add", "-q", wt, "HEAD"], root);
    const legPath = path.join(wt, "empty-leg");
    await mkdir(legPath, { recursive: true });

    const commands: string[] = [];
    const prover = new CheckoutEmptinessProver({
      rootDir: root,
      execImpl: async (command) => {
        commands.push(command);
        throw new Error(`unexpected git call: ${command}`);
      },
    });
    const proofs = await prover.proveTask({
      id: "RUFU-425",
      workspaceWorktrees: { "empty-leg": { worktreePath: legPath, branch: "fusion/rufu-425" } },
    } as never);

    expect(proofs.get("empty-leg")).toBe("unknown");
    expect(commands, "the leg guard may not spend a subprocess - this prover's fork count is a measured ratchet").toEqual([]);
  }, 60_000);
});

describe("checkout-emptiness prover - the guards that must not over-refuse", () => {
  it("a clean checkout that IS its own repository is still proven empty", async () => {
    const base = await scratch("w4-clean");
    const root = path.join(base, "root");
    const wt = path.join(base, "wt");
    const baseSha = await initRepo(root);
    // The branch must not be checked out in the source worktree, or git refuses the second checkout.
    await git(["-C", root, "branch", "fusion/rufu-425", baseSha], base);
    await git(["worktree", "add", "-q", wt, "fusion/rufu-425"], root);

    const capture = recordingStore();
    const prover = new CheckoutEmptinessProver({ rootDir: root, store: capture.store });
    const proofs = await prover.proveTask({
      id: "RUFU-425",
      worktree: wt,
      branch: "fusion/rufu-425",
      baseCommitSha: baseSha,
    } as never);

    expect(proofs.get("")).toBe("empty");
    expect(capture.history).toEqual([]);
  }, 90_000);

  it("a directory that is genuinely gone still proves from its branch ref in the main checkout", async () => {
    const base = await scratch("w4-refonly");
    const root = path.join(base, "root");
    const baseSha = await initRepo(root);
    await git(["-C", root, "branch", "fusion/gone", baseSha], base);

    const prover = new CheckoutEmptinessProver({ rootDir: root });
    const proofs = await prover.proveTask({
      id: "RUFU-425",
      worktree: path.join(base, "released-and-removed"),
      branch: "fusion/gone",
      baseCommitSha: baseSha,
    } as never);

    expect(proofs.get(""), "the refs-only mode is the designed answer for a released worktree").toBe("empty");
  }, 60_000);
});
