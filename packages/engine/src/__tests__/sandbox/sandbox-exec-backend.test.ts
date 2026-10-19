import { cwd } from "node:process";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectMock, policyToProfileMock, presetMock, nativeRunMock, nativePrepareMock, nativeDisposeMock, loggerMock, execMock, rootResolution } = vi.hoisted(() => {
  /*
  FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:29 (RUFU-334):
  The backend now resolves its working root through `sandbox-exec-policy.js`, so this module mock has to
  carry those exports with their real semantics (explicit root or a named refusal) — otherwise a mocked
  profile leg would silently see `undefined` where production raises `SandboxWritableRootMissingError`.
  */
  class SandboxWritableRootMissingErrorMock extends Error {
    readonly code = "SANDBOX_WRITABLE_ROOT_MISSING";
    constructor(lane: string) {
      super(`missing sandbox writable root (${lane})`);
      this.name = "SandboxWritableRootMissingError";
    }
  }
  return {
    detectMock: vi.fn(),
    policyToProfileMock: vi.fn(),
    presetMock: vi.fn(),
    nativeRunMock: vi.fn(),
    nativePrepareMock: vi.fn(),
    nativeDisposeMock: vi.fn(),
    loggerMock: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    execMock: vi.fn(),
    rootResolution: {
      SandboxWritableRootMissingError: SandboxWritableRootMissingErrorMock,
      resolveSandboxWritableRoot: vi.fn((opts: { runCwd?: string | null; policyWriteRoot?: string | null; policyReadRoot?: string | null; lane: string }) => {
        const trimmed = [opts.runCwd, opts.policyWriteRoot, opts.policyReadRoot]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .find(Boolean);
        if (!trimmed) throw new SandboxWritableRootMissingErrorMock(opts.lane);
        return trimmed;
      }),
      deriveSandboxRepoRoot: vi.fn((worktreePath: string) => worktreePath),
    },
  };
});

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: vi.fn(),
}));

vi.mock("../../sandbox/sandbox-exec-detect.js", () => ({
  detectSandboxExec: detectMock,
}));

vi.mock("../../sandbox/sandbox-exec-policy.js", () => ({
  policyToSbplProfile: policyToProfileMock,
  fusionWorktreePreset: presetMock,
  resolveSandboxWritableRoot: rootResolution.resolveSandboxWritableRoot,
  deriveSandboxRepoRoot: rootResolution.deriveSandboxRepoRoot,
  SandboxWritableRootMissingError: rootResolution.SandboxWritableRootMissingError,
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => loggerMock,
}));

vi.mock("../../sandbox/native.js", () => ({
  NativeSandboxBackend: class {
    prepare = nativePrepareMock;
    run = nativeRunMock;
    runStreaming = vi.fn();
    dispose = nativeDisposeMock;
    capabilities() {
      return { id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" };
    }
  },
}));

describe("SandboxExecBackend", () => {
  beforeEach(() => {
    vi.resetModules();
    detectMock.mockReset();
    policyToProfileMock.mockReset();
    presetMock.mockReset();
    nativeRunMock.mockReset();
    nativePrepareMock.mockReset();
    nativeDisposeMock.mockReset();
    execMock.mockReset();
    (execMock as unknown as Record<symbol, unknown>)[promisify.custom] = vi.fn();
    loggerMock.log.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
  });

  it("reports capabilities", async () => {
    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    expect(backend.capabilities().id).toBe("sandbox-exec");
  });

  it("throws on prepare fail-hard when unavailable", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const { SandboxExecBackend, SandboxUnavailableError } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();

    await expect(backend.prepare({ allowNetwork: true })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("fallback-native delegates runs and logs once", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    nativeRunMock.mockResolvedValue({ stdout: "native", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();

    await backend.prepare({ allowNetwork: true, failureMode: "fallback-native" } as any);
    await backend.run("echo a", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024 });
    await backend.run("echo b", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024 });

    expect(nativeRunMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0]?.[0]).toContain("sandbox:fallback");
  });

  it("executes sandbox-exec command and maps success", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({ stdout: "ok", stderr: "" });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, allowedWritePaths: [cwd()] });
    const result = await backend.run("echo hello", { cwd: cwd(), timeoutMs: 2_000, maxBuffer: 1024 * 1024 });

    const execAsyncMock = (execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>;
    const cmd = execAsyncMock.mock.calls.find((call) => String(call[0]).includes("sandbox-exec"))?.[0] as string;
    expect(cmd).toContain("sandbox-exec -p");
    expect(cmd).toContain("/bin/sh -c");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(loggerMock.log).toHaveBeenCalled();
  });

  it("maps timeout and maxBuffer failures", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");
    const err = Object.assign(new Error("timed out maxBuffer"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      signal: "SIGTERM",
      stdout: "",
      stderr: "boom",
    });
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, allowedWritePaths: [cwd()] });
    const result = await backend.run("echo hello", { cwd: cwd(), timeoutMs: 2_000, maxBuffer: 1 });

    expect(result.bufferExceeded).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("sandbox:failure"));
  });

  /*
  FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:20 (RUFU-334):
  The Seatbelt profile used to be built once in `prepare()` from `allowedWritePaths?.[0] ?? process.cwd()`
  — a grant list for a directory nobody chose (the dashboard's launch tree on the incident host) that was
  then reused for every run. These cases pin the replacement contract: a leg with no explicit root raises
  `SANDBOX_WRITABLE_ROOT_MISSING` under fail-hard, delegates to the native backend under fallback-native,
  and a profile is never generated from the process working directory.
  */
  it("refuses a run with no explicit working root under fail-hard", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, failureMode: "fail-hard" } as any);

    await expect(
      backend.run("echo hello", { timeoutMs: 2_000, maxBuffer: 1024 } as any),
    ).rejects.toBeInstanceOf(rootResolution.SandboxWritableRootMissingError);

    const execAsyncMock = (execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>;
    expect(execAsyncMock.mock.calls.some((call) => String(call[0]).includes("sandbox-exec"))).toBe(false);
    expect(rootResolution.resolveSandboxWritableRoot).toHaveBeenCalledWith(expect.objectContaining({ lane: "run" }));
  });

  it("refuses wrapCommand with no explicit working root, naming the leg", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true } as any);

    expect(() => backend.wrapCommand("echo hello", {})).toThrow(
      rootResolution.SandboxWritableRootMissingError,
    );
    expect(rootResolution.resolveSandboxWritableRoot).toHaveBeenLastCalledWith(
      expect.objectContaining({ lane: "wrapCommand" }),
    );
  });

  it("delegates a root-less run to the native backend under fallback-native", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    nativeRunMock.mockResolvedValue({ stdout: "native", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    await backend.prepare({ allowNetwork: true, failureMode: "fallback-native" } as any);

    const result = await backend.run("echo hello", { timeoutMs: 2_000, maxBuffer: 1024 } as any);

    expect(result.stdout).toBe("native");
    expect(nativeRunMock).toHaveBeenCalledTimes(1);
    // The refusal was reached and absorbed by the policy mode, not skipped.
    expect(rootResolution.resolveSandboxWritableRoot).toHaveBeenCalled();
    const execAsyncMock = (execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>;
    expect(execAsyncMock.mock.calls.some((call) => String(call[0]).includes("sandbox-exec"))).toBe(false);
  });

  it("builds one profile per run cwd instead of one inherited root", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/sandbox-exec" });
    presetMock.mockReturnValue({ allowNetwork: true });
    policyToProfileMock.mockReturnValue("(version 1)\n(allow default)");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({ stdout: "ok", stderr: "" });

    const { SandboxExecBackend } = await import("../../sandbox/sandbox-exec-backend.js");
    const backend = new SandboxExecBackend();
    // No declared write paths: every root must come from the run itself.
    await backend.prepare({ allowNetwork: true } as any);

    await backend.run("echo a", { cwd: "/work/fusion/task-one", timeoutMs: 2_000, maxBuffer: 1024 });
    await backend.run("echo b", { cwd: "/work/fusion/task-two", timeoutMs: 2_000, maxBuffer: 1024 });

    const roots = policyToProfileMock.mock.calls.map((call) => (call[1] as { worktreePath: string }).worktreePath);
    expect(roots).toEqual(["/work/fusion/task-one", "/work/fusion/task-two"]);
    expect(roots).not.toContain(cwd());
  });

  it.skipIf(process.platform !== "darwin")("runs real sandbox-exec hello integration", async () => {
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(childProcess.exec);

    try {
      const { stdout } = await execAsync("sandbox-exec -p '(version 1)(allow default)' /bin/echo hello", {
        cwd: cwd(),
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });
      expect(stdout).toBe("hello\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) {
        return;
      }
      throw error;
    }
  });
});
