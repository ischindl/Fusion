// @vitest-environment node

/*
FNXC:CrossProjectHandoff 2026-09-09-04:42 (RUFU-203):
Server-side symptom verification for cross-project transfer. The BLOCKING assertions ride two
real project-bound PostgreSQL stores (each with its own taskPrefix), proving:
  (1) the transfer succeeds as a COPY whose target card id is minted from the TARGET project's
      own prefix and lands in that project's intake column (never the source id),
  (2) both pointer directions persist on the rows that read them (target `handoffFrom`, source
      `transferredTo`),
  (3) the second transfer replays onto the SAME canonical target card (200, no orphan row, one
      source pointer entry),
plus refusal/malformed cases as clean 4xx with zero writes. The mock-store block covers the
409 `target-unresolvable` privilege-guard refusal and 4xx shapes without PostgreSQL so those
contracts stay observable even when the PG lane skips.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CentralCore, Task, TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { writeProjectConfig } from "../../../core/src/task-store/async/async-settings.js";
import { createApiRoutes } from "../routes.js";
import type { ServerOptions } from "../server.js";
import { request as REQUEST } from "../test-request.js";
import {
  CROSS_NODE_REFUSAL,
  HANDOFF_AUDIT_EVENT,
  HANDOFF_AUDIT_FAILED_EVENT,
  handoffProposalClaimId,
  TARGET_UNRESOLVABLE_REASON,
} from "../routes/task-transfer.js";

const SRC = "project-rufu203-src";
const TGT = "project-rufu203-tgt";

function fakeCentralCore(projects: Array<{ id: string; name: string }>): CentralCore {
  return { listProjects: async () => projects } as unknown as CentralCore;
}

function fakeEngineManagerFor(stores: Map<string, TaskStore>): ServerOptions["engineManager"] {
  const engines = new Map<string, { getTaskStore: () => TaskStore; getProjectId: () => string }>();
  for (const [projectId, store] of stores) {
    engines.set(projectId, { getTaskStore: () => store, getProjectId: () => projectId });
  }
  return {
    getEngine: (id: string) => engines.get(id),
    onProjectAccessed: () => {},
  } as unknown as ServerOptions["engineManager"];
}

function buildApp(sourceStore: TaskStore, options: { projects: Array<{ id: string; name: string }>; stores: Map<string, TaskStore> }) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createApiRoutes(sourceStore, {
      centralCore: fakeCentralCore(options.projects),
      engineManager: fakeEngineManagerFor(options.stores),
    }),
  );
  return app;
}

function transferRequest(app: express.Express, taskId: string, sourceProjectId: string, body: unknown) {
  return REQUEST(
    app,
    "POST",
    `/api/tasks/${taskId}/transfer?projectId=${encodeURIComponent(sourceProjectId)}`,
    JSON.stringify(body),
    { "content-type": "application/json" },
  );
}

/**
 * FNXC:PlanningRouteTests 2026-07-23-08:10 convention — route-mount TaskStore doubles need an
 * inert PluginStore + async-layer null. This double only covers the transfer route's surface.
 */
function mockStore(overrides: Record<string, unknown> = {}): TaskStore {
  const pluginStore = {
    init: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue([]),
    getPlugin: vi.fn().mockResolvedValue(null),
  };
  return {
    getAsyncLayer: vi.fn().mockReturnValue(null),
    getPluginStore: vi.fn().mockReturnValue(pluginStore),
    getRootDir: vi.fn().mockReturnValue("/fake-rufu203-root"),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => null),
    createTask: vi.fn(async () => {
      throw new Error("mock store createTask not configured");
    }),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    addAttachment: vi.fn(async () => undefined),
    getAttachment: vi.fn(async () => {
      throw new Error("mock store has no attachment bytes");
    }),
    taskDir: () => "/nonexistent-rufu203-taskdir",
    ...overrides,
  } as unknown as TaskStore;
}

function sourceTaskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "AAA-1",
    title: "Original title",
    description: "Ship the transfer feature",
    column: "todo",
    status: "pending",
    sourceMetadata: {},
    attachments: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

describe("POST /tasks/:id/transfer — refusal and request-shape contracts (mock stores)", () => {
  it("refuses a target the local registry does not list: 409 target-unresolvable, zero writes, failed audit", async () => {
    const sourceTask = sourceTaskFixture();
    const source = mockStore({ getTask: vi.fn(async () => sourceTask) });
    const unregisteredTarget = mockStore();
    const app = buildApp(source, {
      projects: [{ id: SRC, name: "Alpha" }],
      stores: new Map([
        [SRC, source],
        [TGT, unregisteredTarget],
      ]),
    });

    const res = await transferRequest(app, "AAA-1", SRC, { targetProjectId: TGT });

    expect(res.status).toBe(409);
    expect((res.body as { details?: { reason?: string } }).details?.reason).toBe(TARGET_UNRESOLVABLE_REASON);
    expect(String((res.body as { error?: string }).error)).toContain(CROSS_NODE_REFUSAL);
    // Zero writes to the unresolvable target: the refusal is the security boundary.
    expect(unregisteredTarget.createTask).not.toHaveBeenCalled();
    expect(unregisteredTarget.addAttachment).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(source.recordRunAuditEvent).toHaveBeenCalledTimes(1));
    const event = (source.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      mutationType: string;
      metadata: Record<string, unknown>;
    };
    expect(event.mutationType).toBe(HANDOFF_AUDIT_FAILED_EVENT);
    expect(event.metadata).toMatchObject({
      outcome: "failed",
      reason: TARGET_UNRESOLVABLE_REASON,
      sourceProjectId: SRC,
      sourceTaskId: "AAA-1",
      targetProjectId: TGT,
    });
    // ids/outcomes only — never card text.
    expect(event.metadata).not.toHaveProperty("title");
    expect(event.metadata).not.toHaveProperty("description");
  });

  it("copies without stamping the source badge under disposition keep-unchanged, with locked create fields", async () => {
    const sourceTask = sourceTaskFixture();
    const source = mockStore({ getTask: vi.fn(async () => sourceTask) });
    const targetCreate = vi.fn(async () => ({ id: "BBB-9", column: "todo", status: "pending" } as Task));
    const target = mockStore({ createTask: targetCreate });
    const app = buildApp(source, {
      projects: [
        { id: SRC, name: "Alpha" },
        { id: TGT, name: "Beta" },
      ],
      stores: new Map([
        [SRC, source],
        [TGT, target],
      ]),
    });

    const res = await transferRequest(app, "AAA-1", SRC, { targetProjectId: TGT, disposition: "keep-unchanged" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ targetTaskId: "BBB-9", targetProjectId: TGT, deduped: false, targetColumn: "todo" });
    const [createInput] = (targetCreate as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      proposalClaimId: string;
      source: { sourceType: string; sourceParentTaskId?: string; sourceMetadata?: Record<string, unknown> };
    }];
    expect(createInput.proposalClaimId).toBe(handoffProposalClaimId(SRC, "AAA-1", TGT));
    expect(createInput.source.sourceType).toBe("cross_project_handoff");
    expect(createInput.source.sourceParentTaskId).toBe("AAA-1");
    expect(createInput.source.sourceMetadata?.handoffFrom).toMatchObject({ projectId: SRC, taskId: "AAA-1" });
    // The whole point of keep-unchanged: no `transferredTo` write against the source card.
    expect(source.updateTask).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(source.recordRunAuditEvent).toHaveBeenCalledTimes(1));
    const event = (source.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      mutationType: string;
      metadata: Record<string, unknown>;
    };
    expect(event.mutationType).toBe(HANDOFF_AUDIT_EVENT);
    expect(event.metadata).toMatchObject({ outcome: "created", sourceTaskId: "AAA-1", targetTaskId: "BBB-9" });
  });

  it("rejects malformed bodies and same-project targets with 4xx and zero target writes", async () => {
    const sourceTask = sourceTaskFixture();
    const source = mockStore({ getTask: vi.fn(async () => sourceTask) });
    const target = mockStore();
    const app = buildApp(source, {
      projects: [
        { id: SRC, name: "Alpha" },
        { id: TGT, name: "Beta" },
      ],
      stores: new Map([
        [SRC, source],
        [TGT, target],
      ]),
    });

    expect((await transferRequest(app, "AAA-1", SRC, {})).status).toBe(400);
    expect((await transferRequest(app, "AAA-1", SRC, { targetProjectId: "   " })).status).toBe(400);
    expect((await transferRequest(app, "AAA-1", SRC, { targetProjectId: TGT, disposition: "shrink" })).status).toBe(400);
    // Same-project transfer is the in-project move case, not a handoff.
    expect((await transferRequest(app, "AAA-1", SRC, { targetProjectId: SRC })).status).toBe(400);

    expect(target.createTask).not.toHaveBeenCalled();
    expect(source.updateTask).not.toHaveBeenCalled();
  });
});

pgDescribe("POST /tasks/:id/transfer — two-project PostgreSQL handoff", () => {
  let srcHarness: PgTestHarness;
  let tgtHarness: PgTestHarness;
  let storeA: TaskStore;
  let storeB: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
    srcHarness = await createTaskStoreForTest({ projectId: SRC });
    tgtHarness = await createTaskStoreForTest({ projectId: TGT });
    await writeProjectConfig(srcHarness.layer, { taskPrefix: "AAA" });
    // The target intentionally carries autoMerge:false + testMode:true: transfer must not
    // depend on auto-merge being enabled or on real AI calls being available.
    await writeProjectConfig(tgtHarness.layer, { taskPrefix: "BBB", autoMerge: false, testMode: true });
    storeA = srcHarness.store;
    storeB = tgtHarness.store;
    app = buildApp(storeA, {
      projects: [
        { id: SRC, name: "Alpha" },
        { id: TGT, name: "Beta" },
      ],
      stores: new Map([
        [SRC, storeA],
        [TGT, storeB],
      ]),
    });
  });

  afterEach(async () => {
    await srcHarness.teardown();
    await tgtHarness.teardown();
  });

  it("copies the card with a target-minted id, target intake column, copied attachment, and live bidirectional pointers", async () => {
    const dependency = await storeA.createTask({ description: "depends on this" });
    const source = await storeA.createTask({
      description: "Ship the transfer feature",
      dependencies: [dependency.id],
    });
    await storeA.addAttachment(source.id, "spec-notes.txt", Buffer.from("hello bytes"), "text/plain");
    // Control card: what a PLAIN createTask lands in on the target — the transfer card must match
    // the target workflow's own intake lane without hardcoding a column name.
    const control = await storeB.createTask({ description: "target intake control" });

    const res = await transferRequest(app, source.id, SRC, { targetProjectId: TGT });

    expect(res.status).toBe(201);
    const body = res.body as {
      targetTaskId: string;
      targetProjectId: string;
      targetProjectName: string;
      targetColumn: string;
      deduped: boolean;
      copiedAttachmentCount: number;
      skippedAttachmentCount: number;
    };
    expect(body.targetTaskId).toMatch(/^BBB-\d+$/);
    expect(body.targetTaskId).not.toBe(source.id);
    expect(body.targetProjectId).toBe(TGT);
    expect(body.targetProjectName).toBe("Beta");
    expect(body.deduped).toBe(false);
    expect(body.copiedAttachmentCount).toBe(1);
    expect(body.skippedAttachmentCount).toBe(0);
    expect(body.targetColumn).toBe(control.column);

    const target = await storeB.getTask(body.targetTaskId);
    expect(target).toBeTruthy();
    // Description copied verbatim, dependencies flattened to informational text, and the
    // source's PROMPT.md appended as a fenced spec appendix.
    expect(target!.description).toContain("Ship the transfer feature");
    expect(target!.description).toContain(`Dependencies at transfer time (informational): ${dependency.id}`);
    expect(target!.description).toContain("## Transferred spec");
    expect(target!.attachments).toHaveLength(1);
    const copiedName = target!.attachments[0]!.filename;
    const copied = await storeB.getAttachment(target!.id, copiedName);
    expect(await readFile(copied.path, "utf8")).toBe("hello bytes");

    // Pointer direction 1: the target card names its origin.
    expect(target!.sourceMetadata?.handoffFrom).toMatchObject({
      projectId: SRC,
      projectName: "Alpha",
      taskId: source.id,
    });
    // Pointer direction 2: the source card lists the target.
    const reloadedSource = await storeA.getTask(source.id);
    expect(reloadedSource?.sourceMetadata?.transferredTo).toEqual([
      { projectId: TGT, projectName: "Beta", taskId: body.targetTaskId, transferredAt: expect.any(String) },
    ]);
  });

  it("replays a second transfer onto the same canonical target card with no orphan row and one pointer entry", async () => {
    const source = await storeA.createTask({ description: "Replay me" });

    const first = await transferRequest(app, source.id, SRC, { targetProjectId: TGT });
    expect(first.status).toBe(201);
    const firstBody = first.body as { targetTaskId: string };

    const second = await transferRequest(app, source.id, SRC, { targetProjectId: TGT });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ targetTaskId: firstBody.targetTaskId, deduped: true });

    const targetTasks = await storeB.listTasks();
    expect(targetTasks).toHaveLength(1);
    const reloaded = await storeA.getTask(source.id);
    expect(reloaded?.sourceMetadata?.transferredTo).toHaveLength(1);
  });

  it("transfers a bare card (no attachments, no PROMPT.md) cleanly with the description copied alone", async () => {
    const source = await storeA.createTask({ description: "Bare card" });
    // A card may legitimately have no spec file; the transfer must not choke and must not
    // invent a spec appendix.
    await rm(join(storeA.taskDir(source.id), "PROMPT.md"), { force: true });

    const res = await transferRequest(app, source.id, SRC, { targetProjectId: TGT });

    expect(res.status).toBe(201);
    const body = res.body as { targetTaskId: string; copiedAttachmentCount: number; skippedAttachmentCount: number };
    expect(body.copiedAttachmentCount).toBe(0);
    expect(body.skippedAttachmentCount).toBe(0);
    const target = await storeB.getTask(body.targetTaskId);
    expect(target!.description).toBe("Bare card");
    expect(target!.description).not.toContain("## Transferred spec");
    const reloaded = await storeA.getTask(source.id);
    expect(reloaded?.sourceMetadata?.transferredTo).toHaveLength(1);
  });
});
