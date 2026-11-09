/**
 * Agent-lane CPU-priority mechanism (RUFU-901).
 *
 * Measured on a 24-core fleet host at load average 16-27 with 113 event-loop-stall episodes in one day: a
 * Fusion agent lane sat at 118 % CPU while the interactive dashboard sat at 124 % — and the two largest
 * tenants that day were neither (`java` 382 %, `kasm` 133 % / 111 %), so this mechanism's job is to stop
 * Fusion's own batch work adding to the pressure ahead of the UI, not to repair the host. The operator's
 * decision was to lower lane priority WITHOUT lowering lane concurrency, so the
 * mechanism must (1) only ever lower priority, (2) never be able to demote the process hosting the UI, and
 * (3) be inert until an operator opts in.
 *
 * These tests assert the mechanism's behavior through its own seam with exact expected values — the recorded
 * (pid, niceness) pair handed to the setter and the closed reason vocabulary — never by reading source text.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CPU_NICENESS_ENV,
  AGENT_CPU_NICENESS_MAX,
  AGENT_CPU_NICENESS_MIN,
  applyAgentCpuPriority,
  resolveAgentCpuNiceness,
} from "../process/cpu-priority.js";
import {
  AGENT_LANE_SESSION_PURPOSES,
  isAgentLaneSessionPurpose,
} from "../cli/cli-session-types.js";

function world(niceness: string | undefined) {
  const calls: Array<{ pid: number; priority: number }> = [];
  const env: NodeJS.ProcessEnv = niceness === undefined ? {} : { [AGENT_CPU_NICENESS_ENV]: niceness };
  const outcome = applyAgentCpuPriority(4242, {
    env,
    setPriorityImpl: (pid, priority) => {
      calls.push({ pid, priority });
    },
  });
  return { calls, outcome };
}

describe("resolveAgentCpuNiceness", () => {
  it("is inert when the opt-in is unset or blank", () => {
    expect(resolveAgentCpuNiceness({})).toEqual({ kind: "off" });
    expect(resolveAgentCpuNiceness({ [AGENT_CPU_NICENESS_ENV]: "" })).toEqual({ kind: "off" });
    expect(resolveAgentCpuNiceness({ [AGENT_CPU_NICENESS_ENV]: "   " })).toEqual({ kind: "off" });
  });

  it.each(["1", "5", "10", " 10 ", "0", String(AGENT_CPU_NICENESS_MAX)])(
    "accepts the demotion value %j",
    (raw) => {
      expect(resolveAgentCpuNiceness({ [AGENT_CPU_NICENESS_ENV]: raw })).toEqual({
        kind: "on",
        niceness: Number(raw.trim()),
      });
    },
  );

  // A negative value would PROMOTE a lane above the interactive server, and a fractional/numeric-looking
  // string is a typo, not a request to run at a different value than the operator wrote. A blank value is
  // NOT in this list: blank means "off", which the inert test above already asserts.
  it.each(["-1", "-20", "20", "19.5", "abc", "8abc", "1e2"])(
    "reports %j as invalid rather than coercing it",
    (raw) => {
      expect(resolveAgentCpuNiceness({ [AGENT_CPU_NICENESS_ENV]: raw })).toEqual({
        kind: "invalid",
        raw,
      });
    },
  );

  it("names the accepted range as demotion-only", () => {
    expect(AGENT_CPU_NICENESS_MIN).toBe(0);
    expect(AGENT_CPU_NICENESS_MAX).toBe(19);
  });
});

describe("applyAgentCpuPriority", () => {
  it("demotes a lane child to the exact configured niceness", () => {
    const { calls, outcome } = world("10");
    expect(calls).toEqual([{ pid: 4242, priority: 10 }]);
    expect(outcome).toEqual({ applied: true, pid: 4242, niceness: 10 });
  });

  it("does nothing when the opt-in is absent — the unchanged-default path", () => {
    const { calls, outcome } = world(undefined);
    expect(calls).toEqual([]);
    expect(outcome).toEqual({ applied: false, reason: "disabled" });
  });

  it("refuses to touch this process, so the server hosting the UI keeps interactive priority", () => {
    const setter = vi.fn();
    const outcome = applyAgentCpuPriority(process.pid, {
      env: { [AGENT_CPU_NICENESS_ENV]: "10" },
      setPriorityImpl: setter,
    });
    expect(setter).not.toHaveBeenCalled();
    expect(outcome).toEqual({ applied: false, reason: "self-process" });
  });

  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -7],
    ["fractional", 12.5],
    ["NaN", Number.NaN],
  ])("skips a %s pid without calling the setter", (_label, pid) => {
    const setter = vi.fn();
    const outcome = applyAgentCpuPriority(pid as number | undefined, {
      env: { [AGENT_CPU_NICENESS_ENV]: "10" },
      setPriorityImpl: setter,
    });
    expect(setter).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ applied: false, reason: "no-pid" });
  });

  it("reports an invalid opt-in instead of guessing a value", () => {
    const { calls, outcome } = world("-5");
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ applied: false, reason: "invalid-config" });
    expect((outcome as { detail: string }).detail).toContain(AGENT_CPU_NICENESS_ENV);
  });

  // The platform guard: `os.setPriority` maps the value onto a Windows priority class and may be refused
  // (EPERM/ESRCH) on any platform. A refusal must be an outcome, never an exception escaping a lane spawn.
  it("folds a setter throw into an outcome instead of failing the spawn", () => {
    const outcome = applyAgentCpuPriority(4242, {
      env: { [AGENT_CPU_NICENESS_ENV]: "10" },
      setPriorityImpl: () => {
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      },
    });
    expect(outcome).toMatchObject({ applied: false, reason: "setter-threw" });
    expect((outcome as { detail: string }).detail).toContain("Operation not permitted");
  });

  it("reports an unavailable setter rather than crashing", () => {
    // A non-nullish non-function is what an exotic runtime/bundle would hand back for `os.setPriority`;
    // `undefined`/`null` would correctly fall through to the real primitive instead of exercising this arm.
    const outcome = applyAgentCpuPriority(4242, {
      env: { [AGENT_CPU_NICENESS_ENV]: "10" },
      setPriorityImpl: "not-a-function" as unknown as (pid: number, priority: number) => void,
    });
    expect(outcome).toEqual({ applied: false, reason: "setter-unavailable" });
  });

  it("does not shell out to nice/renice — the mechanism is one in-process syscall", async () => {
    // Code-construct ratchet on the chosen mechanism (the same class as `engine-no-blocking-shellout`), not a
    // prose assertion: a `nice -n N` argv prefix would change the lane's launch identity, which resume
    // matching and provenance read, and would not exist at all on Windows.
    const source = stripComments(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(new URL("../process/cpu-priority.ts", import.meta.url), "utf8"),
      ),
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\b(execSync|spawnSync|execFileSync)\b/);
    // The only import the mechanism needs is the in-process priority syscall.
    expect(source).toMatch(/from "node:os"/);
  });
});

/**
 * Strip comments before a code-construct scan.
 *
 * FNXC:AgentCpuPriority 2026-11-08-17:31 (RUFU-901):
 * This module's own documentation names the mechanisms it rejected (`nice -n N`, `renice`, `execSync`) to
 * explain WHY they were rejected. Scanning raw source text therefore fails on prose, which is the failure
 * mode the repo's "tests never assert that a comment exists" rule exists to prevent. Comments are removed
 * first, exactly as `packages/engine/src/__tests__/legacy-tombstones.test.ts` does for the same reason, so
 * what is scanned is code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("agent lane purpose census", () => {
  it.each(["execute", "planning", "validator", "ce"])(
    "treats the automatic lane purpose %s as a demotion target",
    (purpose) => {
      expect(isAgentLaneSessionPurpose(purpose)).toBe(true);
    },
  );

  it("excludes the interactive chat purpose, so the UI path is never demoted", () => {
    expect(isAgentLaneSessionPurpose("chat")).toBe(false);
    expect(AGENT_LANE_SESSION_PURPOSES).not.toContain("chat");
  });

  it("treats an unknown purpose as not-a-lane", () => {
    expect(isAgentLaneSessionPurpose("something-new")).toBe(false);
    expect(isAgentLaneSessionPurpose(undefined)).toBe(false);
  });
});
