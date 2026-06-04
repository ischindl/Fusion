import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveAiSessionEvent, PluginContext } from "@fusion/core";
import { TaskStore } from "@fusion/core";
import {
  CeOrchestrator,
  CE_PLUGIN_ID,
  CE_WORK_SOURCE_TYPE,
  WORK_STAGE_ID,
} from "../session/orchestrator.js";
import { getCePipelineStore } from "../sync/pipeline-store.js";
import { makeScriptedSession } from "./_harness.js";

/**
 * U7 work bridge tests. These use the REAL in-memory TaskStore (so created tasks
 * are genuine board tasks under the normal lifecycle) and a scripted fake
 * interactive session (the same deterministic driver U5/U6 use).
 */

let rootDir: string;
let globalDir: string;
let taskStore: TaskStore;
let ctx: PluginContext;
let emitted: Array<{ event: string; data: unknown }>;

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "ce-work-bridge-"));
  globalDir = join(rootDir, ".fusion-global");
  taskStore = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await taskStore.init();

  emitted = [];
  ctx = {
    pluginId: CE_PLUGIN_ID,
    taskStore,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  } as unknown as PluginContext;
});

afterEach(async () => {
  taskStore?.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeOrch(script: InteractiveAiSessionEvent[]) {
  const session = makeScriptedSession(script);
  return new CeOrchestrator({
    ctx,
    createInteractiveAiSession: vi.fn(async () => ({ session })),
    projectRoot: rootDir,
    turnTimeoutMs: 5000,
  });
}

describe("work bridge (U7)", () => {
  it("lands derived tasks on the board, tagged CE-originated with a resolvable back-reference", async () => {
    const orch = makeOrch([
      {
        type: "complete",
        data: {
          artifact: "# Work log\n",
          tasks: [
            { title: "Wire the thing", description: "Implement the thing in module X." },
            { description: "Add tests for the thing.", column: "todo" },
          ],
        },
      },
    ]);

    const started = await orch.start(WORK_STAGE_ID, { openingMessage: "do the work" });
    expect(started.session.status).toBe("completed");
    const cePipelineId = started.session.id;

    // Two board tasks created.
    const tasks = await taskStore.listTasks();
    expect(tasks).toHaveLength(2);

    const pipelineStore = getCePipelineStore(ctx);

    for (const task of tasks) {
      // CE-originated provenance: valid SourceType + CE marker + back-ref copy.
      // (TaskStore exposes provenance as flat top-level fields on the Task.)
      expect(task.sourceType).toBe(CE_WORK_SOURCE_TYPE);
      const meta = task.sourceMetadata as Record<string, unknown> | undefined;
      expect(meta?.pluginId).toBe(CE_PLUGIN_ID);
      expect(meta?.cePipelineId).toBe(cePipelineId);
      expect(meta?.ceStageId).toBe(WORK_STAGE_ID);

      // Authoritative back-reference: the link row resolves task→pipeline/artifact.
      const link = pipelineStore.findByTaskId(task.id);
      expect(link).toBeDefined();
      expect(link?.cePipelineId).toBe(cePipelineId);
      expect(link?.ceStageId).toBe(WORK_STAGE_ID);
      expect(link?.ceArtifactPath).toBe(started.session.artifactPath);
    }

    // Pipeline lists exactly its two links.
    expect(pipelineStore.listByPipeline(cePipelineId)).toHaveLength(2);

    // Optional column honored.
    const todoTask = tasks.find((t) => t.description.includes("Add tests"));
    expect(todoTask?.column).toBe("todo");
  });

  it("created tasks run the NORMAL lifecycle with no plugin interference", async () => {
    const orch = makeOrch([
      { type: "complete", data: { tasks: [{ description: "A normal task." }] } },
    ]);
    const started = await orch.start(WORK_STAGE_ID, { openingMessage: "go" });

    const tasks = await taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks[0];

    // It is an ordinary board task: default column, normal mutation works, and the
    // plugin attached no extra status/hook state beyond provenance metadata.
    expect(task.column).toBe("triage");
    const moved = await taskStore.moveTask(task.id, "todo");
    expect(moved.column).toBe("todo");

    // Re-read is a clean, normal task (provenance is the only CE footprint).
    const reread = await taskStore.getTask(task.id);
    expect(reread?.column).toBe("todo");
    expect((reread?.sourceMetadata as Record<string, unknown>)?.pluginId).toBe(CE_PLUGIN_ID);
    void started;
  });

  it("zero derived tasks is a clean no-op (no board tasks, no orphan link rows)", async () => {
    const orch = makeOrch([{ type: "complete", data: { artifact: "# Nothing to do\n", tasks: [] } }]);
    const started = await orch.start(WORK_STAGE_ID, { openingMessage: "nothing here" });
    expect(started.session.status).toBe("completed");

    expect(await taskStore.listTasks()).toHaveLength(0);
    expect(getCePipelineStore(ctx).listByPipeline(started.session.id)).toHaveLength(0);
  });

  it("a completion payload with NO tasks field is also a no-op", async () => {
    const orch = makeOrch([{ type: "complete", data: { artifact: "# Just an artifact\n" } }]);
    const started = await orch.start(WORK_STAGE_ID, { openingMessage: "x" });
    expect(started.session.status).toBe("completed");
    expect(await taskStore.listTasks()).toHaveLength(0);
    expect(getCePipelineStore(ctx).listByPipeline(started.session.id)).toHaveLength(0);
  });

  it("a non-work stage with a tasks payload does NOT land board tasks (bridge is work-only)", async () => {
    const orch = makeOrch([
      { type: "complete", data: { artifact: "# Brainstorm\n", tasks: [{ description: "should be ignored" }] } },
    ]);
    await orch.start("brainstorm", { openingMessage: "ideas" });
    expect(await taskStore.listTasks()).toHaveLength(0);
  });
});
