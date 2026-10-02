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
});
