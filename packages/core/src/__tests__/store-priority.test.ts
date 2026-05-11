import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  describe("task priority", () => {
    it("defaults to normal priority when omitted", async () => {
      const task = await harness.store().createTask({
        description: "Priority default task",
      });

      expect(task.priority).toBe("normal");

      const detail = await harness.store().getTask(task.id);
      expect(detail.priority).toBe("normal");
    });

    it("persists explicit priority on create and update, and normalizes null update to default", async () => {
      const task = await harness.store().createTask({
        description: "Priority explicit task",
        priority: "urgent",
      });
      expect(task.priority).toBe("urgent");

      const lowered = await harness.store().updateTask(task.id, { priority: "low" });
      expect(lowered.priority).toBe("low");

      const reset = await harness.store().updateTask(task.id, { priority: null });
      expect(reset.priority).toBe("normal");

      const detail = await harness.store().getTask(task.id);
      expect(detail.priority).toBe("normal");
    });

    it("keeps triage tasks in triage when only priority changes", async () => {
      const task = await harness.store().createTask({
        description: "Planning task with manual review",
        column: "triage",
        priority: "normal",
      });

      const updated = await harness.store().updateTask(task.id, { priority: "urgent" });
      expect(updated.priority).toBe("urgent");
      expect(updated.column).toBe("triage");
    });

    it("preserves explicit priority through archive and unarchive", async () => {
      const task = await harness.store().createTask({
        description: "Archive priority task",
        column: "done",
        priority: "high",
      });

      await harness.store().archiveTask(task.id, false);
      const archived = await harness.store().getTask(task.id);
      expect(archived.priority).toBe("high");

      const unarchived = await harness.store().unarchiveTask(task.id);
      expect(unarchived.priority).toBe("high");
    });

    it("restores legacy archive entries missing priority as normal", async () => {
      const now = new Date().toISOString();
      const legacyEntry = {
        id: "FN-999",
        title: "Legacy archive task",
        description: "Legacy task without explicit priority",
        column: "archived" as const,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: now,
      };

      const restored = await (harness.store() as any).restoreFromArchive(legacyEntry);
      expect(restored.priority).toBe("normal");

      const unarchived = await harness.store().unarchiveTask(legacyEntry.id);
      expect(unarchived.priority).toBe("normal");
    });
  });
});
