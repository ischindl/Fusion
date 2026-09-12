import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

/*
FNXC:NonInteractiveGit 2026-09-12-12:39 (RUFU-216):
`process-manager.ts` now imports `@fusion/core` for the shared non-interactive git floor, and that
barrel `promisify(execFile)`s at module init (`packages/core/src/git/git-repository.ts`). A whole-module
replacement that exports only `spawn` therefore throws while the module graph is still loading, so only
`spawn` is swapped and the real module supplies the rest — the same constraint RUFU-210 recorded for the
hermes lane. Deliberately NOT mocking `@fusion/core`: the test must exercise the production floor, not a fake.
*/
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { buildDroidSpawnArgs, spawnDroid } from "../process-manager.js";

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 123;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe("Droid agent spawn invariants", () => {
  // FNXC:NonInteractiveGit 2026-09-12-12:39 (RUFU-216): the git-floor tests set hostile ambient GIT_*
  // values, so the whole env is snapshotted and restored to keep them from leaking into sibling cases.
  const origEnv = { ...process.env };

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
  });

  it("builds a non-interactive print-mode stream-json invocation", () => {
    const args = buildDroidSpawnArgs("droid-pro", undefined, {
      effort: "high",
      mcpConfigPath: "/tmp/mcp.json",
      newSessionId: "session-1",
    });

    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "droid-pro",
      "--session-id",
      "session-1",
      "--effort",
      "high",
      "--mcp-config",
      "/tmp/mcp.json",
    ]));
    expect(args).not.toContain("models");
    expect(args).not.toContain("model");
  });

  it("spawns droid with piped stdio and never inherits a TTY", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);

    expect(spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" })).toBe(proc);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // FNXC:NonInteractiveGit 2026-09-12-12:39 (RUFU-216): widened to carry `env` — this package's build is
    // tsc over all of src, so the test file's option shape is type-checked by the build too.
    const [binary, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[]; cwd: string; env: NodeJS.ProcessEnv }];
    expect(binary).toBe("droid");
    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.stdio).not.toBe("inherit");
    expect(options.stdio).not.toContain("inherit");
  });

  /*
  FNXC:NonInteractiveGit 2026-09-12-12:39 (RUFU-216):
  The droid child previously inherited `process.env` verbatim, so a host with `GIT_EDITOR=vi` handed the
  CLI an editor it could never open — the measured immortal-orphan hang class from RUFU-210's incident.
  This asserts the invariant, not just the reported repro: every floor key is pinned, a hostile ambient
  value may not win, and the hardening may not mutate the caller's env or drop unrelated keys.
  */
  it("applies the non-interactive git floor to the droid session spawn", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" });

    const { env } = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
  });

  it("overrides a hostile ambient git editor, pager, and credential prompt instead of inheriting them", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);
    // The exact ambient state from the production incident: an interactive editor and a blocking pager.
    process.env.GIT_EDITOR = "vi";
    process.env.GIT_SEQUENCE_EDITOR = "humpty";
    process.env.GIT_PAGER = "less";
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GIT_MERGE_AUTOEDIT = "yes";

    spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" });

    const { env } = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
    // Design decision 1: hardening is scoped per spawn, never ambient — the operator's own terminal
    // still resolves a real editor, so process.env must come back untouched.
    expect(process.env.GIT_EDITOR).toBe("vi");
    expect(process.env.GIT_PAGER).toBe("less");
  });

  it("keeps the rest of the ambient env flowing to the droid child", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);
    process.env.DROID_LANE_PROBE = "carried-through";

    spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" });

    // The floor is additive: replacing the child env wholesale would strip PATH and break lookup.
    const { env } = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(env.DROID_LANE_PROBE).toBe("carried-through");
    expect(env.PATH).toBe(process.env.PATH);
  });
});
