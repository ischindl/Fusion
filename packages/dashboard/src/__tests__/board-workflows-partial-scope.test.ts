import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";

/*
FNXC:BoardWorkflows 2026-10-01-21:51:
`GET /tasks/board-workflows` answered a NAMED-id request by materialising the whole current-task table
plus the newest Done page — the same cost as one board page (measured 18.6 s unparameterized on the
deployed node, and `?taskIds=` was no faster, because named ids were UNIONED onto the enumeration rather
than replacing it). That price is why the board could never load visible cards first: the lazy "map these
visible ids" refetch cost as much as asking for everything.

These tests hold the two halves of the fix apart:
  - `partial=1` with named ids answers from those ids and spends ZERO whole-table reads;
  - everything else keeps the pre-existing unbounded shape byte-for-byte, including a caller that names
    ids WITHOUT the flag (the current `useUnmappedWorkflowRefetch` path, which replaces its cached
    payload and would render a shrunken lane set from a genuinely partial answer).
*/

type FakeStore = {
  listTasks: ReturnType<typeof vi.fn>;
  listCompletedTasks: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
};

function makeStore(): FakeStore {
  const selections = new Map([["RUFU-1", { workflowId: "builtin:coding", stepIds: [] }]]);
  return {
    listTasks: vi.fn(async () => [{ id: "RUFU-1" }, { id: "RUFU-2" }, { id: "RUFU-3" }]),
    listCompletedTasks: vi.fn(async () => ({ tasks: [{ id: "RUFU-DONE" }] })),
    resolveProjectColumnsForRoles: vi.fn(async () => ["done"]),
    getSettingsFast: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding" })),
    getSettings: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding" })),
    getTaskWorkflowSelectionsAsync: vi.fn(async (ids: string[]) => selections),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowDefinitions: vi.fn(async () => []),
  };
}

async function startServer(store: FakeStore) {
  const app = express();
  const router = express.Router();
  const ctx = {
    router,
    store,
    options: {},
    getProjectContext: async () => ({ store }),
    rethrowAsApiError: (err: unknown) => {
      throw err;
    },
  } as never;
  // `upload.single("file")` runs at registration time, so the stub must exist even though this
  // suite never touches the attachment route.
  const upload = { single: () => (_req: unknown, _res: unknown, next: () => void) => next() };
  registerTaskWorkflowRoutes(ctx, { upload, runtimeLogger: { info() {}, warn() {}, error() {} } } as never);
  app.use("/api", router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("board-workflows named-id scope", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let store: FakeStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("spends no whole-table read when the caller names ids with partial=1", async () => {
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?taskIds=RUFU-1,RUFU-2&partial=1"));
    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.listCompletedTasks).not.toHaveBeenCalled();
    // Only the named ids are answered; an unnamed card is absent rather than silently defaulted.
    expect(payload.taskWorkflowIds).toEqual({ "RUFU-1": "builtin:coding", "RUFU-2": "builtin:coding" });
    expect(payload.flagEnabled).toBe(true);
  });

  it("keeps the unbounded shape for a named-id caller that did not opt in", async () => {
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?taskIds=RUFU-9"));
    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.listCompletedTasks).toHaveBeenCalledTimes(1);
    // The named id still joins the enumerated set, exactly as before the flag existed.
    expect(Object.keys(payload.taskWorkflowIds).sort()).toEqual(["RUFU-1", "RUFU-2", "RUFU-3", "RUFU-9", "RUFU-DONE"]);
  });

  it("does not let partial=1 alone drop the enumeration the board needs for its lanes", async () => {
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?partial=1"));
    expect(res.status).toBe(200);
    await res.json();

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.listCompletedTasks).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:BoardBootRequestSet 2026-11-08-04:15 (RUFU-493):
  A workflow switcher mounts on the board's boot path and reads only the lane list — never
  `taskWorkflowIds` — yet its request was the same whole-current-task-table + newest-Done-page
  enumeration the board pays (measured as two of the 30.0 s / 17.4 s mount reads for one cold board).
  `scope=lanes` is the answer to the question that consumer actually asks: which lanes exist, and what
  are they called. The vocabulary comes from the ONE catalog read this route already takes, so the scope
  must spend ZERO task reads while still naming every lane — an empty or shrunken drop-down is the
  regression this test exists to catch, which is why it asserts the lane NAMES and not just the counts.
  */
  it("answers scope=lanes from the catalog alone: every lane named, zero task reads", async () => {
    store.listWorkflowDefinitions.mockResolvedValue([
      { id: "builtin:coding", name: "Coding", kind: "workflow" },
      { id: "custom:research", name: "Research", kind: "workflow" },
    ]);
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?scope=lanes"));
    expect(res.status).toBe(200);
    const payload = await res.json();

    // The whole point of the scope: no task-table materialisation, no Done page, no per-task selection read.
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.listCompletedTasks).not.toHaveBeenCalled();
    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();

    // Nothing the consumer needs is missing: both lanes are described and the default is named.
    expect(payload.workflows.map((workflow: { id: string }) => workflow.id).sort())
      .toEqual(["builtin:coding", "custom:research"]);
    expect(payload.defaultWorkflowId).toBe("builtin:coding");
    expect(payload.flagEnabled).toBe(true);
    // And it maps nothing, because it was asked about no card.
    expect(payload.taskWorkflowIds).toEqual({});
  });

  /*
  FNXC:BoardBootRequestSet 2026-11-08-05:30 (RUFU-493 code review, P0):
  Every other case here builds its own URL, so none of them ever carried the `projectId` the real client
  always sends alongside a scope. That is the coverage gap that let the malformed client line survive: the
  request the switcher actually issued was `?projectId=X?scope=lanes`, which Express parses as a project
  named `X?scope=lanes` with NO scope parameter, so the branch below was never reached in production while
  its own test stayed green. This case pins the server against the exact production shape - project id and
  lane scope as two separate parameters - so a lane branch that only fires on a bare query cannot ship.
  */
  it("answers the production request shape (projectId AND scope) from the catalog alone", async () => {
    store.listWorkflowDefinitions.mockResolvedValue([
      { id: "builtin:coding", name: "Coding", kind: "workflow" },
    ]);
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?projectId=proj-boot&scope=lanes"));
    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.listCompletedTasks).not.toHaveBeenCalled();
    expect(payload.workflows.map((workflow: { id: string }) => workflow.id)).toEqual(["builtin:coding"]);
    expect(payload.taskWorkflowIds).toEqual({});
  });

  it("keeps the enumeration when a caller names ids without partial, even alongside scope=lanes", async () => {
    server = await startServer(store);
    const res = await fetch(server.url("/api/tasks/board-workflows?taskIds=RUFU-1&scope=lanes"));
    expect(res.status).toBe(200);
    const payload = await res.json();

    // Naming ids is a request for a MAPPING, which a vocabulary-only answer cannot satisfy.
    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(payload.taskWorkflowIds["RUFU-1"]).toBe("builtin:coding");
  });
});
