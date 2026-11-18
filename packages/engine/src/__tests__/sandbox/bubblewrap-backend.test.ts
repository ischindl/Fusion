import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectMock } = vi.hoisted(() => ({ detectMock: vi.fn() }));

vi.mock("../../sandbox/bubblewrap-detect.js", () => ({
  detectBwrap: detectMock,
}));

import { BubblewrapBackend, SandboxUnavailableError } from "../../sandbox/bubblewrap-backend.js";
import type { SandboxBackend, SandboxRunResult } from "../../sandbox/types.js";

const hasBwrap = (() => {
  try {
    return !!execSync("command -v bwrap", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false;
  }
})();

function bindSources(args: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--bind" || args[i] === "--ro-bind") {
      sources.push(args[i + 1]!);
      i += 1;
    }
  }
  return sources;
}

describe("BubblewrapBackend", () => {
  beforeEach(() => {
    detectMock.mockReset();
  });

  it("reports bubblewrap capabilities", () => {
    const backend = new BubblewrapBackend();
    expect(backend.capabilities().id).toBe("bubblewrap");
    expect(backend.capabilities().supportsFilesystemPolicy).toBe(true);
  });

  it("throws on prepare when bwrap unavailable and fail-hard", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const backend = new BubblewrapBackend();

    await expect(backend.prepare({ allowNetwork: true })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("falls back to native when requested", async () => {
    detectMock.mockResolvedValue({ available: false, reason: "not-installed" });
    const runResult: SandboxRunResult = {
      stdout: "native",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    };

    const nativeStub: SandboxBackend = {
      capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
      prepare: vi.fn(async () => undefined),
      run: vi.fn(async () => runResult),
      runStreaming: vi.fn(async () => ({ outcome: "success" as const, stdout: "", stderr: "", bufferOverflow: false })),
      dispose: vi.fn(async () => undefined),
    };

    const backend = new BubblewrapBackend(nativeStub);
    await backend.prepare({ allowNetwork: true, env: {}, allowedReadPaths: [], allowedWritePaths: [], failureMode: "fallback-native" } as any);

    const result = await backend.run("echo hi", { cwd: cwd(), timeoutMs: 1_000, maxBuffer: 1024, encoding: "utf-8" });
    expect(result.stdout).toBe("native");
    expect(nativeStub.run).toHaveBeenCalled();
  });

  it("attempts bwrap execution when available", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/test-bwrap" });
    const runBwrap = vi.fn(async (): Promise<SandboxRunResult> => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    }));
    const backend = new BubblewrapBackend(undefined, runBwrap);
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo hello", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.stdout).toBe("hello\n");
    expect(runBwrap).toHaveBeenCalledOnce();
    const [command, args] = runBwrap.mock.calls[0];
    expect(command).toBe("/usr/bin/test-bwrap");
    expect(args.at(-3)).toBe("/bin/sh");
    expect(args.at(-2)).toBe("-lc");
    expect(args.at(-1)).toBe("echo hello");
  });

  /*
  FNXC:AIoSandbox 2026-11-18-18:52:
  Regression for the defect RUFU-732 found through the real-integration case below: `BubblewrapBackend` built
  its bwrap argv without the `pathExists` predicate `policyToBwrapArgs` exposes, so every path it supplied was
  mounted unconditionally. bwrap refuses a missing bind source outright - `bwrap: Can't find source path <p>`,
  exit 1 - so a single absent directory (measured: the pnpm store dir resolved from a redirected HOME)
  aborted EVERY sandboxed command before the wrapped command ran. `BubblewrapBackend.ts` now passes
  `existsSync`.

  Asserted as the invariant, not the reported repro: NO argv surface may name a source that is not on disk,
  and dropping one mount must not cost the caller the rest of the sandbox. Both surfaces that assemble this
  argv are covered - `run` (the spawn path) and `wrapCommand` (the shell-prelude path streaming and the
  sandbox-exec hand-off use) - because a fix applied at only one of them would leave the other able to
  reproduce the original failure.
  */
  it("omits a nonexistent policy path from every argv surface without dropping the sandbox", async () => {
    detectMock.mockResolvedValue({ available: true, path: "/usr/bin/test-bwrap" });
    const runBwrap = vi.fn(async (): Promise<SandboxRunResult> => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      bufferExceeded: false,
    }));
    const realDir = mkdtempSync(join(tmpdir(), "fusion-bwrap-bind-"));
    const missingDir = join(realDir, "pnpm-store-not-created");

    try {
      const backend = new BubblewrapBackend(undefined, runBwrap);
      await backend.prepare({ allowNetwork: true, allowedWritePaths: [realDir, missingDir] });

      await backend.run("echo hello", {
        cwd: realDir,
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });

      expect(runBwrap).toHaveBeenCalledOnce();
      const [, runArgs] = runBwrap.mock.calls[0]!;
      expect(bindSources(runArgs)).toContain(realDir);
      expect(bindSources(runArgs)).not.toContain(missingDir);
      // The rest of the containment contract survives the omission.
      expect(runArgs).toContain("--unshare-pid");
      expect(runArgs).toContain("--proc");
      expect(runArgs).toContain("--clearenv");
      expect(runArgs.at(-3)).toBe("/bin/sh");
      expect(runArgs.at(-1)).toBe("echo hello");

      const wrapped = backend.wrapCommand("echo hello", { cwd: realDir });
      expect(wrapped).not.toBeNull();
      expect(bindSources(wrapped!.args)).not.toContain(missingDir);
      expect(bindSources(wrapped!.args)).toContain(realDir);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  /*
  FNXC:AIoSandbox 2026-11-18-18:24:
  RUFU-732 fixed why this case was red on a host that has a working bubblewrap. `vi.doUnmock` alone cannot
  undo the hoisted `vi.mock` above for an ALREADY-EVALUATED module: `bubblewrap-backend.js` is imported
  statically at the top of this file, so its `detectBwrap` binding is permanently the mock, and the re-import
  below returned that same cached instance. With `detectMock.mockReset()` applied in `beforeEach`, the real
  `prepare()` therefore read `{ available: undefined }` and threw `TypeError: Cannot read properties of
  undefined (reading 'available')` at bubblewrap-backend.ts - the case never reached `bwrap` at all. Measured
  on the failing host before the fix: detection answered
  `{ available: true, version: "0.13.0", path: "/usr/bin/bwrap" }` and the same argv shape the backend builds
  ran `echo hello` with exit 0 and empty stderr, so the red was never an environment denial and neither the
  existence-only gate above nor the sandbox itself needed changing.

  `vi.resetModules()` is what makes the unmock effective: the backend is re-evaluated, so its `import` of the
  detect module resolves for real. The case then asserts the capability it is about to depend on instead of
  assuming it, which turns a silent `undefined` read into a named verdict if a future host ships `bwrap` on
  PATH but unable to create a sandbox.
  */
  it.skipIf(process.platform !== "linux" || !hasBwrap)("runs real bubblewrap hello integration", async () => {
    vi.doUnmock("../../sandbox/bubblewrap-detect.js");
    vi.resetModules();
    const { detectBwrap: realDetect } = await import("../../sandbox/bubblewrap-detect.js");
    const capability = await realDetect();
    expect(capability.available, `real bwrap detection failed: ${capability.reason}`).toBe(true);

    const { BubblewrapBackend: RealBackend } = await import("../../sandbox/bubblewrap-backend.js");
    const backend = new RealBackend();
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo hello", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode, `real bwrap run failed: stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`).toBe(0);
    expect(result.stdout.trim()).toBe("hello");

    /*
    FNXC:AIoSandbox 2026-11-18-18:24:
    `exit 0` plus "hello" is what let this case do nothing for its whole life: an UNCONTAINED run of the same
    command prints the same bytes. `policyToBwrapArgs` always passes `--unshare-pid`, so inside the sandbox
    the `/bin/sh` the backend launches is PID 1 or 2, while a native spawn inherits the host's PID space
    (thousands and up on any machine that just ran a test worker). Asserting the small PID is the cheap,
    read-only proof that the command really executed inside a new PID namespace; the bound of 4 leaves room
    for bwrap's intermediate init while staying unreachable natively.
    */
    const pidInsideSandbox = await backend.run('printf %s "$$"', {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(pidInsideSandbox.exitCode).toBe(0);
    expect(Number(pidInsideSandbox.stdout)).toBeLessThanOrEqual(4);
  });
});
