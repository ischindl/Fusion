/*
FNXC:LaneLegGate 2026-11-11-23:25 (RUFU-425, W1/W2/W5):
What the two verification consumers must do with a refusal, and what one refusal must leave behind.

The failure being prevented is specific: `allPassed: false` already has exactly one meaning in this
codebase — a command ran and returned non-zero — and every consumer reacts by dispatching remediation.
A leg that could not be measured at all therefore needs its own field and its own route, or a fix agent
is pointed at a test that never executed while the real problem (a member directory that is empty)
stays untouched.

The audit half is the FN-9175 contract: the refusal is the lifecycle decision, so a board write that
throws, rejects, stalls, or settles late may annotate it and may never become it.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExecutorDeterministicVerification } from "../../executor/deterministic-verification.js";
import { runDeterministicVerificationGate } from "../../workflow-node-runners/verification-gate.js";
import { recordLaneLegRefusal, type LaneLegRefusalNotice } from "../lane-leg-refusal.js";

const tempRoots: string[] = [];

async function scratch(tag: string): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `rufu-425-${tag}-`)));
  tempRoots.push(base);
  return base;
}

function boardCapture() {
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
    // The command lane writes an agent-log line of its own; the capture is a board double, not a mock.
    appendAgentLog: async (): Promise<unknown> => undefined,
    getRunContextFor: () => undefined,
  };
  return { store: store as never, history, audit };
}

const settings = { testCommand: "node -e 'process.exit(3)'" } as never;

/** A workspace card whose only leg is an empty directory — the reported shape, minimally. */
async function cardWithEmptyLeg(tag: string) {
  const base = await scratch(tag);
  const legPath = path.join(base, "member");
  await mkdir(legPath, { recursive: true });
  return {
    task: { id: "RUFU-425", workspaceWorktrees: { member: { worktreePath: legPath, branch: "fusion/rufu-425" } } } as never,
    worktreePath: base,
    legPath,
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("deterministic verification - the refusal is not a red command", () => {
  it("refuses before executing the configured command", async () => {
    const { task, worktreePath } = await cardWithEmptyLeg("w1-nocmd");
    const board = boardCapture();

    const result = await runExecutorDeterministicVerification(
      { store: board.store, getRunContextFor: () => undefined },
      task,
      worktreePath,
      settings,
    );

    expect(result.allPassed).toBe(false);
    expect(result.laneLegRefusal?.code).toBe("lane-leg-empty");
    // If the command had run, its exit code would be recorded here. Its absence is the proof.
    expect(result.testResult).toBeUndefined();
    expect(result.failedCommand).toBeUndefined();
    expect(board.history).toHaveLength(1);
    expect(board.history[0]).toContain("lane-leg-empty");
  }, 60_000);

  it("a singular card with no legs runs the command and adds no keys to the result", async () => {
    const board = boardCapture();
    const worktreePath = await scratch("w3-singular");
    const result = await runExecutorDeterministicVerification(
      { store: board.store, getRunContextFor: () => undefined },
      { id: "RUFU-425", worktree: worktreePath } as never,
      worktreePath,
      settings,
    );

    expect(result.laneLegRefusal).toBeUndefined();
    expect(result.testResult?.exitCode).toBe(3);
    expect(Object.keys(result).sort()).toEqual(["allPassed", "failedCommand", "testResult"]);
  }, 60_000);

  it("no configured command still returns the exact not-run shape with nothing added", async () => {
    const { task, worktreePath } = await cardWithEmptyLeg("w1-notconfigured");
    const board = boardCapture();

    const result = await runExecutorDeterministicVerification(
      { store: board.store, getRunContextFor: () => undefined },
      task,
      worktreePath,
      {} as never,
    );

    expect(result).toEqual({ allPassed: true, notRun: true });
    expect(board.history).toEqual([]);
  }, 60_000);
});

describe("verification gate node - a refusal routes with the infrastructure failure", () => {
  const refusal: LaneLegRefusalNotice = {
    code: "lane-leg-empty",
    repository: "member",
    path: "/lanes/rufu-425/member",
    legs: [{ repository: "member", classification: "empty-directory", entryCount: 0, toplevel: null, head: null, lag: null }],
  };

  it("never labels the refusal a failed command", async () => {
    const gate = await runDeterministicVerificationGate(
      {
        store: { logEntry: async () => undefined } as never,
        runVerification: async () => ({ allPassed: false, laneLegRefusal: refusal }),
      },
      { id: "verification" } as never,
      { id: "RUFU-425" } as never,
      settings,
      "/worktree",
    );

    expect(gate.outcome).toBe("failure");
    expect(gate.value).toBe("verification-infrastructure-failure");
    expect(gate.contextPatch.verificationFailure).toEqual({
      commandLabel: "lane-legs",
      reason: "lane-legs-not-materialized",
    });
    expect(String(gate.contextPatch.output)).toContain("member");
  });

  it("a red command keeps its existing shape, untouched by the new branch", async () => {
    const gate = await runDeterministicVerificationGate(
      {
        store: { logEntry: async () => undefined } as never,
        runVerification: async () => ({
          allPassed: false,
          failedCommand: "testCommand" as const,
          testResult: { command: "pnpm test", exitCode: 1, stdout: "", stderr: "1 failed", success: false },
        }),
      },
      { id: "verification" } as never,
      { id: "RUFU-425" } as never,
      settings,
      "/worktree",
    );

    expect(gate.value).toBe("failed");
    expect(gate.contextPatch.verificationFailure).toEqual({ commandLabel: "testCommand" });
  });
});

/*
FNXC:RunAudit 2026-11-11-23:25 (RUFU-425, FN-9175 continuity):
The recorder is a new engine emit site, so it carries the same behavioral obligation as every other:
an absent, throwing, rejecting, stalling, or late-settling sink must not change the refusal it is
describing. Asserted through the seam, never by inspecting imports.
*/
describe("lane-leg refusal recorder - hostile sinks", () => {
  type SinkMode = "absent" | "throw" | "reject" | "pending" | "late-resolve" | "late-reject";

  function sinkFor(mode: SinkMode) {
    if (mode === "absent") return undefined;
    if (mode === "throw") return () => { throw new Error("sink down"); };
    if (mode === "reject") return () => Promise.reject(new Error("sink down"));
    if (mode === "pending") return () => new Promise(() => undefined);
    if (mode === "late-resolve") return () => new Promise((resolve) => setTimeout(resolve, 5).unref?.());
    return () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 5).unref?.());
  }

  const notice: LaneLegRefusalNotice = {
    code: "lane-leg-borrowed-toplevel",
    repository: "member",
    path: "/lanes/rufu-425/member",
    legs: [{ repository: "member", classification: "borrowed-toplevel", entryCount: 4, toplevel: "/lanes/rufu-425", head: null, lag: null }],
  };

  for (const mode of ["absent", "throw", "reject", "pending", "late-resolve", "late-reject"] as const) {
    it(`records History and resolves with a ${mode} audit sink`, async () => {
      const history: string[] = [];
      const store = {
        logEntry: async (_id: string, action: string) => { history.push(action); return undefined; },
        recordRunAuditEvent: sinkFor(mode),
      };

      await expect(recordLaneLegRefusal(store as never, "RUFU-425", notice, "deterministic-verification")).resolves.toBeUndefined();

      expect(history).toHaveLength(1);
      expect(history[0]).toContain("lane-leg-borrowed-toplevel");
      expect(history[0]).toContain("/lanes/rufu-425/member");
    });
  }

  it("a History write that throws still cannot break the refusal", async () => {
    const store = {
      logEntry: async () => { throw new Error("board unavailable"); },
      recordRunAuditEvent: async () => undefined,
    };

    await expect(recordLaneLegRefusal(store as never, "RUFU-425", notice, "checkout-emptiness")).resolves.toBeUndefined();
  });

  it("keeps filesystem paths out of the audit row while naming them on the card", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const store = {
      logEntry: async () => undefined,
      recordRunAuditEvent: async (input: Record<string, unknown>) => { audit.push(input); return undefined; },
    };

    await recordLaneLegRefusal(store as never, "RUFU-425", notice, "checkout-emptiness");
    await vi.waitFor(() => expect(audit).toHaveLength(1));

    const row = audit[0]!;
    expect(row).toMatchObject({
      domain: "git",
      mutationType: "worktree:lane-leg-refusal",
      target: "member",
      taskId: "RUFU-425",
    });
    expect(JSON.stringify(row)).not.toContain("/lanes/");
    expect(row.metadata).toEqual({
      taskId: "RUFU-425",
      source: "checkout-emptiness",
      code: "lane-leg-borrowed-toplevel",
      repository: "member",
      legCount: 1,
      entryCount: 4,
    });
  });
});

describe("lane-leg refusal recorder - sentence content", () => {
  it("tells the operator what was not measured and that no verdict exists", async () => {
    const history: string[] = [];
    const store = { logEntry: async (_id: string, action: string) => { history.push(action); return undefined; } };
    await recordLaneLegRefusal(store as never, "RUFU-425", {
      code: "lane-leg-unmeasurable",
      repository: "third-member",
      path: "/lanes/rufu-425/third-member",
      legs: [{ repository: "third-member", classification: "unmeasurable", entryCount: null, toplevel: null, head: null, lag: null }],
    }, "deterministic-verification");

    expect(history[0]).toContain("could not be read as a checkout");
    expect(history[0]).toContain("unreadable");
    expect(history[0]).toContain("produced no verdict");
  });
});
