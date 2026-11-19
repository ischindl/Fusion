/*
RUFU-552: a deterministic dependency-domain refusal is a tool result, never a throw.

This file covers the composer only; the per-surface drive tests (executor, agent lane, CLI, planning lane)
assert that each tool boundary actually reaches it. The store guard itself stays the authority — nothing here
detects a cycle, it only checks that a refusal the store already produced is delivered as a refusal.
*/
import { describe, expect, it } from "vitest";
import { DependencyCycleError, SelfDefeatingDependencyError } from "@fusion/core";
import {
  DEPENDENCY_REFUSAL_GUIDANCE,
  STORE_RETRY_GUIDANCE,
  dependencyDomainRefusal,
  dependencyRefusalResult,
  storeWriteFailure,
} from "../tool-store-errors.js";

/**
 * `SelfSpawnedDependencyError` is exported from core's main barrel but deliberately absent from
 * `index.gate.ts`, the barrel the engine-core gate bundle resolves. Production engine code must therefore
 * classify it on `code` alone, and this stand-in is the shape that path is verified against.
 */
function selfSpawnedShapedError(taskId: string, dependencyId: string): Error {
  const error = new Error(`Task ${taskId} cannot depend on self-spawned task ${dependencyId}`) as Error & {
    code: string;
    taskId: string;
    dependencyId: string;
  };
  error.name = "SelfSpawnedDependencyError";
  error.code = "SELF_SPAWNED_DEPENDENCY";
  error.taskId = taskId;
  error.dependencyId = dependencyId;
  return error;
}

describe("dependencyRefusalResult - the three dependency-domain codes", () => {
  it("turns a cycle into a refusal that names the cycle path", () => {
    const result = dependencyRefusalResult("dependencies", new DependencyCycleError("RUFU-552-B", ["RUFU-552-B", "RUFU-552-A", "RUFU-552-B"]));

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.details.code).toBe("DEPENDENCY_CYCLE");
    expect(result!.details.cyclePath).toEqual(["RUFU-552-B", "RUFU-552-A", "RUFU-552-B"]);
    expect(result!.content[0].text).toContain("refused by the task store");
    expect(result!.content[0].text).toContain("RUFU-552-B → RUFU-552-A → RUFU-552-B");
  });

  it("names the refused dependency for a self-spawned edge", () => {
    const result = dependencyRefusalResult("dependencies", selfSpawnedShapedError("RUFU-552-A", "RUFU-552-CHILD"));

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.details.code).toBe("SELF_SPAWNED_DEPENDENCY");
    expect(result!.details.dependencyId).toBe("RUFU-552-CHILD");
    expect(result!.content[0].text).toContain("RUFU-552-CHILD");
  });

  it("names the verb and operand for a self-defeating edge", () => {
    const result = dependencyRefusalResult("dependencies", new SelfDefeatingDependencyError("Finalize RUFU-552-B", "finalize", "RUFU-552-B"));

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.details.code).toBe("SELF_DEFEATING_DEPENDENCY");
    expect(result!.details.operandTaskId).toBe("RUFU-552-B");
    expect(result!.details.matchedVerb).toBe("finalize");
  });

  it("never tells the agent to retry a deterministic refusal", () => {
    for (const error of [
      new DependencyCycleError("A", ["A", "B", "A"]),
      selfSpawnedShapedError("A", "B"),
      new SelfDefeatingDependencyError("Retry A", "retry", "A"),
    ]) {
      const text = dependencyRefusalResult("dependencies", error)!.content[0].text;
      expect(text).toContain(DEPENDENCY_REFUSAL_GUIDANCE);
      expect(text).not.toContain(STORE_RETRY_GUIDANCE);
      expect(text).not.toContain("Retry the call");
      // STAS-258 rule 2: a refusal is not an outage claim.
      expect(text).not.toMatch(/did not reach the task store/);
    }
  });
});

describe("dependencyDomainRefusal - classification, for the triage arm as well as the tools", () => {
  it("classifies a structurally-shaped error that carries only `code`", () => {
    // Same contract, different class identity: a build resolved against the other core barrel.
    const shaped = Object.assign(new Error("Dependency cycle detected for A: A → B → A"), {
      code: "DEPENDENCY_CYCLE",
      taskId: "A",
      cyclePath: ["A", "B", "A"],
    });
    Object.setPrototypeOf(shaped, Error.prototype);

    const facts = dependencyDomainRefusal(shaped);
    expect(facts?.code).toBe("DEPENDENCY_CYCLE");
    expect(facts?.summary).toContain("A -> B -> A");
  });

  it("returns null for a plain error so the site keeps its store-outage shape", () => {
    expect(dependencyDomainRefusal(new Error("planner produced nothing usable"))).toBeNull();
    expect(dependencyRefusalResult("dependencies", new Error("planner produced nothing usable"))).toBeNull();
  });

  it("returns null for a transient store failure, including a SQL-shaped one", () => {
    const transient = Object.assign(new Error("Failed query: update \"project\".\"tasks\" set dependencies = $1 where id = $2"), {
      cause: { code: "57P01" },
      query: 'update "project"."tasks" set dependencies = $1 where id = $2',
    });

    expect(dependencyDomainRefusal(transient)).toBeNull();
    // ...and that site still lands in the retry-guidance shape rather than a dependency refusal.
    const composed = storeWriteFailure("dependencies", transient);
    expect(composed.details.code).toBe("STORE_UNAVAILABLE");
    expect(composed.content[0].text).toContain(STORE_RETRY_GUIDANCE);
  });

  it("keeps storeWriteFailure's own refusal wording identical after the shared composer", () => {
    const composed = storeWriteFailure("dependency target RUFU-552-X", new Error("Task RUFU-552-X not found"));
    expect(composed.content[0].text).toBe("ERROR: dependency target RUFU-552-X refused by the task store: Task RUFU-552-X not found");
    expect(composed.details).toEqual({ code: "STORE_REFUSAL" });
    expect(composed.isError).toBe(true);
  });

  it("gives the planning lane a summary that names the refused edge without the store's framing", () => {
    const facts = dependencyDomainRefusal(new DependencyCycleError("SANE-480", ["SANE-480", "SANE-479", "SANE-480"]));
    expect(facts?.summary).toContain("SANE-480 -> SANE-479 -> SANE-480");
    expect(facts?.summary).not.toContain("refused by the task store");
  });

  it("recognises a refusal a wrapper re-threw, because a wrapped rule is still a rule", () => {
    // The planning lane receives the escaped throw through a session/tool wrapper that preserves `cause`.
    const wrapped = new Error("planning session terminated with an error", {
      cause: new DependencyCycleError("SANE-480", ["SANE-480", "SANE-479", "SANE-480"]),
    });

    const facts = dependencyDomainRefusal(wrapped);
    expect(facts?.code).toBe("DEPENDENCY_CYCLE");
    expect(facts?.summary).toContain("SANE-480 -> SANE-479 -> SANE-480");
  });

  it("does not follow the chain past its bound, and never classifies a chain with no code", () => {
    let deep: unknown = new DependencyCycleError("SANE-480", ["SANE-480", "SANE-479", "SANE-480"]);
    for (let depth = 0; depth < 12; depth += 1) deep = new Error("wrapper", { cause: deep });
    expect(dependencyDomainRefusal(deep)).toBeNull();

    let chain: unknown = new Error("planner produced nothing usable");
    for (let depth = 0; depth < 3; depth += 1) chain = new Error("wrapper", { cause: chain });
    expect(dependencyDomainRefusal(chain)).toBeNull();
  });
});
