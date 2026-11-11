/*
FNXC:KnowledgeGraph 2026-10-02-14:05 (RUFU-500):
An in-process graph build was measured at 84.8% of the dashboard process for minutes, so the build now runs
in a forked child. These tests pin the two properties that make the offload safe rather than merely faster:
a child that CANNOT run falls back to a real build, and a child that BUILT and failed must not be mistaken
for one — otherwise a broken repository would silently rebuild in-process and mask the failure.
*/
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeGraphBuildOffloadUnavailableError,
  resolveKnowledgeGraphWorkerPath,
  runKnowledgeGraphBuild,
  runKnowledgeGraphBuildInProcess,
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
FNXC:KnowledgeGraph 2026-11-11-18:53 (RUFU-500):
Two dashboard triggers used to be able to put TWO build children on the SAME graph directory: each child
carries its own heap ceiling, so the pair asked for twice the memory and twice the CPU of one build and then
raced to write one artifact triple. The lane map is what stops that, and its hazard is not the join -- it is a
lane that is never removed, which would make every later build for that directory resolve with a stale answer
and stop rebuilding the graph in silence. So the load-bearing assertions here are the CLEANUP ones: after a
success, a child death, and a SIGKILL timeout alike, the NEXT caller must spawn again.
*/
describe("single-flight per graph directory", () => {
  const CHILD = { kind: "result", changed: true, nodes: 7, edges: 9, stats: { parsedFiles: 3 } };
  let directory = 0;
  /** Distinct directories per test so one test's lane can never satisfy another test's caller. */
  const request = (over: Record<string, unknown> = {}) => ({ ...REQUEST, graphDir: `/repo/.fusion-knowledge/graph${directory++}`, ...over });

  function multiHarness(children: FakeChild[]) {
    let next = 0;
    const spawnFn = vi.fn(() => children[Math.min(next++, children.length - 1)] as never) as unknown as typeof import("node:child_process").fork;
    return { spawnFn, spawns: () => spawnFn.mock.calls.length };
  }

  it("runs one child for two simultaneous callers on the same directory and gives both the same result", async () => {
    const child = new FakeChild();
    const { spawnFn, spawns } = multiHarness([child]);
    const options = { ...request(), ...OFFLOAD_SEAMS, spawnFn };
    // Same tick, which is exactly how the panel and the memory-consolidation tick collide.
    const first = runKnowledgeGraphBuild(options);
    const second = runKnowledgeGraphBuild(options);
    await Promise.resolve();
    expect(spawns()).toBe(1);
    expect(child.sent).toHaveLength(1);
    child.emit("message", CHILD);

    const [a, b] = await Promise.all([first, second]);
    // One build, one answer: a joiner must not receive a second, divergent summary.
    expect(a).toBe(b);
    expect(a).toMatchObject({ nodes: 7, edges: 9 });
  });

  it("spawns a fresh child for a later build once the previous one has settled", async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn, spawns } = multiHarness(children);
    const options = { ...request(), ...OFFLOAD_SEAMS, spawnFn };
    const first = runKnowledgeGraphBuild(options);
    await Promise.resolve();
    children[0]!.emit("message", CHILD);
    await first;

    const second = runKnowledgeGraphBuild(options);
    await Promise.resolve();
    expect(spawns()).toBe(2);
    children[1]!.emit("message", { ...CHILD, nodes: 8 });
    await expect(second).resolves.toMatchObject({ nodes: 8 });
  });

  it("clears the lane when the child dies before answering, so the graph is not lost for the session", async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn, spawns } = multiHarness(children);
    const options = { ...request(), ...OFFLOAD_SEAMS, spawnFn };
    const first = runKnowledgeGraphBuild(options);
    await Promise.resolve();
    children[0]!.emit("exit", 1, null);
    await expect(first).rejects.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);

    const second = runKnowledgeGraphBuild(options);
    await Promise.resolve();
    expect(spawns()).toBe(2);
    children[1]!.emit("message", CHILD);
    await expect(second).resolves.toMatchObject({ nodes: 7 });
  });

  it("clears the lane when the build is killed for exceeding its budget", async () => {
    vi.useFakeTimers();
    try {
      const children = [new FakeChild(), new FakeChild()];
      const { spawnFn, spawns } = multiHarness(children);
      const options = { ...request(), ...OFFLOAD_SEAMS, spawnFn, timeoutMs: 5_000 };
      const first = runKnowledgeGraphBuild(options);
      await Promise.resolve();
      vi.advanceTimersByTime(5_001);
      await expect(first).rejects.toThrow(/exceeded 5000ms/);

      const second = runKnowledgeGraphBuild(options);
      await Promise.resolve();
      expect(spawns()).toBe(2);
      children[1]!.emit("message", CHILD);
      await expect(second).resolves.toMatchObject({ nodes: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an unforced in-flight build answer a forced request, and still never overlaps the two", async () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn, spawns } = multiHarness(children);
    const base = request();
    const unforced = runKnowledgeGraphBuild({ ...base, ...OFFLOAD_SEAMS, spawnFn, force: false });
    await Promise.resolve();
    const forced = runKnowledgeGraphBuild({ ...base, ...OFFLOAD_SEAMS, spawnFn, force: true });
    // While the first build runs, no second child may exist: two writers on one artifact triple is the race.
    expect(spawns()).toBe(1);
    children[0]!.emit("message", CHILD);
    await unforced;
    await Promise.resolve();
    expect(spawns()).toBe(2);
    expect(children[1]!.sent[0]).toMatchObject({ force: true });
    children[1]!.emit("message", { ...CHILD, nodes: 11 });
    await expect(forced).resolves.toMatchObject({ nodes: 11 });
  });

  it("single-flights the in-process lane too, so a host without a worker cannot double the burn either", async () => {
    const root = await mkdtemp(join(tmpdir(), "kg-lane-"));
    try {
      // The offload request carries no discovery override, so the fixture has to live at a real default
      // discovery root for the in-process build to find it.
      await mkdir(join(root, "packages/core/src"), { recursive: true });
      await writeFile(join(root, "packages/core/src/a.ts"), "export const a = 1;");
      const options = {
        projectRoot: root,
        graphDir: join(root, ".fusion-knowledge/graph"),
        force: false as const,
        allowChild: false as const,
      };
      const first = runKnowledgeGraphBuild(options);
      const second = runKnowledgeGraphBuild(options);
      const [a, b] = await Promise.all([first, second]);
      // Same object identity is the proof that only one real build ran for two callers.
      expect(a).toBe(b);
      expect(a.nodes).toBeGreaterThan(0);
      // And after settling, a genuine later build still runs (lane cleared, not cached forever).
      await writeFile(join(root, "packages/core/src/b.ts"), "export const b = 2;");
      const third = await runKnowledgeGraphBuild(options);
      expect(third).not.toBe(a);
      expect(third.changed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runKnowledgeGraphBuild degraded lanes", () => {
  const REQUEST_LANE = { projectRoot: "/repo", graphDir: "/repo/.fusion-knowledge/degraded", force: false };

  it("reports a spawn that throws synchronously as offload-unavailable", async () => {
    // `fork` can throw for a bad cwd or EAGAIN host; that is the in-process fallback class, not a build bug.
    const spawnFn = vi.fn(() => { throw new Error("EMFILE: too many open files"); }) as unknown as typeof import("node:child_process").fork;
    await expect(runKnowledgeGraphBuild({ ...REQUEST_LANE, ...OFFLOAD_SEAMS, spawnFn }))
      .rejects.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);
  });

  it("reports a child transport error as offload-unavailable rather than a build failure", async () => {
    const child = new FakeChild();
    const { spawnFn } = harness(child);
    const pending = runKnowledgeGraphBuild({ ...REQUEST_LANE, graphDir: "/repo/.fusion-knowledge/transport-error", ...OFFLOAD_SEAMS, spawnFn });
    await Promise.resolve();
    child.emit("error", new Error("EACCES: cannot execute worker"));
    await expect(pending).rejects.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);
  });

  it("names the unusable worker path when it refuses to spawn, so the fallback is audible in a log", async () => {
    const log = vi.fn();
    const workerPath = "/repo/packages/cli/dist/knowledge-graph-worker.ts";
    await expect(runKnowledgeGraphBuild({ ...REQUEST_LANE, workerPath, canUseWorker: () => false, log }))
      .rejects.toBeInstanceOf(KnowledgeGraphBuildOffloadUnavailableError);
    expect(log.mock.calls.map(call => String(call[0])).join("\n")).toContain(workerPath);
  });

  it("builds for real, in-process and without spawning, when the caller disallows a child", async () => {
    const root = await mkdtemp(join(tmpdir(), "kg-direct-"));
    try {
      await mkdir(join(root, "packages/core/src"), { recursive: true });
      await writeFile(join(root, "packages/core/src/a.ts"), "export const a = 1;");
      const spawnFn = vi.fn() as unknown as typeof import("node:child_process").fork;
      const summary = await runKnowledgeGraphBuild({
        projectRoot: root,
        graphDir: join(root, ".fusion-knowledge/graph"),
        allowChild: false,
        spawnFn,
      });
      // allowChild:false is the CLI / exotic-host path: it must produce a real artifact, not a stub.
      expect(spawnFn).not.toHaveBeenCalled();
      expect(summary.nodes).toBeGreaterThan(0);
      await expect(readFile(join(root, ".fusion-knowledge/graph/nodes.json"), "utf8")).resolves.toContain("packages/core/src/a.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

/*
FNXC:KnowledgeGraph 2026-11-11-20:12 (RUFU-500):
The in-process lane gained an optional build-tuning argument so the paired control in
`packages/dashboard/src/__tests__/knowledge-graph-loop-responsiveness.test.ts` can put a synchronous CPU
burn inside the very build it is measuring. These two tests hold the two halves of that design: the tuning
reaches `buildKnowledgeGraph`, and it is NOT part of the request that crosses to a child -- a function put
in an IPC payload would be silently dropped, and the child would then report a build that never used the
caller's own seam.
*/
describe("runKnowledgeGraphBuildInProcess build tuning", () => {
  async function srcFixture(): Promise<string> {
    // Deliberately a `src/`-only tree: the default discovery roots (`packages/*/src`, docs, scripts) find
    // nothing here, so a non-empty graph is proof that the supplied `discovery` actually reached the build.
    const root = await mkdtemp(join(tmpdir(), "kg-inproc-tune-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    return root;
  }

  it("applies the tuning to the build it runs in-process", async () => {
    const root = await srcFixture();
    try {
      const tuned = await runKnowledgeGraphBuildInProcess(
        { projectRoot: root, graphDir: join(root, ".fusion-knowledge/graph"), force: false },
        { discovery: { sourceRoots: ["src"], markdownRoots: [] } },
      );
      expect(tuned.nodes).toBeGreaterThan(0);
      expect(tuned.stats.readFiles).toBe(1);

      // Same tree, no tuning: the default roots discover nothing, so the difference is attributable.
      const untuned = await runKnowledgeGraphBuildInProcess(
        { projectRoot: root, graphDir: join(root, ".fusion-knowledge/untuned"), force: true },
      );
      expect(untuned.stats.discoveredFiles).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the request that crosses to a child serialisable", async () => {
    const child = new FakeChild();
    const { spawnFn } = harness(child);
    const pending = runKnowledgeGraphBuild({
      ...{ ...REQUEST, graphDir: "/repo/.fusion-knowledge/serialisable" },
      ...OFFLOAD_SEAMS,
      spawnFn,
    });
    await Promise.resolve();
    child.emit("message", { kind: "result", changed: false, nodes: 0, edges: 0, stats: {} });
    await pending;

    // The forked lane's payload is what `JSON.stringify` must survive; a function-shaped field would be
    // silently dropped in the child, so the tuning is proven absent from it rather than merely unused.
    const message = child.sent[0] as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(["force", "graphDir", "kind", "projectRoot"]);
    expect(() => JSON.stringify(message)).not.toThrow();
  });
});
