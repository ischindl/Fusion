import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:RuntimeProbeOneOwner 2026-11-18-10:50 (RUFU-479) — Invariant D, witnessed at the one owner.

`GET /api/auth/status` measured 9.39 s and 10.92 s on the deployed node for a 9 219 B body, and the cause was
shape, not per-probe speed: the endpoint awaits several CLI presence probes and each one forked a binary per
request, while the UI fires ~25 endpoints on first load. The memoization plus single-flight is landed and the
sync-probe call sites are ratcheted (`routes/__tests__/gh-probe-call-site-guard.test.ts`). What had NO witness
was the other half of the invariant — that the ONE invalidation owner actually reaches every cached answer.
`resetGhAvailabilityCache` was exported, documented as THE hook, and called by nothing in production, so a
Refresh that cleared five runtime probes kept serving a `gh` verdict up to 60 s old.

These cases therefore assert cost and invalidation together:
- N reads of one probe with an unchanged binary path fork ONCE (the plan's "N board loads, 1 probe");
- the one invalidation call re-probes WITHOUT waiting out any TTL (the Test/Refresh arm);
- that same call resets the `gh` cache, so the pair cannot drift apart;
- a different configured path misses by construction, which is why a save needs no cache clear.

Probes are counted by mocking the plugin packages that fork them — counting forks is the measurement, and
forking real CLIs to observe a count would make this a timing test.
*/

const cursorProbeCalls: string[] = [];

vi.mock("@fusion-plugin-examples/cursor-runtime", () => ({
  probeCursorBinary: vi.fn(async (opts?: { binaryPath?: string }) => {
    cursorProbeCalls.push(opts?.binaryPath ?? "<default>");
    return { available: true, binaryPath: opts?.binaryPath ?? "cursor", version: "1.2.3" };
  }),
  discoverCursorProviderModels: vi.fn(async () => ({ models: [], source: "test", fallbackUsed: false })),
  default: undefined,
}));

const ghReset = vi.fn();
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resetGhAvailabilityCache: () => ghReset(),
}));

import { invalidateRuntimeCliProbeCaches, probeCursorCliProvider } from "../runtime-provider-probes.js";

beforeEach(() => {
  cursorProbeCalls.length = 0;
  ghReset.mockClear();
  // Every case starts from a cold memo so "forked once" cannot be inherited from a previous case.
  invalidateRuntimeCliProbeCaches();
  cursorProbeCalls.length = 0;
  ghReset.mockClear();
});

describe("runtime CLI presence probe has one cached owner", () => {
  it("forks once for five reads of the same configured path, concurrent and sequential alike", async () => {
    const path = "cursor-rufu-479";
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () => probeCursorCliProvider({ binaryPath: path })),
    );
    const sequential = [
      await probeCursorCliProvider({ binaryPath: path }),
      await probeCursorCliProvider({ binaryPath: path }),
    ];

    expect(cursorProbeCalls).toEqual([path]);
    // A shared answer means the same answer object; a per-request fork could not promise agreement.
    for (const result of [...concurrent, ...sequential]) {
      expect(result).toBe(concurrent[0]);
    }
  });

  it("re-forks on the next read after the one invalidation call, without waiting out a TTL", async () => {
    const path = "cursor-rufu-479-refresh";
    await probeCursorCliProvider({ binaryPath: path });
    await probeCursorCliProvider({ binaryPath: path });
    expect(cursorProbeCalls).toEqual([path]);

    invalidateRuntimeCliProbeCaches();
    await probeCursorCliProvider({ binaryPath: path });

    expect(cursorProbeCalls).toEqual([path, path]);
  });

  it("resets the gh availability cache from the same owner, so one Refresh cannot leave the pair split", async () => {
    invalidateRuntimeCliProbeCaches();
    expect(ghReset).toHaveBeenCalledTimes(1);
  });

  it("treats a different configured binary path as its own answer, with no invalidation involved", async () => {
    await probeCursorCliProvider({ binaryPath: "cursor-path-a" });
    await probeCursorCliProvider({ binaryPath: "cursor-path-b" });
    await probeCursorCliProvider({ binaryPath: "cursor-path-a" });

    // A save that points at a new path cannot be answered from the old path's truth, and the old
    // path's cached answer survives for whoever still asks about it.
    expect(cursorProbeCalls).toEqual(["cursor-path-a", "cursor-path-b"]);
  });
});
