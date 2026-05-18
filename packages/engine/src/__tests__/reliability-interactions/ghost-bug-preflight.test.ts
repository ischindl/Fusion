import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../../triage.js";
import * as triagePreflight from "../../triage-preflight.js";

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-ghost-preflight-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  await mkdir(join(rootDir, "packages/core/src"), { recursive: true });
  await writeFile(join(rootDir, "packages/core/src/secrets-sync.ts"), "export const value = 1;\n", "utf-8");
  git(rootDir, "git add .");
  git(rootDir, 'git commit -m "chore: init fixture"');

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  await store.updateSettings({ ...DEFAULT_SETTINGS, requirePlanApproval: false });
  const triage = new TriageProcessor(store, rootDir);

  return {
    rootDir,
    store,
    triage,
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe("reliability interactions: ghost-bug preflight", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  const basePrompt = `# Task: FN-1 - Fix issue\n\n**Size:** S\n\n## Review Level: 1\n`;

  it("auto-archives when cited construct is missing", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const task = await fx.store.createTask({ title: "fix: missing construct", description: "typecheck error", prompt: "draft" });

    await (fx.triage as any).finalizeApprovedTask(
      task,
      `${basePrompt}\nCited identifier: \`DefinitelyMissingSymbol_DoNotExist\`\n`,
      await fx.store.getSettings(),
      {},
    );

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("archived");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-ghost-bug", limit: 10 });
    expect(activity.some((entry) => entry.taskId === task.id)).toBe(true);
    const audit = fx.store.getRunAuditEvents({ taskId: task.id, limit: 20 });
    expect(audit.some((entry) => entry.mutationType === "task:auto-archived-ghost-bug")).toBe(true);
  });

  it("passes to todo when construct exists", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const task = await fx.store.createTask({ title: "fix: existing construct", description: "typecheck error", prompt: "draft" });

    await (fx.triage as any).finalizeApprovedTask(
      task,
      `${basePrompt}\n\`value = 1;\`\n`,
      await fx.store.getSettings(),
      {},
    );

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("todo");
  });

  it("fails open when probe throws", async () => {
    const fx = await createFixture();
    fixtures.push(fx);
    const task = await fx.store.createTask({ title: "fix: throwing probe", description: "typecheck error", prompt: "draft" });
    vi.spyOn(triagePreflight, "runGhostBugPreflight").mockRejectedValueOnce(new Error("boom"));

    await (fx.triage as any).finalizeApprovedTask(
      task,
      `${basePrompt}\nCited identifier: \`DefinitelyMissingSymbol_DoNotExist\`\n`,
      await fx.store.getSettings(),
      {},
    );

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("todo");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-ghost-bug", limit: 10 });
    expect(activity.some((entry) => entry.taskId === task.id)).toBe(false);
  });
});
