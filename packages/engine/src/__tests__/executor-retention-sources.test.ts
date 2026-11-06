import { describe, expect, it, beforeAll } from "vitest";
import {
  hostRetentionRegistrySize,
  listHostRetentionSources,
  resetHostRetentionRegistryForTests,
} from "@fusion/core";
import { TaskExecutorState } from "../executor/task-executor-state.js";

/*
FNXC:RetentionCensus 2026-11-06-09:08 (RUFU-871):
The executor owns ~30 task-keyed collections and until now none of them was visible on `/metrics`, which is why
the dashboard kept recycling with a coverage ratio of 7.5e-7. This test is the contract that makes the
instrument real: registering must report the LIVE map sizes of the owning instance, so a collection that stops
releasing finished tasks shows up as a rising entry line rather than as another OOM.

A minimal subclass is used deliberately. `TaskExecutorState` is the abstract field owner, so poking it needs no
store, no database, and no graph — the registration must work from field state alone.
*/
class ProbeExecutor extends TaskExecutorState {}

function findSource(id: string) {
  const hit = listHostRetentionSources().find((source) => source.id === id);
  if (!hit) throw new Error(`retention source "${id}" was not registered`);
  return hit;
}

describe("TaskExecutorState retention sources", () => {
  let host: ProbeExecutor;
  let registeredBefore: number;

  beforeAll(() => {
    resetHostRetentionRegistryForTests();
    registeredBefore = hostRetentionRegistrySize();
    host = new ProbeExecutor();
    (host as unknown as { registerExecutorRetentionSources(): void }).registerExecutorRetentionSources();
  });

  it("registers the session and bookkeeping collections it owns", () => {
    expect(hostRetentionRegistrySize()).toBeGreaterThan(registeredBefore);
    for (const id of [
      "executor_active_sessions",
      "executor_step_executors",
      "executor_workflow_step_sessions",
      "executor_cli_task_sessions",
      "executor_completed_watchdogs",
      "executor_token_usage_baselines",
    ]) {
      expect(listHostRetentionSources().map((s) => s.id)).toContain(id);
    }
  });

  // An absent series and a zero series have to mean different things, or an idle board is indistinguishable
  // from a dead instrument.
  it("publishes the step-output producer sources at engine start, before any step has run", () => {
    for (const id of [
      "step_output_open_captures",
      "step_output_live_chars",
      "step_output_captures_total",
      "step_output_captured_chars_total",
      "step_output_largest_chars",
    ]) {
      const hit = listHostRetentionSources().find((source) => source.id === id);
      expect(hit, id).toBeDefined();
      expect(hit!.entries()).toBe(0);
      expect(hit!.approxBytes()).toBe(0);
    }
  });

  // The whole point: the number must track the live map, not a snapshot taken at registration.
  it("reports the live size of the owning host", () => {
    const sessions = findSource("executor_active_sessions");
    const start = sessions.entries();
    const bag = (host as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    bag.set("task-a", {});
    expect(sessions.entries()).toBe(start + 1);
    bag.delete("task-a");
    expect(sessions.entries()).toBe(start);
  });

  it("never fails a probe from an untouched host", () => {
    for (const source of listHostRetentionSources()) {
      expect(() => source.entries()).not.toThrow();
      expect(source.probeFailed()).toBe(false);
      expect(Number.isFinite(source.approxBytes())).toBe(true);
    }
  });

  it("binds ids to one host and reports a skipped second host", () => {
    const before = findSource("executor_executing").entries();
    const second = new ProbeExecutor();
    (second as unknown as { registerExecutorRetentionSources(): void }).registerExecutorRetentionSources();
    const bag = (second as unknown as { executing: Set<string> }).executing;
    bag.add("other-host-task");
    // Documented behaviour, not an accident: ids are metric labels, so the first host owns them and a second
    // host's collections are not published under the same label.
    expect(findSource("executor_executing").entries()).toBe(before);
  });
});
