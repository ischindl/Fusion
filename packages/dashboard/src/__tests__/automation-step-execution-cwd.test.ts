/**
 * RUFU-334 — manual automation runs get their working directory from the store, never from the server.
 *
 * Both manual lanes in `automation-step-execution.ts` used to run wherever the dashboard process happened
 * to have started: the command step spawned `/bin/sh` with no `cwd` at all, and the AI-prompt step passed
 * `cwd: process.cwd()` straight into `createFnAgent`. On the incident host that launch directory was the
 * production deployment checkout, and an operator-authored automation is write-capable, so both lanes now
 * resolve the project root from the task store the route already holds and refuse a run with no root.
 *
 * FNXC:AgentWorkingDirectoryPolicy 2026-10-18-13:15 (RUFU-334):
 * `exec` is mocked so the assertion reads the exact options the child would have received; the AI-prompt
 * stub records the cwd handed to `createFnAgent` and then raises a sentinel, because the subject here is
 * which directory the session is asked to start in, not the rest of the prompt leg (covered elsewhere).
 * The protected-checkout case drives the stub through the real core policy: a session-start failure
 * already propagates out of `executeScheduleSteps` to the run route's handler, and the point asserted here
 * is that this lane neither swallows that refusal nor retries it from some other directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, TaskStore } from "@fusion/core";
import { assertAgentCwdAllowed, ProtectedCheckoutError } from "@fusion/core";
import { executeScheduleSteps, executeSingleCommand } from "../routes/automation-step-execution.js";

interface ExecCall {
  command: string;
  options: Record<string, unknown>;
}

const execCalls: ExecCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: (command: string, options: Record<string, unknown>, callback: (err: null | Error, out: { stdout: string; stderr: string }) => void) => {
      execCalls.push({ command, options });
      // A missing cwd is the defect; surface it exactly as the real spawn would (ENOENT).
      if (typeof options.cwd !== "string" || !options.cwd.trim()) {
        const err = Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" });
        callback(err, { stdout: "", stderr: "" });
        return;
      }
      callback(null, { stdout: "ok", stderr: "" });
    },
  };
});

const tempDirs: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStore(rootDir: string | undefined): TaskStore {
  return {
    getRootDir: () => rootDir,
    getSettings: async () => ({}),
  } as unknown as TaskStore;
}

function makeSchedule(step: Record<string, unknown>): ScheduledTask {
  return {
    id: "sched-1",
    name: "manual run",
    enabled: true,
    cron: "0 * * * *",
    steps: [step],
  } as unknown as ScheduledTask;
}

const SENTINEL = "automation-cwd-test-stops-after-cwd";

interface AgentCall {
  cwd: unknown;
}

function makeAgentStub(onCall?: (call: AgentCall) => void) {
  const calls: AgentCall[] = [];
  const stub = vi.fn(async (options: AgentCall) => {
    calls.push(options);
    onCall?.(options);
    throw new Error(SENTINEL);
  });
  return { stub, calls };
}

describe("automation manual lanes — working directory contract", () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env.FUSION_PROTECTED_CHECKOUTS;
    execCalls.length = 0;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.FUSION_PROTECTED_CHECKOUTS;
    else process.env.FUSION_PROTECTED_CHECKOUTS = prior;
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("command step", () => {
    it("executes in the store's project root", async () => {
      const root = tempRoot("fusion-automation-cmd-");
      const result = await executeSingleCommand("echo ok", 5_000, new Date().toISOString(), makeStore(root));

      expect(result.success).toBe(true);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0].options.cwd).toBe(root);
      expect(execCalls[0].options.cwd).not.toBe(process.cwd());
    });

    it.each([
      ["absent", undefined],
      ["blank", "   "],
    ])("refuses a %s project root without executing anything", async (_label, rootDir) => {
      const result = await executeSingleCommand("echo ok", 5_000, "2026-10-18T13:00:00.000Z", makeStore(rootDir));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^AUTOMATION_MISSING_WORKING_DIRECTORY/);
      expect(result.startedAt).toBe("2026-10-18T13:00:00.000Z");
      expect(execCalls).toEqual([]);
    });
  });

  describe("ai-prompt step", () => {
    it("hands createFnAgent the store's project root", async () => {
      const root = tempRoot("fusion-automation-ai-");
      const { stub, calls } = makeAgentStub();

      // A session-start failure propagates out of the step executor and the run route reports it; this
      // leg stops at the sentinel so only the cwd argument is under test.
      await expect(
        executeScheduleSteps(
          makeSchedule({ id: "s1", name: "prompt", type: "ai-prompt", prompt: "summarise the repo" }),
          new Date().toISOString(),
          makeStore(root),
          undefined,
          () => stub as unknown as typeof import("@fusion/engine").createFnAgent,
        ),
      ).rejects.toThrow(SENTINEL);

      expect(calls).toHaveLength(1);
      expect(calls[0].cwd).toBe(root);
      expect(calls[0].cwd).not.toBe(process.cwd());
    });

    it("refuses a blank project root before creating any agent session", async () => {
      const { stub, calls } = makeAgentStub();

      const result = await executeScheduleSteps(
        makeSchedule({ id: "s1", name: "prompt", type: "ai-prompt", prompt: "summarise the repo" }),
        "2026-10-18T13:00:00.000Z",
        makeStore("   "),
        undefined,
        () => stub as unknown as typeof import("@fusion/engine").createFnAgent,
      );

      expect(calls).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.stepResults?.[0]?.error).toMatch(/^AUTOMATION_MISSING_WORKING_DIRECTORY/);
      expect(result.startedAt).toBe("2026-10-18T13:00:00.000Z");
    });

    it("propagates the protected-checkout refusal instead of relocating the session", async () => {
      const protectedRoot = tempRoot("fusion-automation-protected-");
      process.env.FUSION_PROTECTED_CHECKOUTS = protectedRoot;
      const { stub, calls } = makeAgentStub((call) => {
        // The real policy `createFnAgent` applies to its cwd argument.
        assertAgentCwdAllowed(call.cwd as string, { lane: "automation" });
      });

      const err = await executeScheduleSteps(
        makeSchedule({ id: "s1", name: "prompt", type: "ai-prompt", prompt: "summarise the repo" }),
        new Date().toISOString(),
        makeStore(protectedRoot),
        undefined,
        () => stub as unknown as typeof import("@fusion/engine").createFnAgent,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProtectedCheckoutError);
      expect((err as Error).message).toContain("FUSION_PROTECTED_CHECKOUTS");
      expect((err as Error).message).toContain(protectedRoot);
      // No relocation: the refused lane never asked for a second session in some other directory.
      expect(calls).toHaveLength(1);
      expect(calls[0].cwd).toBe(protectedRoot);
    });
  });
});
