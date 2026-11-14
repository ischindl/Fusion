// @vitest-environment node
/*
FNXC:PostMergeGateOperatorWaiver 2026-11-14-03:05 (RUFU-599 Step 7, reproduction 1 / RUFU-474):
THE WAIVER'S ATTRIBUTION IS THE ROUTE'S PROMISE, AND NOTHING ELSE TESTS IT. `bypassedBy` is the fact a later
reader (the waived gate row, the card's History line, the merge door's audited-waiver admission) rests on, and
the only writer of it for a GUI click is this route. The store's own coverage sits behind the PG harness, and
the component tests stop at the fetch, so the layer that decides WHO the waiver is credited to was unasserted.
Pinned here: the bearer token is one shared operator secret, so the attribution is the synthetic dashboard
operator and a body-supplied `actor` is advisory display text that can never replace it - an agent could
otherwise stamp any name into the record of a decision that released a card. The refusal shape is pinned in the
same file because the two halves are one contract: an unoffered waiver answers as a conflict naming the store's
own sentence, never as a 500 or a silent 200 with the blocker still standing.
*/
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

function card(): Task {
  return {
    id: "FN-474",
    title: "Post-merge carrier waiver",
    description: "A required post-merge gate ended without a verdict.",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    workflowStepResults: [],
    createdAt: "2026-11-14T02:00:00.000Z",
    updatedAt: "2026-11-14T02:00:00.000Z",
  } as Task;
}

function createStore(options: { refusal?: string } = {}) {
  const waived: Task = {
    ...card(),
    workflowStepResults: [{
      workflowStepId: "post-merge-verification",
      workflowStepName: "Post-merge Verification",
      phase: "post-merge",
      status: "skipped",
      bypassedBy: "unset",
      bypassedAt: "2026-11-14T02:00:00.000Z",
      bypassReason: "unset",
      bypassedFromStatus: "skipped",
    }],
  };
  return {
    bypassFailedPreMergeReviewStep: vi.fn(async (_id: string, opts: { reason: string; actor: string }) => {
      if (options.refusal) throw new Error(options.refusal);
      const [row] = waived.workflowStepResults!;
      return { ...waived, workflowStepResults: [{ ...row, bypassedBy: opts.actor, bypassReason: opts.reason }] };
    }),
    getTask: vi.fn(async () => card()),
    getRootDir: vi.fn(() => "/tmp/fusion-bypass-attribution"),
    getSettings: vi.fn(async () => ({})),
    /* The route context builds its plugin surface from this getter on every request; this contract has none. */
    getPluginStore: () => ({ init: vi.fn(async () => undefined), listPlugins: vi.fn(async () => []) }),
  };
}

function createApp(store: Partial<TaskStore>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store as TaskStore));
  return app;
}

async function postBypass(store: ReturnType<typeof createStore>, body: unknown) {
  return performRequest(
    createApp(store as unknown as TaskStore),
    "POST",
    "/api/tasks/FN-474/bypass-review",
    JSON.stringify(body),
    { "content-type": "application/json" },
  );
}

describe("POST /tasks/:id/bypass-review attribution and refusal", () => {
  it("credits the waiver to the synthetic dashboard operator, never to a client-claimed name", async () => {
    const store = createStore();
    const response = await postBypass(store, { reason: "delivery proven by recorded workspace evidence", actor: "Rufus" });

    expect(response.status).toBe(200);
    expect(store.bypassFailedPreMergeReviewStep).toHaveBeenCalledTimes(1);
    const [, options] = store.bypassFailedPreMergeReviewStep.mock.calls[0] as unknown as [string, { reason: string; actor: string }];
    /* The advisory name is carried as display metadata INSIDE the attribution, so the human who clicked stays
    readable while the authority recorded is the dashboard operator the bearer token actually proves. */
    expect(options.actor).toBe('dashboard-operator (as "Rufus")');
    expect(options.actor).not.toBe("Rufus");
    expect(options.reason).toBe("delivery proven by recorded workspace evidence");
  });

  it("records the bare synthetic operator when the body claims no name", async () => {
    const store = createStore();
    const response = await postBypass(store, { reason: "  waived by the on-call operator  " });

    expect(response.status).toBe(200);
    const [, options] = store.bypassFailedPreMergeReviewStep.mock.calls[0] as unknown as [string, { reason: string; actor: string }];
    expect(options.actor).toBe("dashboard-operator");
    /* The reason is what the audit row and the card's History line quote, so it is trimmed before it is stored. */
    expect(options.reason).toBe("waived by the on-call operator");
  });

  it("refuses a waiver with no reason before the store is asked", async () => {
    const store = createStore();
    const response = await postBypass(store, { reason: "   " });

    expect(response.status).toBe(400);
    expect(store.bypassFailedPreMergeReviewStep).not.toHaveBeenCalled();
  });

  it("answers a store refusal as a conflict that carries the store's own sentence", async () => {
    const store = createStore({ refusal: "Cannot bypass review lane for FN-474: no failed pre-merge review step found" });
    const response = await postBypass(store, { reason: "trying the waiver the card does not offer" });

    expect(response.status).toBe(409);
    const text = JSON.stringify(response.body);
    expect(text).toContain("Cannot bypass review lane");
    /* A refusal is never laundered into success: the caller must be able to tell "nothing was waived" from a waiver. */
    expect(text).not.toMatch(/bypassed/i);
  });
});
