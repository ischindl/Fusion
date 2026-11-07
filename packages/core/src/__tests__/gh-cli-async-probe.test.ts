import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:GhProbeShared 2026-11-07-11:46 (RUFU-871):
The usage route spawned `gh auth status` per poll; a production CPU profile measured `spawn @ (native)` at
59.9% of CPU and a 1 KB /api/health answer at 2.2 s, because spawn cost lands on the shared event loop.
The fix is one cached, single-flight probe. These tests pin the two properties that actually remove the
cost — one child for N concurrent polls, and zero children for a warm cache — because a "cache" that
still spawns per poll would look identical in a latency sample taken between recycles.
*/

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.fn(
  (_file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    calls += 1;
    cb(null, "github.com\nLogged in to github.com account tester\n", "");
  },
);
let calls = 0;

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...(args as [string, string[], unknown, ExecCb])),
  execFileSync: vi.fn(() => "Logged in to github.com account tester"),
}));

async function load() {
  vi.resetModules();
  calls = 0;
  return await import("../cli/gh-cli.js");
}

beforeEach(() => {
  execFileMock.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("shared async gh probes (RUFU-871)", () => {
  it("starts ONE child for twenty concurrent polls", async () => {
    const { isGhAuthenticatedAsync } = await load();

    const results = await Promise.all(Array.from({ length: 20 }, () => isGhAuthenticatedAsync()));

    expect(calls).toBe(1);
    expect(results.every((r) => r === true)).toBe(true);
  });

  it("spawns NOTHING on a warm cache, which is the whole point of the cache", async () => {
    const { isGhAuthenticatedAsync } = await load();

    await isGhAuthenticatedAsync();
    expect(calls).toBe(1);

    await isGhAuthenticatedAsync();
    await isGhAuthenticatedAsync();
    expect(calls).toBe(1);
  });

  it("honours the existing stdout-content verdict, not just the exit code", async () => {
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      calls += 1;
      cb(null, "github.com\nNot logged in\n", "");
    });
    const { isGhAuthenticatedAsync } = await load();

    expect(await isGhAuthenticatedAsync()).toBe(false);
  });

  it("caches a negative verdict too, so a machine without gh stops spawning", async () => {
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      calls += 1;
      cb(new Error("spawn gh ENOENT"), "", "");
    });
    const { isGhAuthenticatedAsync } = await load();

    expect(await isGhAuthenticatedAsync()).toBe(false);
    const afterFirst = calls;
    expect(await isGhAuthenticatedAsync()).toBe(false);
    expect(calls).toBe(afterFirst);
  });

  it("re-probes after an explicit reset, which is what login/logout must do", async () => {
    const { isGhAuthenticatedAsync, resetGhAvailabilityCache } = await load();

    await isGhAuthenticatedAsync();
    resetGhAvailabilityCache();
    await isGhAuthenticatedAsync();

    expect(calls).toBe(2);
  });

  it("does not share its in-flight promise between the two different questions", async () => {
    const { isGhAvailableAsync, isGhAuthenticatedAsync } = await load();

    await Promise.all([isGhAvailableAsync(), isGhAuthenticatedAsync()]);

    expect(calls).toBe(2);
  });

  it("fills the SAME cache the sync readers use, so one probe answers both", async () => {
    const { isGhAuthenticatedAsync, isGhAuthenticated } = await load();

    await isGhAuthenticatedAsync();
    const before = calls;
    expect(isGhAuthenticated()).toBe(true);
    expect(calls).toBe(before);
  });
});
