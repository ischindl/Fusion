import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:TaskDiffStats 2026-10-01-19:40:
`?stats=1` is the TaskCard badge poll, and the board fires it for every visible card at once, from every
open tab. The TTL cache made a REPEAT cheap but left CONCURRENCY unguarded: two identical in-flight polls
each paid the whole git lane. Measured on the deployed node for one card whose worktree is gone: 19.96 s
and 28.35 s back to back. The poll that exists to spare git was recreating the git herd, and the
single-process dashboard stalled behind it.

The invariant these tests hold: ONE key gets ONE git lane, and a joiner receives the same triple the
owner computed — never a second computation, never a fabricated value.
*/

const { runGitCommandMock } = vi.hoisted(() => ({ runGitCommandMock: vi.fn() }));
let gitDelayMs = 0;
let gitCallCount = 0;

vi.mock("../routes/resolve-diff-base.js", () => ({
  runGitCommand: runGitCommandMock,
  resolveDiffBase: vi.fn(async () => "resolved-base-sha"),
}));

import { registerSessionDiffRoutes } from "../routes/register-session-diff-routes.js";
import { __resetTaskDiffStatsCacheForTests, __taskDiffStatsInFlightCount } from "../routes/register-session-diff-routes.js";

function makeTask() {
  return {
    id: "RUFU-9001",
    column: "done",
    status: "done",
    title: "badge lane",
    worktree: null,
    branch: null,
    baseBranch: "main",
    mergeDetails: { commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  };
}

async function startServer(task = makeTask()) {
  const rootDir = mkdtempSync(join(tmpdir(), "fusion-diff-lane-"));
  const app = express();
  const router = express.Router();
  registerSessionDiffRoutes(router, {
    getProjectContext: async () => ({
      store: {
        getTask: async () => task,
        getRootDir: () => rootDir,
      },
    }),
  } as never);
  app.use("/api", router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("diff stats lane — one git lane per key", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeEach(() => {
    runGitCommandMock.mockReset();
    runGitCommandMock.mockImplementation(async () => {
      gitCallCount++;
      if (gitDelayMs) await new Promise((resolve) => setTimeout(resolve, gitDelayMs));
      return "";
    });
    gitCallCount = 0;
    gitDelayMs = 0;
    __resetTaskDiffStatsCacheForTests();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    __resetTaskDiffStatsCacheForTests();
  });

  it("answers concurrent identical polls from ONE computation", async () => {
    gitDelayMs = 60;
    server = await startServer();

    const sequential = await fetch(server.url("/api/tasks/RUFU-9001/diff?stats=1"));
    expect(sequential.status).toBe(200);
    const sequentialBody = await sequential.json();
    const callsForOneLane = gitCallCount;
    expect(callsForOneLane).toBeGreaterThan(0);

    // Same key, both arriving while the lane is still running: exactly one more lane, not two.
    gitCallCount = 0;
    __resetTaskDiffStatsCacheForTests();
    const [a, b] = await Promise.all([
      fetch(server.url("/api/tasks/RUFU-9001/diff?stats=1")).then((r) => r.json()),
      fetch(server.url("/api/tasks/RUFU-9001/diff?stats=1")).then((r) => r.json()),
    ]);

    expect(gitCallCount).toBeLessThanOrEqual(callsForOneLane);
    expect(a).toEqual(sequentialBody);
    expect(b).toEqual(a);
    expect(__taskDiffStatsInFlightCount()).toBe(0);
  });

  it("clears the flight when the lane fails so a later poll is not wedged", async () => {
    runGitCommandMock.mockImplementation(async () => {
      gitCallCount++;
      throw new Error("git exploded");
    });
    server = await startServer();

    const failing = await fetch(server.url("/api/tasks/RUFU-9001/diff?stats=1"));
    expect(failing.status).toBeLessThan(500);
    expect(__taskDiffStatsInFlightCount()).toBe(0);

    // A following poll is still served (degraded to zero counts) rather than hanging on a stale flight.
    gitCallCount = 0;
    runGitCommandMock.mockImplementation(async () => "");
    const followUp = await fetch(server.url("/api/tasks/RUFU-9001/diff?stats=1"));
    expect(followUp.status).toBe(200);
    expect(await followUp.json()).toEqual({ stats: { filesChanged: 0, additions: 0, deletions: 0 } });
  });
});
