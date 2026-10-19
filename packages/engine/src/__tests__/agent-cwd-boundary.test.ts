/**
 * RUFU-334 — the session-boundary resolver is the single enforcement seam for the working-directory policy.
 *
 * The incident this file guards: nine agent lanes each carried their own `?? process.cwd()` default and
 * only the one that leaked (the dashboard Usage probe) was ever read. Closing lanes one file at a time is
 * the shape that fails again, so `resolveSessionBoundaryRoot` — which every `createFnAgent` lane already
 * crosses to decide its boundary root — evaluates the operator's protected-checkout declaration once.
 * These cases prove the choke point really covers differently-shaped lanes without a per-file edit, and
 * that the refusal happens before any lane-specific work.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:05 (RUFU-334):
 * A declared protected root is refused for an undeclared session (chat/heartbeat shape, no descriptor),
 * a `read-only-root` session (planning/research shape), and a `task-worktree` session (executor shape).
 * The refusal must precede the lane's own validation: the `task-worktree` cases below pass a cwd that is
 * not a Git worktree at all, so a refusal naming the protected checkout — instead of the unregistered
 * worktree error — is the evidence that policy runs first.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtectedCheckoutError } from "@fusion/core";

const ENV_VAR = "FUSION_PROTECTED_CHECKOUTS";

const tempDirs: string[] = [];
function tempDir(prefix = "fusion-boundary-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadResolver() {
  const { resolveSessionBoundaryRoot } = await import("../pi.js");
  return resolveSessionBoundaryRoot;
}

describe("resolveSessionBoundaryRoot — protected checkout refusal across lanes", () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prior;
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A protected deployment checkout with a nested lane directory inside it. */
  function protectedLane(nested = ".fusion/scratch") {
    const root = tempDir("fusion-protected-deploy-");
    const lane = join(root, nested);
    mkdirSync(lane, { recursive: true });
    process.env[ENV_VAR] = root;
    return { root, lane };
  }

  it("refuses an undeclared session (chat / durable-agent heartbeat shape)", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    const { root, lane } = protectedLane();

    const err = await resolveSessionBoundaryRoot(lane).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProtectedCheckoutError);
    expect((err as ProtectedCheckoutError).protectedRoot).toBeTruthy();
    expect((err as Error).message).toContain(root);
    expect((err as Error).message).toContain(ENV_VAR);
  });

  it("refuses a read-only-root session (planning / research shape), naming the lane", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    const { root } = protectedLane("planning");

    const err = await resolveSessionBoundaryRoot(root, {
      kind: "read-only-root",
      writableRoot: null,
      projectRoot: root,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProtectedCheckoutError);
    expect((err as ProtectedCheckoutError).lane).toBe("read-only-root");
  });

  it("refuses a task-worktree session (executor shape) before validating the worktree", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    const { lane } = protectedLane("task-worktree");

    const err = await resolveSessionBoundaryRoot(lane, {
      kind: "task-worktree",
      writableRoot: lane,
      projectRoot: lane,
    }).catch((e: unknown) => e);

    // The lane's own error would name the unregistered worktree; this one names the policy.
    expect(err).toBeInstanceOf(ProtectedCheckoutError);
    expect((err as Error).message).not.toContain("unregistered git worktree");
  });

  it("refuses a declared writable root that is protected even when the cwd is not", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    const { root, lane } = protectedLane("writable-root");
    const outside = tempDir("fusion-outside-");

    const err = await resolveSessionBoundaryRoot(outside, {
      kind: "read-only-root",
      writableRoot: lane,
      projectRoot: root,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProtectedCheckoutError);
    expect((err as ProtectedCheckoutError).lane).toBe("read-only-root writable root");
    expect((err as ProtectedCheckoutError).candidate).toBe(lane);
  });

  it("changes nothing for an unprotected root while the variable is unset", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    delete process.env[ENV_VAR];
    const project = tempDir("fusion-plain-project-");

    await expect(resolveSessionBoundaryRoot(project)).resolves.toEqual({
      worktreePath: project,
      worktreeProjectRoot: null,
    });
  });

  it("returns the caller's own path, not the policy realpath, for a legitimate symlinked lane", async () => {
    const resolveSessionBoundaryRoot = await loadResolver();
    delete process.env[ENV_VAR];
    const real = tempDir("fusion-real-root-");
    const linkParent = tempDir("fusion-link-parent-");
    const link = join(linkParent, "project");
    // A symlinked project root stays the caller's handle; only the policy comparison uses realpath.
    symlinkSync(real, link, "dir");

    const resolved = await resolveSessionBoundaryRoot(link);
    expect(resolved.worktreePath).toBe(link);
    expect(resolved.worktreePath).not.toBe(realpathSync(link));
  });
});
