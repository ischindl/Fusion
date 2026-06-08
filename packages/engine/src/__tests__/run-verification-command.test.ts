import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runVerificationCommand, normalizeVerificationCommand, type RunVerificationOptions } from "../run-verification-tool.js";

// Some tests use platform-appropriate shell syntax. On Windows, sh-style
// quoting and pipes through `printf` are different — these tests are skipped
// when running on win32. The implementation itself is portable via
// `shell: true` (Node picks cmd.exe on Windows, /bin/sh on POSIX).
const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

/**
 * Tests for runVerificationCommand - the core verification execution logic.
 * These tests validate basic command execution, output capture, and error handling.
 *
 * NOTE: Timeout testing is intentionally excluded because the tool enforces its
 * own timeouts which conflict with test timeouts. The timeout behavior is validated
 * during integration testing in the main test suite.
 */
// Pick a sandbox-safe cwd. On macOS/Linux we use "/tmp" rather than
// os.tmpdir() because some sandboxed runners cannot reach the per-user
// $TMPDIR (e.g. /var/folders/.../T on macOS). On Windows /tmp does not exist
// so we fall back to os.tmpdir() which is always C:\Users\…\Temp there.
describe("runVerificationCommand", { timeout: 30000 }, () => {
  const tempDir = onPosix ? "/tmp" : tmpdir();
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  describe("command normalization", () => {
    it("rewrites package test -- --run filters to direct vitest with package-relative files", () => {
      const result = normalizeVerificationCommand(
        [
          "pnpm --filter @fusion/dashboard test -- --run",
          "packages/dashboard/src/__tests__/routes-tasks.test.ts",
          "packages/dashboard/src/__tests__/routes-settings.test.ts",
        ].join(" "),
        workspaceRoot,
      );

      expect(result.command).toBe(
        [
          "pnpm --filter @fusion/dashboard exec vitest run",
          "src/__tests__/routes-tasks.test.ts",
          "src/__tests__/routes-settings.test.ts",
          "--silent=passed-only --reporter=dot",
        ].join(" "),
      );
      expect(result.warnings).toEqual([
        expect.stringContaining("rewrote package test file filter"),
      ]);
    });

    it("leaves ordinary package tests unchanged when no file filter is forwarded", () => {
      const command = "pnpm --filter @fusion/dashboard test";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("leaves commands with unterminated shell quotes unchanged", () => {
      const command = "pnpm --filter @fusion/dashboard test -- --run 'src/__tests__/routes-tasks.test.ts";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("preserves pnpm global flags that precede --filter", () => {
      const result = normalizeVerificationCommand(
        "pnpm -w --filter @fusion/dashboard test -- --run packages/dashboard/src/__tests__/routes-tasks.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm -w --filter @fusion/dashboard exec vitest run src/__tests__/routes-tasks.test.ts --silent=passed-only --reporter=dot",
      );
    });

    it("verifies the CLI package directory through package.json before rewriting", () => {
      const result = normalizeVerificationCommand(
        "pnpm --filter @runfusion/fusion test -- --run packages/cli/src/__tests__/cli.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm --filter @runfusion/fusion exec vitest run src/__tests__/cli.test.ts --silent=passed-only --reporter=dot",
      );
    });
  });

  describe("basic command execution", () => {
    it("executes a simple echo command and captures output", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo test-output",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test-output");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("returns correct exit code for failed command", async () => {
      // `exit N` is recognised by both POSIX sh and Windows cmd.exe.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 42",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    });

    it("returns success when expectFailure=true and command exits non-zero", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 3",
        cwd: tempDir,
        timeoutMs: 30000,
        expectFailure: true,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(3);
    });
  });

  describe("timeouts", () => {
    itPosix("times out and kills a quiet long-running process group", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "sh -c 'sleep 10 & wait'",
        cwd: tempDir,
        timeoutMs: 100,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(5_000);
    });
  });

  describe("output capture", () => {
    itPosix("captures multi-line stdout (POSIX shell)", async () => {
      // POSIX uses `;` as a command separator; cmd.exe uses `&`. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo line1; echo line2; echo line3",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).toContain("line3");
    });

    itPosix("captures stderr separately (POSIX shell)", async () => {
      // `>&2` redirect syntax is POSIX-specific. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo to-stdout; echo to-stderr >&2",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("to-stdout");
      expect(result.stderr).toContain("to-stderr");
    });
  });

  describe("heartbeat callbacks", () => {
    itPosix("fires onHeartbeat for each output line (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo a; echo b; echo c",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      // Should call heartbeat at least once per line
      expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    itPosix("fires onLine callback with each line when provided (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const onLine = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo hello; echo world",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
        onLine,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(onLine.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("error handling", () => {
    itPosix("handles missing commands gracefully (POSIX sh reports exit 127)", async () => {
      // The implementation runs commands via the platform shell. POSIX sh
      // returns exit 127 for "command not found"; cmd.exe returns 1 (or
      // 9009 in some cases). This test pins the POSIX behaviour.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "/nonexistent/command/path",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.timedOut).toBe(false);
    });

    it("includes all result fields", async () => {
      // `exit 0` is portable across POSIX sh and cmd.exe; `true` is POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 0",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("durationMs");
      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("timedOut");
      expect(result).toHaveProperty("killed");
      expect(result).toHaveProperty("command");
      expect(result).toHaveProperty("cwd");
      expect(result).toHaveProperty("warnings");
    });

    it("preserves command and cwd in result", async () => {
      const onHeartbeat = vi.fn();
      const command = "echo preserved";
      const opts: RunVerificationOptions = {
        command,
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.command).toBe(command);
      expect(result.cwd).toBe(tempDir);
    });
  });

  describe("complex shell commands", () => {
    itPosix("handles piped commands (POSIX shell)", async () => {
      // The implementation runs commands through the platform shell. POSIX
      // pipes + printf differ from Windows cmd.exe syntax, so this test is
      // POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "printf 'test1\\ntest2\\ntest3\\n' | grep test",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("test1");
    });

    itPosix("executes commands with environment variables (POSIX shell)", async () => {
      // POSIX shell expansion ($USER) differs from Windows (%USERNAME%).
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo $USER",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      // Should have output (USER is typically set)
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });
  });
});
