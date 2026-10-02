/*
FNXC:KnowledgeGraph 2026-10-02-14:05 (RUFU-500):
An in-process graph build was measured at 84.8% of the dashboard process for minutes, so the build now runs
in a forked child. These tests pin the two properties that make the offload safe rather than merely faster:
a child that CANNOT run falls back to a real build, and a child that BUILT and failed must not be mistaken
for one — otherwise a broken repository would silently rebuild in-process and mask the failure.
*/
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  KnowledgeGraphBuildOffloadUnavailableError,
  resolveKnowledgeGraphWorkerPath,
  runKnowledgeGraphBuild,
} from "../build-offloader.js";

class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  killed: string[] = [];
  send(message: unknown): void {
    this.sent.push(message);
  }
  kill(signal?: string): void {
    this.killed.push(String(signal));
    this.emit("exit", null, signal ?? "SIGTERM");
  }
}

function harness(child: FakeChild) {
  const spawnFn = vi.fn(() => child as never) as unknown as typeof import("node:child_process").fork;
  return { spawnFn, calls: () => spawnFn.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]> };
}

const REQUEST = { projectRoot: "/repo", graphDir: "/repo/.fusion/knowledge-graph", force: false };

/*
 * The offloader refuses a `.ts` sibling by design, so a suite that wants to exercise the child protocol has to
 * name a compiled worker and say it exists. Without these two seams every test below would silently take the
 * in-process fallback and assert nothing about the fork.
 */
const OFFLOAD_SEAMS = {
  workerPath: "/repo/packages/cli/dist/knowledge-graph-worker.js",
  canUseWorker: () => true,
};

describe("runKnowledgeGraphBuild", () => {
  it("returns the child's summary and asks it for exactly the requested build", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = harness(child);
    const pending = runKnowledgeGraphBuild({ ...REQUEST, ...OFFLOAD_SEAMS, spawnFn });
    await Promise.resolve();
    child.emit("message", { kind: "result", changed: true, nodes: 12, edges: 30, stats: { parsedFiles: 7 } });

    await expect(pending).resolves.toMatchObject({ changed: true, nodes: 12, edges: 30 });
    const [path, , options] = calls()[0];
    expect(path).toMatch(/knowledge-graph-worker\.js$|build-worker\.ts$/);
    expect(child.sent).toEqual([{ kind: "build", ...REQUEST }]);
    expect(options.execArgv).toEqual(["--max-old-space-size=4096"]);
  });

  it("gives the child its own smaller heap instead of inheriting the server's", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = harness(child);
    const pending = runKnowledgeGraphBuild({ ...REQUEST, ...OFFLOAD_SEAMS, spawnFn });
    await Promise.resolve();
    child.emit("message", { kind: "result", changed: false, nodes: 1, edges: 0, stats: {} });
    await pending;
    const execArgv = calls()[0][2].execArgv as string[];
    // The parent is launched with --max-old-space-size=16384; the build child must not inherit that ceiling.
    expect(execArgv.join(" ")).not.toContain("16384");
    expect(execArgv.length).toBe(1);
  });

  it("propagates a build failure as a plain error, never as 'offload unavailable'", async () => {
    const child = new FakeChild();
    const { spawnFn } = harness(child);
    const pending = runKnowledgeGraphBuild({ ...REQUEST, ...OFFLOAD_SEAMS, spawnFn });
    await Promise.resolve();
    child.emit("message", { kind: "error", message: "graph manifest is inconsistent" });

    // A caller distinguishes these two classes: `Unavailable` falls back to an in-process build, a real
    // build error must surface, or a broken repository would be papered over by running the same build twice.
    await expect(pending).rejects.toThrow(/graph manifest is inconsistent/);
    await pending.catch((error: unknown) => {
      expect(error).not.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);
    });
  });

  it("reports the child as unavailable when it dies before answering", async () => {
    const child = new FakeChild();
    const { spawnFn } = harness(child);
    const pending = runKnowledgeGraphBuild({ ...REQUEST, ...OFFLOAD_SEAMS, spawnFn });
    await Promise.resolve();
    child.emit("exit", 1, null);
    await expect(pending).rejects.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);
  });

  it("terminates a build that outlives its budget instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const { spawnFn } = harness(child);
      const pending = runKnowledgeGraphBuild({ ...REQUEST, ...OFFLOAD_SEAMS, spawnFn, timeoutMs: 5_000 });
      await Promise.resolve();
      vi.advanceTimersByTime(5_001);
      await expect(pending).rejects.toThrow(/exceeded 5000ms/);
      expect(child.killed).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a source worker as .ts, which is how tests and dev checkouts take the in-process fallback", () => {
    // Nothing is spawned from a source tree: `runKnowledgeGraphBuild` refuses a non-`.js` path so vitest and
    // `tsx` runs keep building in-process rather than forking an untranspiled file.
    const sourcePath = resolveKnowledgeGraphWorkerPath("file:///repo/packages/core/src/knowledge-graph/build-offloader.ts");
    expect(sourcePath.endsWith("build-worker.ts")).toBe(true);
  });
});

/*
FNXC:KnowledgeGraph 2026-10-02-15:20 (RUFU-500):
The shipped CLI is `packages/cli/bin.mjs` importing `dist/bin.js`, so the module directory that
`import.meta.url` reports inside the bundle is not guaranteed to be `dist`. With one candidate the worker was
declared unusable and the build went back in-process without a word.
*/
describe("findKnowledgeGraphWorkerPath", () => {
  it("finds the worker when the module url is the launcher rather than the dist bundle", async () => {
    const { findKnowledgeGraphWorkerPath } = await import("../build-offloader.js");
    const existing = new Set([
      "/pkg/packages/cli/dist/knowledge-graph-worker.js",
      "/cwd-noise/packages/cli/dist/knowledge-graph-worker.js",
    ]);
    const found = findKnowledgeGraphWorkerPath("file:///pkg/packages/cli/bin.mjs", (path) => existing.has(path));
    expect(found).toBe("/pkg/packages/cli/dist/knowledge-graph-worker.js");
  });

  it("prefers the true sibling over the launcher-relative fallbacks", async () => {
    const { findKnowledgeGraphWorkerPath } = await import("../build-offloader.js");
    const sibling = "/pkg/packages/cli/dist/knowledge-graph-worker.js";
    const found = findKnowledgeGraphWorkerPath("file:///pkg/packages/cli/dist/bin.js", (path) => path === sibling);
    expect(found).toBe(sibling);
  });

  it("reports no path when no candidate exists, so the caller refuses rather than forking a ghost", async () => {
    const { findKnowledgeGraphWorkerPath, resolveKnowledgeGraphWorkerPath } = await import("../build-offloader.js");
    expect(findKnowledgeGraphWorkerPath("file:///pkg/packages/cli/dist/bin.js", () => false)).toBeUndefined();
    // The plain resolver still names the conventional sibling, which is what the refusal message prints.
    expect(resolveKnowledgeGraphWorkerPath("file:///pkg/packages/cli/dist/bin.js")).toBe(siblingOfBin());
    function siblingOfBin() {
      return "/pkg/packages/cli/dist/knowledge-graph-worker.js";
    }
  });
});
