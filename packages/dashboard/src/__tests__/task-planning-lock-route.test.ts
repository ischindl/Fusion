/*
FNXC:PlanningLockOperatorSurface 2026-11-11-17:35 (RUFU-600 Step 5) — the refusal an operator can act on.

The reported failure was HTTP 500 on Retry with `Planning lifecycle lock acquisition timed out after
5000ms`, a message that named neither the holder nor the wait, and a status that says "the server broke"
when the truth was "another lane holds this card's planning key". This file pins the two halves of the
fix at the HTTP boundary: the status split (contention is a conflict with a holder; an unreachable
transport is a service failure, never a conflict) and the diagnose/release routes that let an operator
answer «who is holding it» and «release it» without reading a database.

Real express app over the real registrar, exactly like `task-retry-stage-route.test.ts`; the store is the
narrow seam, because its SQL is proven against a real server in
`packages/core/src/__tests__/postgres/planning-lifecycle-lock-leak.pg.test.ts`.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";

import { PlanningLifecycleLockTransportError, TaskNotFoundError, type TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const HOLDER = { label: "planning" as const, pid: 4242, state: "idle in transaction" as const, ageMs: 46_000, taskId: "RUFU-308", ours: true };

const CONFIRM = JSON.stringify({ confirm: true });
const JSON_HEADERS = { "content-type": "application/json" };

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

function storeFake(overrides: Record<string, unknown> = {}) {
  return {
    // The registrar surface reads these during project resolution; nothing here writes.
    getRootDir: vi.fn(() => "/tmp/fusion-planning-lock-route-test"),
    getSettings: vi.fn(async () => ({})),
    getPluginStore: vi.fn(() => ({ init: async () => undefined, listPlugins: async () => [] })),
    // Both planning-lock handlers resolve the card first, exactly like every other per-task route.
    getTask: vi.fn(async (id: string) => { throw new TaskNotFoundError(id); }),
    diagnosePlanningLifecycleLock: vi.fn(async () => ({
      key: "fusion:planning-lifecycle:proj:RUFU-308",
      reason: "held",
      holder: HOLDER,
      transport: { available: true },
      budgetMs: 20_000,
      holders: [HOLDER],
      holdersReason: "ok",
    })),
    releasePlanningLifecycleLock: vi.fn(async (_id: string, input: { confirm: boolean }) => ({
      key: "fusion:planning-lifecycle:proj:RUFU-308",
      released: input.confirm,
      reason: input.confirm ? "released" : "confirmation-required",
      holder: input.confirm ? HOLDER : null,
      terminated: input.confirm,
    })),
    ...overrides,
  } as unknown as TaskStore;
}

/** A store that owns the card both handlers are asked about. */
function withExistingTask(store: TaskStore) {
  (store as unknown as { getTask: ReturnType<typeof vi.fn> }).getTask = vi.fn(async (id: string) => ({ id }));
  return store;
}

const postRelease = (store: TaskStore, body: string = CONFIRM) =>
  performRequest(createApp(store), "POST", "/api/tasks/RUFU-308/planning-lock", body, JSON_HEADERS);

const contention = () => new PlanningLifecycleLockTransportError(
  "Planning lifecycle lock acquisition timed out after 20000ms",
  { reason: "contention", phase: "acquisition", budgetMs: 20_000, waitedMs: 20_000, holder: HOLDER, taskId: "RUFU-308" },
);

describe("mapPlanningLifecycleLockError — the status split", () => {
  it("turns contention into 409 that names the holder and both measurements", async () => {
    const { mapPlanningLifecycleLockError } = await import("../routes/task-planning-lock.js");
    const mapped = mapPlanningLifecycleLockError(contention(), "RUFU-308") as Error & { statusCode: number; details?: Record<string, unknown> };

    expect(mapped.statusCode).toBe(409);
    // The operator must be able to see WHO and HOW LONG from the message alone.
    expect(mapped.message).toContain("planning for RUFU-308 (pid 4242, idle in transaction 46s)");
    expect(mapped.message).toContain("waited 20000ms of a 20000ms budget");
    expect(mapped.message).toContain("GET /api/tasks/RUFU-308/planning-lock");
    expect(mapped.details).toMatchObject({ reason: "planning-lock-contention", holder: HOLDER, waitedMs: 20_000, budgetMs: 20_000 });
  });

  it("says the holder could not be identified instead of inventing one", async () => {
    const { mapPlanningLifecycleLockError } = await import("../routes/task-planning-lock.js");
    const noHolder = new PlanningLifecycleLockTransportError("Planning lifecycle lock acquisition timed out after 20000ms", {
      reason: "contention", phase: "acquisition", budgetMs: 20_000, waitedMs: 20_000,
    });

    const mapped = mapPlanningLifecycleLockError(noHolder, "RUFU-308") as Error & { statusCode: number };
    expect(mapped.statusCode).toBe(409);
    expect(mapped.message).toContain("could not be identified");
  });

  it("keeps a transport that could not be reached out of the conflict class", async () => {
    const { mapPlanningLifecycleLockError } = await import("../routes/task-planning-lock.js");
    const transport = new PlanningLifecycleLockTransportError("Planning lifecycle lock transport unavailable: connection refused", {
      reason: "transport-unavailable", phase: "acquisition",
    });
    expect((mapPlanningLifecycleLockError(transport, "RUFU-308") as { statusCode: number }).statusCode).toBe(503);
  });

  it("answers an unproven key release and an expired hold as service failures, not conflicts", async () => {
    const { mapPlanningLifecycleLockError } = await import("../routes/task-planning-lock.js");
    const teardown = new PlanningLifecycleLockTransportError("Planning lifecycle lock cleanup failed: key could not be verified free", { reason: "teardown-unproven" });
    const hold = new PlanningLifecycleLockTransportError("Planning lifecycle lock hold exceeded after 30000ms", { reason: "hold-exceeded", maxHoldMs: 30_000, heldMs: 31_000 });

    expect((mapPlanningLifecycleLockError(teardown, "RUFU-308") as { statusCode: number }).statusCode).toBe(503);
    const holdMapped = mapPlanningLifecycleLockError(hold, "RUFU-308") as Error & { statusCode: number; message: string };
    expect(holdMapped.statusCode).toBe(503);
    expect(holdMapped.message).toContain("30000ms bound");
  });

  it("leaves an unrelated error exactly as it arrived", async () => {
    const { mapPlanningLifecycleLockError } = await import("../routes/task-planning-lock.js");
    const unrelated = new Error("Task FN-1 not found");
    expect(mapPlanningLifecycleLockError(unrelated, "FN-1")).toBe(unrelated);
  });
});

describe("GET /tasks/:id/planning-lock", () => {
  it("answers who holds the key, with the transport verdict", async () => {
    const store = withExistingTask(storeFake());
    const response = await performRequest(createApp(store), "GET", "/api/tasks/RUFU-308/planning-lock");

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe("held");
    expect(response.body.holder).toMatchObject({ label: "planning", pid: 4242, ageMs: 46_000 });
    expect(store.diagnosePlanningLifecycleLock).toHaveBeenCalledWith("RUFU-308");
  });

  /*
  RUFU-600 code-review P2: an advisory key is derived from an id, not validated against one. Answering
  200 `not-held` for a card that does not exist tells the operator the key is free when the question was
  never about a real card, and lets a typo reach the release path against somebody else's derived key.
  */
  it("404s a card that does not exist instead of diagnosing a key derived from its name", async () => {
    const store = storeFake();
    const response = await performRequest(createApp(store), "GET", "/api/tasks/NOT-A-CARD/planning-lock");

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("NOT-A-CARD");
    expect(store.diagnosePlanningLifecycleLock).not.toHaveBeenCalled();
  });

  it("is a 503 when the store has no advisory-lock domain to read, never an empty answer", async () => {
    const store = withExistingTask(storeFake({ diagnosePlanningLifecycleLock: vi.fn(async () => null) }));
    const response = await performRequest(createApp(store), "GET", "/api/tasks/RUFU-308/planning-lock");

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("PostgreSQL");
  });
});

describe("POST /tasks/:id/planning-lock", () => {
  it("refuses an unconfirmed release and never reaches the store", async () => {
    const store = storeFake();
    const response = await postRelease(store, JSON.stringify({}));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("confirm");
    expect(store.releasePlanningLifecycleLock).not.toHaveBeenCalled();
  });

  it("404s a card that does not exist before any key is released", async () => {
    const store = storeFake();
    const response = await performRequest(
      createApp(store),
      "POST",
      "/api/tasks/NOT-A-CARD/planning-lock",
      CONFIRM,
      JSON_HEADERS,
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("NOT-A-CARD");
    expect(store.releasePlanningLifecycleLock).not.toHaveBeenCalled();
  });

  it("releases a confirmed abandoned holder and reports what it ended", async () => {
    const store = withExistingTask(storeFake());
    const response = await postRelease(store);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ released: true, reason: "released", terminated: true });
    /*
    RUFU-600 code-review P0: the release surface refuses to terminate anything unless the caller proves the
    card idle, so the route must hand it a probe. An assertion on the argument shape is what keeps a future
    edit from quietly dropping the veto — the exact class of silent loss this whole card is about.
    */
    expect(store.releasePlanningLifecycleLock).toHaveBeenCalledWith("RUFU-308", { confirm: true, isCardLive: expect.any(Function) });
  });

  it("never lets a request body lower the release age floor", async () => {
    const store = withExistingTask(storeFake());
    const response = await postRelease(store, JSON.stringify({ confirm: true, ageFloorMs: 0 }));

    expect(response.status).toBe(200);
    const forwarded = (store.releasePlanningLifecycleLock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(forwarded).sort()).toEqual(["confirm", "isCardLive"]);
  });

  it("refuses to end a session that is still working", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({
        key: "k", released: false, reason: "holder-active", holder: { ...HOLDER, state: "active" }, terminated: false,
      })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("still doing work");
  });

  /*
  RUFU-600 code-review P0: every veto the shared release surface can answer with is a refusal the operator
  must be able to tell apart from a success. Each of these once answered 200 or was unmapped entirely.
  */
  it.each([
    ["card-live", "running a planning or execution session"],
    ["below-age-floor", "not yet been idle long enough"],
    ["foreign-holder", "not opened by Fusion"],
  ] as const)("answers a withheld release (%s) as a 409 that says why", async (reason, phrase) => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason, holder: HOLDER, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain(phrase);
    expect(response.body.error).not.toMatch(/released/i);
  });

  /*
  RUFU-600 code-review P1: `identity-not-derivable` means a holder exists and cannot be named — a conflict
  with a remedy, exactly the answer Step 5 pins as 409. It used to fall through to a 200 body, which told a
  client that trusts status the lock was released while the card stayed locked.
  */
  it("answers a holder that cannot be named as a 409, never a 200", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "identity-not-derivable", holder: null, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("cannot be named");
  });

  /*
  RUFU-600 code-review P1: `holder-query-failed` means the key's state is UNKNOWN, which the core code
  itself documents as "NOT the same as free". A 200 there is the "no active lock to release" lie this card
  set out to remove, restated as a status code.
  */
  it("answers an unreadable holder query as a 503, because unknown is not free", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "holder-query-failed", holder: null, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("unknown");
  });

  it("answers a card whose liveness could not be determined as a 503", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "liveness-unproven", holder: HOLDER, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(503);
  });

  it("accepts an idempotent repeat: the key is already free", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "not-held", holder: null, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ released: false, reason: "not-held" });
  });

  it("reports a release it could not verify as a service failure", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "release-unproven", holder: HOLDER, terminated: true })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(503);
  });

  it("treats a reason this file has never seen as a refusal, never as a success", async () => {
    const store = withExistingTask(storeFake({
      releasePlanningLifecycleLock: vi.fn(async () => ({ key: "k", released: false, reason: "invented-by-a-future-build", holder: null, terminated: false })),
    }));
    const response = await postRelease(store);

    expect(response.status).toBe(503);
  });
});
