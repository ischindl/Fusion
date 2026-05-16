import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { inspectBranchConflict } from "./branch-conflicts.js";
import { formatError } from "./logger.js";

const execAsync = promisify(exec);
const NATIVE_TIMEOUT_MS = 120_000;
const WORKTRUNK_TIMEOUT_MS = 120_000;
const REMOVE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export type WorktreeBackendKind = "native" | "worktrunk";
export type WorktreeOperation = "create" | "remove" | "sync" | "prune";

export interface WorktreeCreateInput {
  rootDir: string;
  branch: string;
  worktreePath: string;
  startPoint?: string;
  taskId: string;
  allowSiblingBranchRename?: boolean;
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
}

export interface WorktreeRemoveInput {
  rootDir: string;
  worktreePath: string;
  branch?: string;
  taskId?: string;
}

export interface WorktreeSyncInput {
  rootDir: string;
  worktreePath: string;
  branch: string;
  taskId?: string;
}

export interface WorktreePruneInput {
  rootDir: string;
}

export interface WorktreeBackend {
  readonly kind: WorktreeBackendKind;
  create(input: WorktreeCreateInput): Promise<WorktreeCreateResult>;
  remove(input: WorktreeRemoveInput): Promise<void>;
  sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }>;
  prune(input: WorktreePruneInput): Promise<void>;
}

export type WorktrunkOperationCode =
  | "worktrunk_operation_failed"
  | "worktrunk_binary_missing"
  | "worktrunk_unsupported_operation";

export class WorktrunkOperationError extends Error {
  readonly code: WorktrunkOperationCode;
  readonly operation: WorktreeOperation;
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(input: {
    operation: WorktreeOperation;
    code: WorktrunkOperationCode;
    stderr?: string;
    exitCode?: number | null;
  }) {
    super(`worktrunk ${input.operation} failed`);
    this.name = "WorktrunkOperationError";
    this.operation = input.operation;
    this.code = input.code;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
  }
}

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function getErrorStderr(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("stderr" in error)) return undefined;
  const stderr = (error as { stderr?: unknown }).stderr;
  return stderr == null ? undefined : String(stderr);
}

function getErrorExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  if (typeof value.status === "number") return value.status;
  if (typeof value.code === "number") return value.code;
  return null;
}

export class NativeWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "native";

  constructor(private readonly deps: { logger?: { log: (m: string) => void; warn: (m: string) => void } } = {}) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    const startArg = input.startPoint ? ` ${quoteShellArg(input.startPoint)}` : "";
    const createWithBranch = async (branchName: string): Promise<WorktreeCreateResult> => {
      await execAsync(
        `git worktree add -b ${quoteShellArg(branchName)} ${quoteShellArg(input.worktreePath)}${startArg}`,
        {
          cwd: input.rootDir,
          encoding: "utf-8",
          timeout: NATIVE_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        },
      );
      return { path: input.worktreePath, branch: branchName };
    };

    try {
      return await createWithBranch(input.branch);
    } catch (error) {
      if (!input.allowSiblingBranchRename) {
        throw error;
      }

      for (let suffix = 2; suffix <= 50; suffix += 1) {
        const candidateBranch = `${input.branch}-${suffix}`;
        try {
          return await createWithBranch(candidateBranch);
        } catch {
          // continue probing suffixes
        }
      }

      let inspection: Awaited<ReturnType<typeof inspectBranchConflict>> | null = null;
      try {
        inspection = await inspectBranchConflict({
          repoDir: input.rootDir,
          branchName: input.branch,
          conflictingWorktreePath: input.worktreePath,
          requestingTaskId: input.taskId,
          startPoint: input.startPoint,
        });
      } catch (inspectError) {
        this.deps.logger?.warn?.(
          `[worktree-backend] ${input.taskId}: failed to inspect branch conflict: ${formatError(inspectError).detail}`,
        );
      }

      if (inspection?.kind === "live-foreign") {
        throw inspection.error;
      }

      throw error;
    }
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    // FN-4678: migrate remove call sites to backend.remove().
    await execAsync(`git worktree remove --force ${quoteShellArg(input.worktreePath)}`, {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: REMOVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  }

  async sync(input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
    await execAsync("git fetch --all --prune", {
      cwd: input.worktreePath,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    await execAsync(`git rebase ${quoteShellArg(`origin/${input.branch}`)}`, {
      cwd: input.worktreePath,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    return { skipped: false };
  }

  async prune(input: WorktreePruneInput): Promise<void> {
    await execAsync("git worktree prune", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: NATIVE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  }
}

export class WorktrunkWorktreeBackend implements WorktreeBackend {
  readonly kind: WorktreeBackendKind = "worktrunk";

  constructor(
    private readonly deps: {
      binaryPath: string | null;
      logger?: { log: (m: string) => void; warn: (m: string) => void };
    },
  ) {}

  private getBinaryPath(operation: WorktreeOperation): string {
    const binaryPath = this.deps.binaryPath?.trim() ?? "";
    if (!binaryPath) {
      throw new WorktrunkOperationError({
        operation,
        code: "worktrunk_binary_missing",
        stderr: "worktrunk binary not configured",
        exitCode: null,
      });
    }
    return binaryPath;
  }

  private async runWorktrunk(operation: WorktreeOperation, rootDir: string, args: string[]): Promise<void> {
    const binaryPath = this.getBinaryPath(operation);
    const command = `${quoteShellArg(binaryPath)} ${args.map((arg) => quoteShellArg(arg)).join(" ")}`;
    this.deps.logger?.log?.(`[worktree-backend] running worktrunk command: ${command}`);

    try {
      await execAsync(command, {
        cwd: rootDir,
        encoding: "utf-8",
        timeout: WORKTRUNK_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
    } catch (error) {
      const stderr = getErrorStderr(error) ?? String(error);
      const exitCode = getErrorExitCode(error);
      this.deps.logger?.warn?.(`[worktree-backend] worktrunk ${operation} failed: ${stderr}`);
      throw new WorktrunkOperationError({
        operation,
        code: "worktrunk_operation_failed",
        stderr,
        exitCode,
      });
    }
  }

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    // worktrunk mapping: `wt switch --create <branch> [startPoint]`.
    const args = ["switch", "--create", input.branch];
    if (input.startPoint) args.push(input.startPoint);
    await this.runWorktrunk("create", input.rootDir, args);
    return { path: input.worktreePath, branch: input.branch };
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    // worktrunk mapping: `wt remove <branch>` from repo root.
    await this.runWorktrunk("remove", input.rootDir, ["remove", input.branch ?? input.worktreePath]);
  }

  async sync(_input: WorktreeSyncInput): Promise<{ skipped: boolean }> {
    throw new WorktrunkOperationError({
      operation: "sync",
      code: "worktrunk_unsupported_operation",
      stderr: "worktrunk sync operation is not mapped by this backend",
      exitCode: null,
    });
  }

  async prune(_input: WorktreePruneInput): Promise<void> {
    throw new WorktrunkOperationError({
      operation: "prune",
      code: "worktrunk_unsupported_operation",
      stderr: "worktrunk prune operation is not mapped by this backend",
      exitCode: null,
    });
  }
}

export function resolveWorktreeBackend(
  settings: Partial<Settings>,
  deps: { logger?: { log: (m: string) => void; warn: (m: string) => void } } = {},
): WorktreeBackend {
  if (settings.worktrunk?.enabled === true) {
    return new WorktrunkWorktreeBackend({
      binaryPath: settings.worktrunk.binaryPath ?? null,
      logger: deps.logger,
    });
  }

  return new NativeWorktreeBackend({ logger: deps.logger });
}
