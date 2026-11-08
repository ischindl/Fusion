/*
FNXC:RunningAgentCountReadProjection 2026-11-08-07:55 (RUFU-871):
The footer/Command-Center running-agent count is one of the process's most frequent whole-board readers
— the read-attribution windows put `countRunningAgentsInStore < defaultCountAgents < sampleDomain` in
the top five `listTasks` callers, once per registered project every 5 s plus every footer request — and
allocation sampling over 60 s of ordinary traffic put 90 % of the resulting 788 MB inside the PostgreSQL
driver itself (`DataRow` 417 MB = 53 %, `fromJson` 276 MB = 35 %) against 66 MB (8 %) for `rowToTask`.
So the lever on this read is the column list, and it now declares `workflowStepResults` as the only wide
member it reads.

A column narrowing is invisible to behavior when it is correct and silently wrong when it is not, so the
guard here is behavioral rather than a source scan: the SAME card set is counted twice, once with every
heavy field hydrated and once with the fields this SELECT no longer sends simply absent. The count must
be identical. If a future edit makes the predicate read `task.comments`, `task.description`,
`task.sourceMetadata` or `task.steps`, the two counts diverge and this fails — which is the exact failure
mode a shape test would also catch, but caught on the answer operators see rather than on the text of the
call site. The consumer enumeration that justifies the narrowing is at the function.
*/
import { describe, expect, it, vi } from "vitest";
import { countRunningAgentsInStore } from "../project-store-resolver.js";
import type { TaskStore } from "@fusion/core";

type SeedTask = Record<string, unknown> & { id: string; column: string };

/** Cards covering every arm of `isRunningAgentTask` that a dropped column could have influenced. */
function seedTasks(): SeedTask[] {
  const stamp = "2026-11-08T07:00:00.000Z";
  return [
    { id: "FN-1", column: "in-progress" },
    { id: "FN-2", column: "in-progress", status: "queued" },
    { id: "FN-3", column: "in-progress", paused: true },
    { id: "FN-4", column: "in-progress", userPaused: true },
    { id: "FN-5", column: "in-progress", status: "failed" },
    { id: "FN-6", column: "in-progress", status: "planning" },
    { id: "FN-7", column: "in-review", workflowStepResults: [{ stepId: "code-review", status: "pending" }] },
    { id: "FN-8", column: "in-review", status: "reviewing" },
    { id: "FN-9", column: "in-review", status: "blocked", externalBlock: { origin: "credentials", code: "E", message: "m", source: "agent-declaration", blockedAt: stamp, resume: { column: "in-review" } } },
    { id: "FN-10", column: "done" },
    { id: "FN-11", column: "todo" },
    { id: "FN-12", column: "hold", status: "planning" },
  ];
}

/** The heavy payload a declared read stops transferring, filled with values a predicate could read. */
function withHeavyFields(task: SeedTask): SeedTask {
  const stamp = "2026-11-08T07:00:00.000Z";
  return {
    ...task,
    description: "a long requirement sentence repeated so it is worth bytes ".repeat(8),
    summary: "a reviewer summary",
    steps: [{ id: "s1", name: "implement", status: "done", required: true }],
    attachments: [{ name: "evidence.png", url: "https://example.invalid/1" }],
    comments: [{ id: "c1", author: "reviewer", body: "the finding", createdAt: stamp }],
    steeringComments: [{ id: "sc1", author: "operator", body: "steer left", createdAt: stamp }],
    sourceType: "agent",
    sourceAgentId: "agent-1",
    sourceMetadata: { planEvidence: { spec: "spec text", fingerprint: "fp-1" }, fusionBranchContext: { source: "planning", assignmentMode: "per-task-derived" } },
  };
}

/** The same card set as the projected read delivers it: the undeclared wide fields never arrive. */
function withoutDeclaredFields(task: SeedTask): SeedTask {
  const projected = { ...task };
  for (const column of [
    "description", "summary", "steps", "attachments", "comments", "steeringComments",
    "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId",
    "sourceParentTaskId", "sourceMetadata", "sourceIssueProvider", "sourceIssueRepository",
    "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt",
    "log",
  ]) {
    delete projected[column];
  }
  return projected;
}

function storeReturning(tasks: SeedTask[]) {
  const listTasks = vi.fn(async () => tasks);
  const store = {
    listTasks,
    // The IR resolution falls back to the default coding board when no selection row exists, which is
    // the same answer both sides of the comparison get.
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
  };
  return { store: store as unknown as TaskStore, listTasks };
}

describe("running-agent count read projection (RUFU-871)", () => {
  it("counts the same cards whether or not the dropped wide fields were transferred", async () => {
    const seeds = seedTasks();
    const wide = storeReturning(seeds.map(withHeavyFields));
    const projected = storeReturning(seeds.map(withoutDeclaredFields));

    const wideCount = await countRunningAgentsInStore(wide.store);
    const projectedCount = await countRunningAgentsInStore(projected.store);

    // The premise: this card set actually exercises the predicate, so the equality is not vacuous.
    expect(wideCount).toBeGreaterThan(0);
    expect(projectedCount).toBe(wideCount);
  });

  it("declares the one wide member the predicate dereferences, and asks for no derivation", async () => {
    const { store, listTasks } = storeReturning(seedTasks());
    await countRunningAgentsInStore(store);
    expect(listTasks).toHaveBeenCalledTimes(1);
    const options = listTasks.mock.calls[0]![0] as {
      slim?: boolean;
      derive?: boolean;
      fields?: readonly string[];
    };
    expect(options.slim).toBe(true);
    // `derive: false` is required, not cosmetic: the badge derivations read `sourceMetadata`, which a
    // declared row no longer carries. See the FNXC block at the function.
    expect(options.derive).toBe(false);
    expect(options.fields).toEqual(["workflowStepResults"]);
  });

  it("keeps the pending-step-lease arm alive, which is why `workflowStepResults` cannot be dropped", async () => {
    const pendingLease: SeedTask[] = [{ id: "FN-7", column: "in-review", workflowStepResults: [{ stepId: "code-review", status: "pending" }] }];
    const { store } = storeReturning(pendingLease);
    expect(await countRunningAgentsInStore(store)).toBe(1);

    const withoutLease: SeedTask[] = [{ id: "FN-7", column: "in-review" }];
    const bare = storeReturning(withoutLease);
    expect(await countRunningAgentsInStore(bare.store)).toBe(0);
  });
});
