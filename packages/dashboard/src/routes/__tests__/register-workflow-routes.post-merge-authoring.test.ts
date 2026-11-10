// @vitest-environment node

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P1):
Transport mapping for the authoring refusal, and nothing else. The RULE is pinned at its own seam by
`packages/core/src/__tests__/complete-column-post-merge-authoring.test.ts`; what is pinned here is the
defect that test could not see. The assertion threw a plain `Error`, the workflow routes map only typed
errors to 4xx, and every other error falls through to a 500 — so the one piece of advice this seam exists
to hand the author arrived as "internal server error". A unit test on the throw could never catch that,
because a bare `Error` satisfies any `toThrow`: only an HTTP-level assertion distinguishes 400 from 500.

Two things are therefore asserted per handler: the STATUS (400, the author's mistake, not a server
failure) and the BODY (`code` + `offenders`, so an editor does not re-derive advice by parsing prose). The
last leg keeps the new arm honest in the other direction — an untyped store failure must still be a 500,
or the arm has silently swallowed the class of error it was ordered before.
*/

import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";
import {
  POST_MERGE_COMPLETE_COLUMN_RULE_CODE,
  PostMergeCompleteColumnAuthoringError,
} from "@fusion/core";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";
import { request } from "../../test-request.js";

/** The graph the author drew: the post-merge gate sits in the terminal column. */
const OFFENDING_IR = {
  version: "v2",
  name: "authoring-refusal-test",
  columns: [
    { id: "todo", name: "Todo", traits: [] },
    { id: "in-review", name: "In review", traits: [{ trait: "review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
    { id: "merge", kind: "merge-gate", column: "in-review" },
    { id: "post-merge-verification", kind: "optional-group", column: "done", config: { phase: "post-merge" } },
  ],
  edges: [{ from: "start", to: "merge" }],
} as unknown as WorkflowIr;

const offenders = [{ nodeId: "post-merge-verification", column: "done" }];

/** The store refuses at the seam the route calls, exactly as the shipped assertion does. */
function storeRefusing(makeError: () => unknown): TaskStore {
  return {
    createWorkflowDefinition: async () => { throw makeError(); },
    updateWorkflowDefinition: async () => { throw makeError(); },
  } as unknown as TaskStore;
}

function appFor(store: TaskStore): express.Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkflowRoutes({
    router,
    getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
    rethrowAsApiError: (err: unknown) => {
      throw err instanceof ApiError ? err : new ApiError(500, err instanceof Error ? err.message : String(err));
    },
    options: {},
  } as unknown as Parameters<typeof registerWorkflowRoutes>[0]);
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
    else sendErrorResponse(res, 500, err instanceof Error ? err.message : String(err));
  });
  return app;
}

const authoringError = () =>
  new PostMergeCompleteColumnAuthoringError(
    "Invalid workflow: 'post-merge-verification' (column 'done') declares config.phase \"post-merge\" inside a complete-trait column.",
    offenders,
  );

describe("workflow authoring routes: the post-merge-in-complete-column refusal is 4xx, not 500", () => {
  let store: TaskStore;
  let app: express.Express;

  beforeEach(() => {
    store = storeRefusing(authoringError);
    app = appFor(store);
  });

  const post = (body: unknown) =>
    request(app, "POST", "/api/workflows", JSON.stringify(body), { "content-type": "application/json" });

  it("POST /api/workflows answers 400 with the stable code and the offending node", async () => {
    const res = await post({ name: "offender", ir: OFFENDING_IR });

    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({
      code: POST_MERGE_COMPLETE_COLUMN_RULE_CODE,
      offenders,
    });
    // The advice must be readable text too — the code is for the surface, the sentence for the human.
    expect(res.body.error).toMatch(/post-merge/i);
  });

  it("PATCH /api/workflows/:id answers 400 for an EDIT that moves the gate into the terminal column", async () => {
    const res = await request(
      app,
      "PATCH",
      "/api/workflows/WF-001",
      JSON.stringify({ ir: OFFENDING_IR }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({
      code: POST_MERGE_COMPLETE_COLUMN_RULE_CODE,
      offenders,
    });
  });

  it("leaves an untyped store failure a 500, so the new arm maps only what it names", async () => {
    const broken = appFor(storeRefusing(() => new Error("disk on fire")));

    const res = await request(
      broken,
      "POST",
      "/api/workflows",
      JSON.stringify({ name: "unrelated", ir: OFFENDING_IR }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(500);
  });
});
