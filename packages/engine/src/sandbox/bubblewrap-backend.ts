import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

import { detectBwrap } from "./bubblewrap-detect.js";
import { policyToBwrapArgs, type BubblewrapPolicy } from "./bubblewrap-policy.js";
import { NativeSandboxBackend } from "./native.js";
import type { SandboxBackend, SandboxCapabilities, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "./types.js";

const execAsync = promisify(exec);

type FailureMode = "fail-hard" | "fallback-native";

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class BubblewrapBackend implements SandboxBackend {
  private policy: BubblewrapPolicy = { allowNetwork: true };
  private useNativeFallback = false;
  private pnpmStorePathByCwd = new Map<string, string>();

  constructor(private readonly nativeBackend: SandboxBackend = new NativeSandboxBackend()) {}

  capabilities(): SandboxCapabilities {
    return {
      id: "bubblewrap",
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: true,
      platform: ["linux"],
    };
  }

  async prepare(policy: SandboxPolicy): Promise<void> {
    this.policy = policy as BubblewrapPolicy;

    const detect = await detectBwrap();
    if (detect.available) return;

    const failureMode = (this.policy as BubblewrapPolicy & { failureMode?: FailureMode }).failureMode ?? "fail-hard";
    if (failureMode === "fallback-native") {
      this.useNativeFallback = true;
      await this.nativeBackend.prepare(policy);
      return;
    }

    throw new SandboxUnavailableError(
      `bubblewrap backend unavailable (${detect.reason ?? "unknown"}). Install bubblewrap and retry.`,
    );
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    if (this.useNativeFallback) {
      return this.nativeBackend.run(command, options);
    }

    const detect = await detectBwrap();
    if (!detect.available) {
      const failureMode = (this.policy as BubblewrapPolicy & { failureMode?: FailureMode }).failureMode ?? "fail-hard";
      if (failureMode === "fallback-native") {
        return this.nativeBackend.run(command, options);
      }
      throw new SandboxUnavailableError(
        `bubblewrap backend unavailable (${detect.reason ?? "unknown"}). Install bubblewrap and retry.`,
      );
    }

    const pnpmStorePath = await this.resolvePnpmStorePath(options.cwd);
    const policyArgs = policyToBwrapArgs(this.policy, {
      worktreePath: options.cwd,
      repoRootPath: options.cwd,
      pnpmStorePath,
      nodeBinPath: process.execPath,
      homeDir: process.env.HOME ?? "",
      envSource: options.env ?? process.env,
    });

    const bwrapPath = detect.path ?? "bwrap";
    return this.runBwrapSpawn(bwrapPath, [...policyArgs, "--", "/bin/sh", "-lc", command], options);
  }

  async dispose(): Promise<void> {
    this.useNativeFallback = false;
    this.pnpmStorePathByCwd.clear();
  }

  private async resolvePnpmStorePath(cwd: string): Promise<string> {
    const cached = this.pnpmStorePathByCwd.get(cwd);
    if (cached) return cached;
    let resolved = `${process.env.HOME ?? ""}/.local/share/pnpm`;
    try {
      const { stdout } = await execAsync("pnpm store path --silent", {
        cwd,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        encoding: "utf-8",
      });
      resolved = stdout.trim() || resolved;
    } catch {
      // fallback path above
    }
    this.pnpmStorePathByCwd.set(cwd, resolved);
    return resolved;
  }

  private runBwrapSpawn(command: string, args: string[], options: SandboxRunOptions): Promise<SandboxRunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let bufferExceeded = false;
      let spawnError: Error | undefined;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);

      const maxBuffer = options.maxBuffer;
      const onChunk = (target: Buffer[], chunk: Buffer, isStdout: boolean): void => {
        if (bufferExceeded) return;
        if (isStdout) {
          stdoutBytes += chunk.length;
        } else {
          stderrBytes += chunk.length;
        }
        if (stdoutBytes + stderrBytes > maxBuffer) {
          bufferExceeded = true;
          child.kill("SIGTERM");
          return;
        }
        target.push(chunk);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        onChunk(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), true);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        onChunk(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false);
      });

      child.on("error", (error) => {
        spawnError = error;
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(options.encoding ?? "utf-8"),
          stderr: Buffer.concat(stderrChunks).toString(options.encoding ?? "utf-8"),
          exitCode: code,
          signal,
          timedOut,
          bufferExceeded,
          spawnError,
        });
      });
    });
  }
}
