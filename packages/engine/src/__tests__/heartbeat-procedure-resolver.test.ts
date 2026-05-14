import type { Agent, ProjectSettings } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { resolveHeartbeatScopeDisciplineMode, selectHeartbeatProcedure } from "../heartbeat-procedure-resolver.js";

const project = (mode?: ProjectSettings["heartbeatScopeDiscipline"]) => ({ heartbeatScopeDiscipline: mode });
const agent = (mode?: unknown) => ({ runtimeConfig: mode === undefined ? {} : { heartbeatScopeDiscipline: mode } }) as Pick<Agent, "runtimeConfig">;

describe("resolveHeartbeatScopeDisciplineMode", () => {
  it.each(["strict", "lite", "off"] as const)("prefers agent override: %s", (mode) => {
    expect(resolveHeartbeatScopeDisciplineMode(project("strict"), agent(mode))).toBe(mode);
  });

  it.each(["strict", "lite", "off"] as const)("uses project mode when agent unset: %s", (mode) => {
    expect(resolveHeartbeatScopeDisciplineMode(project(mode), agent(undefined))).toBe(mode);
  });

  it("falls through invalid agent mode to project mode", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("lite"), agent("invalid"))).toBe("lite");
  });

  it("falls through invalid project mode to strict default", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("invalid" as never), agent(undefined))).toBe("strict");
  });

  it("falls through invalid agent and invalid project modes to strict default", () => {
    expect(resolveHeartbeatScopeDisciplineMode(project("invalid" as never), agent("invalid"))).toBe("strict");
  });

  it("defaults to strict when unset", () => {
    expect(resolveHeartbeatScopeDisciplineMode(undefined, undefined)).toBe("strict");
  });
});

describe("selectHeartbeatProcedure", () => {
  const procedures = {
    task: { strict: "task-strict", lite: "task-lite", off: "task-off" },
    noTask: { strict: "no-task-strict", lite: "no-task-lite", off: "no-task-off" },
  } as const;

  it.each([
    ["strict", false, "task-strict"],
    ["lite", false, "task-lite"],
    ["off", false, "task-off"],
    ["strict", true, "no-task-strict"],
    ["lite", true, "no-task-lite"],
    ["off", true, "no-task-off"],
  ] as const)("maps mode=%s isNoTask=%s", (mode, isNoTaskRun, expected) => {
    expect(selectHeartbeatProcedure(mode, isNoTaskRun, procedures)).toBe(expected);
  });
});
