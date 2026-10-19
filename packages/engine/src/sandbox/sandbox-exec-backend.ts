import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { detectSandboxExec } from "./sandbox-exec-detect.js";
import {
  deriveSandboxRepoRoot,
  fusionWorktreePreset,
  policyToSbplProfile,
  resolveSandboxWritableRoot,
  SandboxWritableRootMissingError,
  type SandboxExecContext,
  type SandboxExecPolicy,
} from "./sandbox-exec-policy.js";
import { NativeSandboxBackend } from "./native.js";
import type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunStreamingOptions,
  SandboxStreamingResult,
} from "./types.js";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);
const log = createLogger("sandbox-exec");

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultPnpmStorePath(): string {
  return path.join(os.homedir(), "Library/pnpm/store");
}

/** True when the policy states its own paths, so the legacy preset is not implied. */
function hasExplicitPaths(policy: SandboxExecPolicy): boolean {
  return Boolean(policy.allowedWritePaths || policy.allowedReadPaths);
}

export class SandboxExecBackend implements SandboxBackend {
  private currentPolicy: SandboxExecPolicy = { allowNetwork: true };
  private prepared = false;
  private useNativeFallback = false;
  private fallbackAlerted = false;
  /**
   * The pnpm store path is probed once per declared root (the probe is a subprocess, so it can only run in
   * an async leg); the synchronous wrap leg reads this cache and falls back to the platform default.
   */
  private readonly pnpmStorePathByRoot = new Map<string, string>();

  constructor(private readonly nativeBackend: SandboxBackend = new NativeSandboxBackend()) {}

  capabilities(): SandboxCapabilities {
    return {
      id: "sandbox-exec",
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: true,
      supportsStreaming: true,
      platform: ["darwin"],
    };
  }

  /*
  FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:29 (RUFU-334):
  prepare() used to root the whole backend with `allowedWritePaths?.[0] ?? process.cwd()`, and
  `repoRootPath` was `process.cwd()` outright — so a Seatbelt profile was generated for a directory
  nobody had chosen, granting writes inside the server's own launch tree (the deployment checkout in the
  incident), and that one profile was then reused for every run regardless of its real cwd.
  prepare() now only detects capability and holds the policy: a profile is built in the legs that carry an
  explicit working directory (`run`, `runStreaming`, `wrapCommand`), each against its own cwd. Nothing
  here can silently root a policy any more.
  */
  async prepare(policy: SandboxPolicy): Promise<void> {
    const nextPolicy = policy as SandboxExecPolicy;
    const policyChanged = JSON.stringify(this.currentPolicy) !== JSON.stringify(nextPolicy);
    this.currentPolicy = nextPolicy;
    if (!policyChanged && this.prepared) {
      return;
    }

    const detect = await detectSandboxExec();
    if (!detect.available) {
      if ((nextPolicy.failureMode ?? "fail-hard") === "fallback-native") {
        this.useNativeFallback = true;
        if (!this.fallbackAlerted) {
          log.warn(`[event:sandbox:fallback] backend=sandbox-exec reason=${detect.reason ?? "unknown"}`);
          this.fallbackAlerted = true;
        }
        await this.nativeBackend.prepare(policy);
        return;
      }
      throw new SandboxUnavailableError(
        "sandbox-exec not available on this host; install Xcode Command Line Tools or set sandbox.failureMode='fallback-native'",
      );
    }

    this.useNativeFallback = false;

    const declaredRoot = nextPolicy.allowedWritePaths?.[0] ?? nextPolicy.allowedReadPaths?.[0] ?? null;
    if (declaredRoot) {
      await this.probePnpmStore(declaredRoot);
    }

    this.prepared = true;
    log.log("[event:sandbox:prepare] backend=sandbox-exec");
  }

  /** Resolve a store path once per root; a failed probe keeps the platform default. */
  private async probePnpmStore(root: string): Promise<string> {
    const cached = this.pnpmStorePathByRoot.get(root);
    if (cached) return cached;
    let storePath = defaultPnpmStorePath();
    try {
      const { stdout } = await execAsync("pnpm store path --silent", {
        cwd: root,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        encoding: "utf-8",
      });
      storePath = stdout.trim() || storePath;
    } catch {
      // keep the default store path
    }
    this.pnpmStorePathByRoot.set(root, storePath);
    return storePath;
  }

  /**
   * Build the profile context for one leg from an explicit working directory. A blank root follows the
   * policy's `failureMode`: `fallback-native` returns null so the leg runs through the native backend,
   * while `fail-hard` raises the named refusal — it never falls back to the process working directory.
   * Only `allowedWritePaths` can supply the root: a policy that declares read paths alone has no
   * writable root by definition, and borrowing a read root as the write boundary is the leak this closes.
   */
  private buildContext(rawCwd: string | null | undefined, lane: string): SandboxExecContext | null {
    let worktreePath: string;
    try {
      worktreePath = resolveSandboxWritableRoot({
        runCwd: rawCwd,
        policyWriteRoot: this.currentPolicy.allowedWritePaths?.[0],
        lane,
      });
    } catch (err) {
      if (err instanceof SandboxWritableRootMissingError && (this.currentPolicy.failureMode ?? "fail-hard") === "fallback-native") {
        return null;
      }
      throw err;
    }
    return {
      worktreePath,
      repoRootPath: deriveSandboxRepoRoot(worktreePath),
      pnpmStorePath: this.pnpmStorePathByRoot.get(worktreePath) ?? defaultPnpmStorePath(),
      nodeBinPath: process.execPath,
      homeDir: os.homedir(),
      tmpDirOverride: os.tmpdir(),
    };
  }

  private profileFor(ctx: SandboxExecContext): string {
    const basePolicy = hasExplicitPaths(this.currentPolicy) ? this.currentPolicy : fusionWorktreePreset(ctx);
    return policyToSbplProfile(basePolicy, ctx);
  }

  wrapCommand(command: string, options: Pick<SandboxRunOptions, "cwd" | "env">) {
    if (this.useNativeFallback) return null;
    const ctx = this.buildContext(options.cwd, "wrapCommand");
    if (!ctx) return null;
    return { command: "sandbox-exec", args: ["-p", this.profileFor(ctx), "/bin/sh", "-c", command] };
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    const startedAt = Date.now();

    if (this.useNativeFallback) {
      return this.nativeBackend.run(command, options);
    }

    const ctx = this.buildContext(options.cwd, "run");
    if (!ctx) {
      return this.nativeBackend.run(command, options);
    }
    const profile = this.profileFor(ctx);

    const wrappedCommand = `sandbox-exec -p ${shEscape(profile)} /bin/sh -c ${shEscape(command)}`;
    log.log(`[event:sandbox:run] backend=sandbox-exec cmd=${JSON.stringify(command)}`);

    try {
      const execOptions: Parameters<typeof exec>[1] = {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: options.env,
        signal: options.signal,
        ...(options.encoding !== undefined && { encoding: options.encoding }),
        ...(typeof options.shell === "string" && { shell: options.shell }),
      };
      const { stdout, stderr } = await execAsync(wrappedCommand, execOptions);

      const result: SandboxRunResult = {
        stdout: stdout?.toString?.() ?? "",
        stderr: stderr?.toString?.() ?? "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
      };
      log.log(`[event:sandbox:run] backend=sandbox-exec durationMs=${Date.now() - startedAt} exitCode=0`);
      return result;
    } catch (error) {
      const errObj = error as Record<string, unknown>;
      const code = errObj.code;
      const status = typeof errObj.status === "number" ? errObj.status : null;
      const exitCode = typeof code === "number" ? code : status;
      const message = String(errObj.message ?? "");

      log.warn(`[event:sandbox:failure] backend=sandbox-exec durationMs=${Date.now() - startedAt} exitCode=${String(exitCode)}`);
      return {
        stdout: typeof (errObj.stdout as { toString?: unknown })?.toString === "function" ? String(errObj.stdout) : "",
        stderr: typeof (errObj.stderr as { toString?: unknown })?.toString === "function" ? String(errObj.stderr) : "",
        exitCode,
        signal: (errObj.signal as NodeJS.Signals | null | undefined) ?? null,
        bufferExceeded:
          code === "ENOBUFS"
          || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          || message.includes("maxBuffer"),
        timedOut:
          code === "ETIMEDOUT"
          || (errObj.killed === true && (errObj.signal === "SIGTERM" || message.includes("timed out"))),
        spawnError: code === "ENOENT" || code === "EACCES" ? (error as Error) : undefined,
      };
    }
  }

  async runStreaming(command: string, options: SandboxRunStreamingOptions): Promise<SandboxStreamingResult> {
    if (this.useNativeFallback) return this.nativeBackend.runStreaming(command, options);

    const ctx = this.buildContext(options.cwd, "runStreaming");
    if (!ctx) return this.nativeBackend.runStreaming(command, options);
    const profile = this.profileFor(ctx);
    /*
    FNXC:WorkspaceSandbox 2026-08-22-21:44:
    FN-158 routes streaming verification through Seatbelt. Native streaming
    still owns timeout and process-group reaping, but its group leader is now
    sandbox-exec rather than the uncontained command shell.
    */
    return this.nativeBackend.runStreaming(
      `sandbox-exec -p ${shEscape(profile)} /bin/sh -c ${shEscape(command)}`,
      options,
    );
  }

  async dispose(): Promise<void> {
    this.prepared = false;
    this.useNativeFallback = false;
    this.pnpmStorePathByRoot.clear();
  }
}
