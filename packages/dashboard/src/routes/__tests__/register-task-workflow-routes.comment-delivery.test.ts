// @vitest-environment node
/*
FNXC:CommentDelivery 2026-09-27-22:20 (RUFU-259 Step 4):

WHAT THIS FILE PROVES, per write surface: a comment the operator wrote was HANDED OVER with its real row
before the route answered, not merely counted.

The pre-fix surfaces built a wake payload that named a comment id (or none at all) and kept the body on the
card, so a woken agent could read "1 new comment" and nothing else. Two of them were worse: `/review/address`
and `/pr/address-feedback` read `addSteeringComment(...).id`, which is the TASK id — every steering comment on
the card therefore advertised the same wrong id, and a delivery keyed on it would have collapsed them into one
inbox row.

WHY THE ASSERTION IS THE RUN-AUDIT ROW rather than an inbox row: the route test store has no PostgreSQL layer,
so the seam's honest outcome is that the durable write was unavailable. The audit row is stamped from the
payload the ROUTE built — `source`, `kind`, `commentId` — so asserting it proves exactly the contract under
test (the route handed the seam the real appended comment row, from the right surface) without mocking the
seam and asserting a mock. The durable write itself, the idempotency key, and the recipient ladder are pinned
against a real sink in `packages/core/src/tasks/__tests__/task-comment-delivery.test.ts`; composing the two
is what closes the symptom.

THE ORDERING FACT IS ASSERTED, NOT ASSUMED: every test asserts the hand-off was attempted before the response
body arrived, because an un-awaited `void` hand-off would still leave the dashboard claiming "Comment added."
one heartbeat before anything was written.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskStore } from "@fusion/core";
import express from "express";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A comment row with the shape the store writes: id + createdAt + author are what the seam stamps. */
const NEW_COMMENT_ID = "cmt-1";
const COMMENT_TEXT = "please re-run the failing migration test before merging";

function buildStore(options: {
  column?: string;
  prInfo?: Record<string, unknown> | null;
  workflowStepResults?: unknown[];
  branchGroupId?: string;
  activePrEntity?: Record<string, unknown> | null;
} = {}) {
  const auditEvents: Array<Record<string, unknown>> = [];
  const written: string[] = [];
  let task: Record<string, unknown> = {
    id: "FN-001",
    column: options.column ?? "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    comments: [],
    steeringComments: [],
    prInfo: options.prInfo ?? undefined,
    workflowStepResults: options.workflowStepResults ?? undefined,
    branchContext: options.branchGroupId ? { groupId: options.branchGroupId, assignmentMode: "shared" } : undefined,
  };

  const appendComment = (field: "comments" | "steeringComments", text: string, author: string) => {
    task = {
      ...task,
      [field]: [{ id: NEW_COMMENT_ID, text, author, createdAt: "2026-09-27T10:00:00.000Z" }],
    };
    written.push(field);
    return task;
  };

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    // An empty fusion dir means an empty durable-agent pool: the ladder ends at `pool-empty` and reports,
    // which is the branch that still carries the route-built payload we are asserting on.
    getFusionDir: vi.fn(() => fusionDir),
    getAsyncLayer: vi.fn(() => undefined),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async () => [task]),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => null),
    getAgentLogs: vi.fn(async () => []),
    getActivePrEntityBySource: vi.fn(async () => options.activePrEntity ?? null),
    logEntryCalls: [] as Array<{ message: string; detail?: unknown }>,
    addTaskComment: vi.fn(async (_id: string, text: string, author: string) =>
      appendComment("comments", text, author)),
    addSteeringComment: vi.fn(async (_id: string, text: string, author: string) =>
      appendComment("steeringComments", text, author)),
    updateTask: vi.fn(async () => task),
    updateStep: vi.fn(async () => task),
    moveTask: vi.fn(async () => task),
    logEntry: vi.fn(async (_id: string, message: string, detail?: unknown) => {
      (store as unknown as { logEntryCalls: Array<{ message: string; detail?: unknown }> }).logEntryCalls.push({ message, detail });
    }),
    recordRunAuditEvent: vi.fn(async (input: Record<string, unknown>) => {
      auditEvents.push(input);
    }),
  } as unknown as TaskStore;

  return { store, auditEvents, written, taskRef: () => task, logCalls: () => (store as unknown as { logEntryCalls: Array<{ message: string }> }).logEntryCalls };
}

let fusionDir: string;

beforeEach(() => {
  fusionDir = mkdtempSync(join(tmpdir(), "rufu259-empty-"));
});

afterEach(() => {
  rmSync(fusionDir, { recursive: true, force: true });
});

async function post(store: TaskStore, path: string, body: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return REQUEST(app, "POST", `/api/tasks/FN-001${path}`, JSON.stringify(body), {
    "content-type": "application/json",
  });
}

async function get(store: TaskStore, path: string) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return REQUEST(app, "GET", `/api/tasks/FN-001${path}`, undefined, {});
}

/** The delivery audit row the route's own payload produced, or `undefined` when no hand-off was attempted. */
function deliveryAudit(store: ReturnType<typeof buildStore>) {
  return store.auditEvents.find((entry) =>
    String(entry.mutationType).startsWith("task:comment-delivery"));
}

function deliveryMetadata(store: ReturnType<typeof buildStore>) {
  return deliveryAudit(store)?.metadata as Record<string, unknown> | undefined;
}

describe("every comment write surface hands over the comment row it just wrote", () => {
  it("the comment route delivers the new comment's id and body before answering", async () => {
    const ctx = buildStore();

    const res = await post(ctx.store, "/comments", { text: COMMENT_TEXT });

    expect(res.status).toBe(200);
    const metadata = deliveryMetadata(ctx);
    expect(metadata, "the route must attempt the hand-off, not just count the comment").toMatchObject({
      source: "dashboard-comment",
      kind: "comment",
      commentId: NEW_COMMENT_ID,
    });
    // The audit row is ids/counts only: the body must never be copied into it.
    expect(JSON.stringify(deliveryAudit(ctx))).not.toContain("re-run the failing migration test");
  });

  it("an agent-authored comment is handed over too, without a forced wake flag", async () => {
    // The pre-fix surface skipped the hand-off entirely for non-user authors. The body still has to reach
    // the responsible agent; what an agent author may NOT do is force a run — that privilege belongs to a
    // user sender, and the seam stamps `wakeRecipient` accordingly (pinned in the core seam test).
    const ctx = buildStore();

    const res = await post(ctx.store, "/comments", { text: "cross-card note from a sibling agent", author: "agent-abc" });

    expect(res.status).toBe(200);
    expect(deliveryMetadata(ctx)).toMatchObject({ source: "dashboard-comment", commentId: NEW_COMMENT_ID });
  });

  it("the steering route delivers a steering-kind comment", async () => {
    const ctx = buildStore();

    const res = await post(ctx.store, "/steer", { text: COMMENT_TEXT });

    expect(res.status).toBe(200);
    expect(deliveryMetadata(ctx)).toMatchObject({
      source: "dashboard-steer",
      kind: "steering",
      commentId: NEW_COMMENT_ID,
    });
  });

  it("review-address delivers the steering row's OWN id, not the task id", async () => {
    // `addSteeringComment` returns the TASK. Reading `.id` off it produced the task id, so every
    // review-address comment on a card advertised one identical id that no comment row carried.
    const ctx = buildStore({
      workflowStepResults: [
        {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "failed",
          verdict: "REVISE",
          source: "workflow-step",
          completedAt: "2026-09-27T09:00:00.000Z",
          findings: [
            {
              id: "finding-1",
              title: "Lockfile drift",
              body: "Reconcile the pnpm lockfile with the workspace manifests.",
              severity: "P1",
            },
          ],
        },
      ],
    });

    // Read the review the same way the dashboard does, so the id we address is a real canonical id.
    const review = await get(ctx.store, "/review");
    const items = ((review.body as { items?: Array<Record<string, unknown>> })?.items) ?? [];
    expect(items.length, "fixture must produce an addressable review item").toBeGreaterThan(0);
    const itemId = String(items[0]!.itemId ?? items[0]!.id ?? "");
    expect(itemId).toBeTruthy();

    const res = await post(ctx.store, "/review/address", {
      selectedItems: [{ id: itemId, source: "reviewer-agent" }],
    });

    expect(res.status, JSON.stringify(review.body ?? {})).toBe(200);
    const metadata = deliveryMetadata(ctx);
    expect(metadata).toMatchObject({ source: "review-address", kind: "steering" });
    expect(metadata?.commentId).toBe(NEW_COMMENT_ID);
    expect(metadata?.commentId).not.toBe("FN-001");
  });

  it("PR address-feedback delivers the steering row's OWN id, not the task id", async () => {
    const ctx = buildStore({ column: "in-progress", prInfo: { number: 7, url: "https://example.invalid/pr/7", state: "open" } });

    const res = await post(ctx.store, "/pr/address-feedback", {});

    expect(res.status).toBe(200);
    const metadata = deliveryMetadata(ctx);
    expect(metadata).toMatchObject({ source: "pr-address", kind: "steering" });
    expect(metadata?.commentId).toBe(NEW_COMMENT_ID);
    expect(metadata?.commentId).not.toBe("FN-001");
  });
});

describe("the run decision is separate from the hand-off", () => {
  it("a comment on a card in the review lane is still handed over when re-engagement is suppressed", async () => {
    // Pre-fix: the review-lane arm answered (or returned after an open-PR suppression) with NO hand-off at
    // all — the operator's text was written and given to nobody. The durable hand-off now runs first on
    // every arm; only the immediate RUN is left to the re-engagement path (`wakeEligible: false`).
    const ctx = buildStore({
      column: "in-review",
      branchGroupId: "grp-1",
      activePrEntity: { state: "open", number: 9, url: "https://example.invalid/pr/9" },
    });

    const res = await post(ctx.store, "/comments", { text: COMMENT_TEXT });

    expect(res.status).toBe(200);
    // Non-vacuity: prove this really is the suppressed arm — the card stayed put and said why. Without
    // this the test can pass off an ordinary re-engagement that delivered from inside the run arm.
    expect(ctx.logCalls().some((call) => call.message.includes("re-engagement suppressed")),
      "fixture must reach the suppressed re-engagement arm").toBe(true);
    expect(deliveryMetadata(ctx)).toMatchObject({ source: "dashboard-comment", commentId: NEW_COMMENT_ID });
  });
});
