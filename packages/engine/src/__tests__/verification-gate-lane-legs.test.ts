/*
FNXC:LaneLegGate 2026-11-11-23:35 (RUFU-425, W1+W2 through the graph):
This file exists because of a lesson this repository already paid for: FN-3345 recorded that every
assertion in `review-gated-verification-gate.test.ts` called the gate function DIRECTLY, so the whole
set stayed green while the graph never reached the gate at all — verification completed in ~46ms and
recorded a PASS without running anything. Testing a function proves the function; it does not prove
the graph calls it.

So both cases here travel the real chain a card travels: `GateNodeRunner` → the `workflowAction`
custom-node shape → `runDeterministicVerificationGate` → the real
`runExecutorDeterministicVerification` primitive. Nothing in the middle is stubbed.

The proof that nothing executed is physical rather than a mock count: the configured test command
WRITES A FILE, so a green-looking refusal that had secretly run the command would leave the file
behind, and a gate that refused too eagerly would fail to produce it in the mirror case.
*/
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Settings, Task, TaskStore, WorkflowIrNode } from "@fusion/core";
import { GateNodeRunner } from "../workflow-node-runners/gate-runner.js";
import { runDeterministicVerificationGate } from "../workflow-node-runners/verification-gate.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

const node: WorkflowIrNode = {
  id: "verification-step",
  kind: "gate",
  column: "in-review",
  config: { workflowAction: "deterministic-verification" },
};

/** The command writes its own execution certificate into the lane; absence is therefore evidence. */
const SENTINEL = "verification-ran.txt";
const settings = { testCommand: `node -e "require('fs').writeFileSync('${SENTINEL}','ran')"` } as unknown as Settings;

async function scratch(tag: string): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `rufu-425-gate-${tag}-`)));
  tempRoots.push(base);
  return base;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

function boardCapture() {
  const history: string[] = [];
  const store = {
    logEntry: async (_id: string, action: string): Promise<unknown> => {
      history.push(action);
      return undefined;
    },
    recordRunAuditEvent: async (): Promise<unknown> => undefined,
    appendAgentLog: async (): Promise<unknown> => undefined,
  };
  return { store: store as unknown as TaskStore, history };
}

/** A lane whose declared member leg is an empty directory — the measured origin shape. */
async function laneWithEmptyLeg(tag: string): Promise<{ lane: string; legPath: string }> {
  const lane = await scratch(tag);
  const legPath = path.join(lane, "member");
  await mkdir(legPath, { recursive: true });
  return { lane, legPath };
}

/** The mirror: a member leg that IS its own repository, so the gate has no reason to refuse. */
async function laneWithMaterializedLeg(tag: string): Promise<{ lane: string; legPath: string }> {
  const lane = await scratch(tag);
  const legPath = path.join(lane, "member");
  await mkdir(legPath, { recursive: true });
  await git(["init", "-q", "-b", "main", legPath], lane);
  await git(["-C", legPath, "config", "user.email", "leg@example.com"], lane);
  await git(["-C", legPath, "config", "user.name", "Leg Fixture"], lane);
  // An empty directory is not content, so the leg needs a tracked file before it has a commit.
  await writeFile(path.join(legPath, "note.txt"), "materialized\n", "utf-8");
  await git(["-C", legPath, "add", "-A"], lane);
  await git(["-C", legPath, "commit", "-q", "-m", "chore: materialized leg"], lane);
  return { lane, legPath };
}

function card(lane: string, legPath: string): Task {
  return {
    id: "RUFU-425",
    worktree: lane,
    workspaceWorktrees: { member: { worktreePath: legPath, branch: "fusion/rufu-425" } },
  } as unknown as Task;
}

/**
 * The production chain, minus only what a unit test cannot own: the graph executor that supplies
 * settings and the worktree path. Everything from the gate node downward is the shipped code.
 */
function gateNodeRunner(lane: string, store: TaskStore) {
  const runCustomNode = async (runNode: WorkflowIrNode, task: Task) =>
    runDeterministicVerificationGate({ store, getRunContextFor: () => undefined }, runNode, task, settings, lane);
  return new GateNodeRunner(runCustomNode as never);
}

async function sentinel(lane: string): Promise<boolean> {
  try {
    await realpath(path.join(lane, SENTINEL));
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Verification gate through GateNodeRunner - an empty leg refuses the whole measurement", () => {
  it("reports an infrastructure failure, ran no command, and wrote exactly one card line", async () => {
    const { lane, legPath } = await laneWithEmptyLeg("refusal");
    const board = boardCapture();

    const outcome = await gateNodeRunner(lane, board.store).run(node, {
      task: card(lane, legPath),
      context: {},
      signal: undefined,
    } as never);

    expect(outcome).toMatchObject({
      outcome: "failure",
      value: "verification-infrastructure-failure",
      contextPatch: {
        verificationFailure: { commandLabel: "lane-legs", reason: "lane-legs-not-materialized" },
      },
    });
    // The physical proof: the configured command writes this file when it runs. It did not run.
    expect(await sentinel(lane)).toBe(false);
    // A refusal the operator can read, and only one of them — the primitive owns the sentence.
    expect(board.history).toHaveLength(1);
    expect(board.history[0]).toContain("lane-leg-empty");
    expect(board.history[0]).toContain(legPath);
    expect(String((outcome.contextPatch as Record<string, unknown>).output)).toContain("empty");
  }, 90_000);

  it("does not report the refusal as a passed or not-configured gate", async () => {
    const { lane, legPath } = await laneWithEmptyLeg("no-false-green");
    const board = boardCapture();

    const outcome = await gateNodeRunner(lane, board.store).run(node, {
      task: card(lane, legPath),
      context: {},
      signal: undefined,
    } as never);

    // `not-configured` is a tolerated skip on the merge door; a refusal may never borrow that shape.
    expect(outcome.value).not.toBe("not-configured");
    expect(outcome.value).not.toBe("passed");
    expect(outcome.contextPatch).not.toHaveProperty("notRunReason");
    expect(await sentinel(lane)).toBe(false);
  }, 90_000);
});

describe("Verification gate through GateNodeRunner - the mirror case still verifies", () => {
  it("a materialized leg runs the configured command and reports the ordinary result", async () => {
    const { lane, legPath } = await laneWithMaterializedLeg("mirror");
    const board = boardCapture();

    const outcome = await gateNodeRunner(lane, board.store).run(node, {
      task: card(lane, legPath),
      context: {},
      signal: undefined,
    } as never);

    expect(outcome).toMatchObject({ outcome: "success", value: "passed" });
    // The guard is a gate, not a wall: with a real leg the command really executes.
    expect(await sentinel(lane)).toBe(true);
    expect(board.history.some((line) => line.includes("lane-leg"))).toBe(false);
  }, 90_000);
});
