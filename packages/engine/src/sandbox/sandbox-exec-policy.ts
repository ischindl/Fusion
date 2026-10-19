import { dirname, resolve } from "node:path";

import {
  SBPL_BASE_ALLOW,
  SBPL_FILE_READ_BASE,
  SBPL_HEADER,
  SBPL_NETWORK_ALLOW_OUTBOUND,
  SBPL_NETWORK_DENY_ALL,
  SBPL_TMP_WRITE,
} from "./sandbox-exec-profile-templates.js";
import type { SandboxPolicy } from "./types.js";
import { getProjectRootFromWorktree } from "@fusion/core";

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface SandboxExecPolicy extends SandboxPolicy {
  failureMode?: "fail-hard" | "fallback-native";
  allowedPorts?: number[];
  allowPort4040Override?: boolean;
}

/*
FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:29 (RUFU-334):
A Seatbelt profile grants writes by absolute path, so the root it names IS the sandbox's write boundary.
This module used to receive roots that `SandboxExecBackend` derived from `process.cwd()`, which on a unit
with no `WorkingDirectory` (or any serve started from inside another checkout) granted writes to — and
reported as the readable repo root of — the server's own tree. A root therefore has to arrive from a
caller that owns a real directory (the run cwd, or a policy that declares its writable paths), and the
absence of one is a named refusal rather than an inherited default.
*/
export class SandboxWritableRootMissingError extends Error {
  readonly code = "SANDBOX_WRITABLE_ROOT_MISSING";
  constructor(lane: string) {
    super(
      `Refusing to build a sandbox-exec profile for the ${lane} leg without an explicit working directory: pass the run cwd or declare policy.allowedWritePaths rather than inheriting the server's launch directory.`,
    );
    this.name = "SandboxWritableRootMissingError";
  }
}

/**
 * The one root resolver behind every sandbox-exec profile leg. The run cwd wins over a policy-declared
 * root because the profile has to match the directory the child is actually about to run in.
 */
export function resolveSandboxWritableRoot(opts: {
  policyWriteRoot?: string | null;
  runCwd?: string | null;
  lane: string;
}): string {
  for (const candidate of [opts.runCwd, opts.policyWriteRoot]) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed) return trimmed;
  }
  throw new SandboxWritableRootMissingError(opts.lane);
}

/**
 * The repository root the `.fusion` write guard is measured against, derived from the resolved worktree:
 * a task worktree below `.fusion/worktrees/<id>` still belongs to the project root above it, so collapsing
 * the two would let a session write the Fusion database. Never derived from the process working directory.
 */
export function deriveSandboxRepoRoot(worktreePath: string): string {
  return getProjectRootFromWorktree(worktreePath) ?? worktreePath;
}

export interface SandboxExecContext {
  worktreePath: string;
  repoRootPath: string;
  pnpmStorePath: string;
  nodeBinPath: string;
  homeDir: string;
  tmpDirOverride?: string;
}

function uniq(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolve(p)))];
}

export function sbplEscape(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function asSubpath(path: string): string {
  return `(subpath "${sbplEscape(path)}")`;
}

function ensureNoFusionWrites(paths: string[], repoRootPath: string, worktreePath: string): void {
  const fusionRoot = resolve(repoRootPath, ".fusion");
  const fusionDb = resolve(fusionRoot, "fusion.db");
  const declaredWorktree = resolve(worktreePath);
  for (const candidate of paths) {
    const resolved = resolve(candidate);
    // FNXC:WorkspaceSandbox 2026-08-22-23:58: workspace task worktrees live
    // below .fusion/worktrees, but only the exact declared task root may be
    // writable. The task DB and every other .fusion path remain forbidden.
    const isDeclaredTaskWorktree = resolved === declaredWorktree
      && (declaredWorktree === fusionRoot || declaredWorktree.startsWith(`${fusionRoot}/`));
    if (!isDeclaredTaskWorktree && (resolved === fusionRoot || resolved === fusionDb || resolved.startsWith(`${fusionRoot}/`))) {
      throw new SandboxPolicyError("Sandbox policy cannot include writable paths under .fusion/.");
    }
  }
}

export function fusionWorktreePreset(ctx: SandboxExecContext): SandboxExecPolicy {
  return {
    allowNetwork: true,
    allowedReadPaths: [ctx.repoRootPath],
    allowedWritePaths: [ctx.worktreePath, ctx.pnpmStorePath],
  };
}

export function policyToSbplProfile(policy: SandboxExecPolicy, ctx: SandboxExecContext): string {
  if (policy.allowedPorts?.includes(4040) && policy.allowPort4040Override !== true) {
    throw new SandboxPolicyError("Port 4040 is reserved and cannot be allowed in sandbox policy.");
  }

  const tmpDir = resolve(ctx.tmpDirOverride ?? "/private/tmp");
  const nodeDir = dirname(ctx.nodeBinPath);

  // FNXC:WorkspaceSandbox 2026-08-22-23:45: An explicit empty list is a
  // read-only session policy; only unspecified write paths retain the legacy preset.
  const writePaths = uniq(policy.allowedWritePaths === undefined
    ? [ctx.worktreePath, ctx.pnpmStorePath]
    : policy.allowedWritePaths);
  ensureNoFusionWrites(writePaths, ctx.repoRootPath, ctx.worktreePath);

  const readPaths = uniq([
    ...((policy.allowedReadPaths ?? []).length ? (policy.allowedReadPaths ?? []) : [ctx.repoRootPath]),
    ...(ctx.repoRootPath !== ctx.worktreePath ? [ctx.repoRootPath] : []),
    nodeDir,
  ]).filter((path) => !writePaths.includes(path));

  const lines = [SBPL_HEADER, SBPL_BASE_ALLOW, SBPL_FILE_READ_BASE, SBPL_TMP_WRITE, `(allow file-read* ${asSubpath(tmpDir)})`, `(allow file-write* ${asSubpath(tmpDir)})`];

  for (const readPath of readPaths) {
    lines.push(`(allow file-read* ${asSubpath(readPath)})`);
  }

  for (const writePath of writePaths) {
    lines.push(`(allow file-write* ${asSubpath(writePath)})`);
  }

  lines.push(policy.allowNetwork ? SBPL_NETWORK_ALLOW_OUTBOUND : SBPL_NETWORK_DENY_ALL);
  return `${lines.join("\n")}\n`;
}
