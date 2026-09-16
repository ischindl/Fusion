import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
/*
FNXC:CodeOrganization 2026-08-03-14:10:
captureBaseCommitSha peeled to executor/worktree-git-refs.ts (U4 Slice B).
Gate suite calls the free function with an injected store — no TaskExecutor method.
*/
import { captureBaseCommitSha } from "../executor/worktree-git-refs.js";
import { executorLog } from "../logger.js";
import type { Task } from "@fusion/core";
import { createMockStore, mockedExec, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4383",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("captureBaseCommitSha", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("captures merge-base for fresh worktree", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "abc1234\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(store, makeTask(), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "abc1234" });
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: false } }));
    /*
    FNXC:BranchBaseIdentity 2026-09-16-01:32:
    A healthy capture is silent by contract: both merge-base measurements succeed, so
    `resolveCapturedBaseCommitSha` warns nothing and the descendant-selection probe failure (swallowed
    by design) must not surface either. Pinning zero warnings here closes the hole where a regression
    that starts warning on a healthy capture could otherwise hide behind the fallback test's assertions.
    The recorded value is unchanged by the descendant rule because the mocked `--is-ancestor` probe
    succeeds and equal merge-bases are never strict descendants.
    */
    expect(vi.mocked(executorLog.warn).mock.calls).toHaveLength(0);
  });

  it("preserves existing valid baseCommitSha across resumed sessions", async () => {
    mockedExecSync.mockReturnValue("");
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(
      store,
      makeTask({ baseCommitSha: "old123" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: true },
    );

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: true } }));
  });

  it("recaptures baseCommitSha on non-resume acquisitions even when stored value is ancestor (FN-4417)", async () => {
    // FN-4417 regression: on a fresh pool acquisition the branch was just
    // force-reset to current main, so any stored baseCommitSha is stale
    // relative to the new merge-base. Preserving it would re-introduce the
    // false-positive contamination cascade.
    mockedExecSync.mockReturnValue(""); // is-ancestor would succeed if asked
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "freshmainSHA\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(
      store,
      makeTask({ baseCommitSha: "stale_main_sha" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: false },
    );

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "freshmainSHA" });
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { purpose: "base", preserved: false } }),
    );
    // Critically: is-ancestor must NOT have been the deciding factor.
    // Even if it would have passed, non-resume always recaptures.
  });

  it("recaptures when existing baseCommitSha is not ancestor", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not ancestor");
    });
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, cmd.includes("merge-base") ? "new456\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(store, makeTask({ baseCommitSha: "stale999" }), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "new456" });
  });

  it("preserves prior merge base on resume for FN-4309/FN-4383 multi-session regression", async () => {
    mockedExecSync.mockReturnValue("");
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(
      store,
      makeTask({ baseCommitSha: "merge_base_sha" }),
      "/tmp/test/.worktrees/fn-4383",
      audit,
      { isResume: true },
    );

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({ metadata: { purpose: "base", preserved: true } }));
  });

  it("falls back to HEAD when merge-base fails", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes("merge-base")) {
        cb(new Error("merge-base failed"), "", "merge-base failed");
        return {} as any;
      }
      cb(null, "head777\n", "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(store, makeTask(), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "head777" });
    /*
    FNXC:BranchBaseIdentity 2026-09-13-21:44:
    Reconciled to the RUFU-231 rewrite (913d6076a4, proven failing at that base): the dual
    local/remote-tracking merge-base measurement replaced the old single measurement whose warn said
    "falling back to HEAD". The HEAD fallback itself is unchanged (the updateTask assertion above still
    pins it) but is now silent; what must still be logged is the FAILED merge-base measurement itself.

    FNXC:BranchBaseIdentity 2026-09-16-01:32:
    The RUFU-231 reconciliation left only a loose `expect.stringContaining("merge-base against")`
    assertion, which a regression could satisfy while silently breaking the operator-facing diagnostic
    it exists to guard. This path's full telemetry contract is now pinned explicitly:
    - Per-ref quoted failure messages are the observable contract: `resolveCapturedBaseCommitSha`
      (packages/engine/src/execution/base-commit-capture.ts) emits one warn per failed `git merge-base`
      measurement, naming its SINGLE-QUOTED ref (shellSingleQuote'd `'main'`, `'origin/main'`) and the
      error message. `captureBaseCommitSha` forwards it with an `${task.id}: ` prefix.
    - The `git rev-parse HEAD` fallback and RUFU-231's diverged-descendant selection (`isStrictDescendant`,
      whose probe failure is swallowed) are SILENT by design: the warning set here is exactly the two
      measurements, so `toHaveLength(2)` is the pin that keeps them silent. A future change that
      intentionally re-adds a fallback warning must update this count in that change with a named reason,
      never relax it to erase a flake.
    - The two legacy sentences ("using HEAD as the execution base commit", "not an ancestor … (diverged
      base)") must not reappear: their presence here means either the diverged-vs-no-ancestor sentences
      collapsed back into one generic message or the degenerate wording was restored.
    This file is in the engine-core merge gate (packages/engine/vitest.config.ts), so every assertion
    here must stay deterministic: fake exec only, no real git, no timers, no polling.
    */
    const warns = vi.mocked(executorLog.warn).mock.calls.map(([m]) => String(m));
    // Guard 1 — the historical degenerate sentences are pinned absent, which also discharges "the
    // diverged-base sentence stays distinct from the no-ancestor sentence": both legacy sentences are
    // absent while the two distinct per-ref sentences below are present. Asserted first so a wording
    // regression reports against THIS guard (vitest stops at the first failed assertion per test).
    expect(warns.some((w) => /using HEAD|not an ancestor|diverged base/i.test(w))).toBe(false);
    // Guard 2 — both measurements failed, so both single-quoted refs must be named, each with its
    // failure reason (unordered: the two probes share one Promise.all).
    expect(warns.some((w) => w.includes("merge-base against 'main' failed"))).toBe(true);
    expect(warns.some((w) => w.includes("merge-base against 'origin/main' failed"))).toBe(true);
    // Guard 3 — the ref is always shell-quoted; a regression that interpolates a bare/unquoted ref
    // (e.g. a collapsed generic message) must not slip through.
    expect(warns.some((w) => /merge-base against (?!')/.test(w))).toBe(false);
    // Guard 4 — exactly the two measurement warnings; the silent HEAD fallback and diverged-descendant
    // selection must contribute nothing.
    expect(warns).toHaveLength(2);
  });

  it("names only the failed ref when the local merge-base fails and the remote-tracking one succeeds", async () => {
    /*
    FNXC:BranchBaseIdentity 2026-09-16-01:32:
    Partial-failure leg of the per-ref warning contract: exactly ONE measurement failing must produce
    exactly ONE warning naming ONLY the single-quoted failed ref, and the surviving remote-tracking
    merge-base must still be recorded as the base (`mbLocal ?? mbRemote` branch). The shell quoting is
    load-bearing for the mock discriminator: `git merge-base HEAD 'origin/main'` does not contain the
    substring `HEAD 'main'`, so the local measurement can be failed without touching the remote one.
    */
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes("merge-base") && String(cmd).includes("HEAD 'main'")) {
        cb(new Error("no such ref"), "", "no such ref");
        return {} as any;
      }
      cb(null, String(cmd).includes("merge-base") ? "remotesha9\n" : "");
      return {} as any;
    }) as any);
    const store = createMockStore();
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await captureBaseCommitSha(store, makeTask(), "/tmp/test/.worktrees/fn-4383", audit);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4383", { baseCommitSha: "remotesha9" });
    const warns = vi.mocked(executorLog.warn).mock.calls.map(([m]) => String(m));
    expect(warns).toHaveLength(1);
    expect(warns.some((w) => w.includes("merge-base against 'main' failed"))).toBe(true);
    expect(warns.some((w) => w.includes("'origin/main'"))).toBe(false);
  });
});
