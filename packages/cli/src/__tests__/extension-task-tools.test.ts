import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
/*
FNXC:CliTests 2026-06-14-01:25:
FN-6430 requires rescued CLI suites to run on the default timeout after shared HOME isolation, not via the older file-wide 20s timeout.
Keep this worktree-root regression slice fast by relying on module resets and bounded temp fixtures.
*/
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { TaskStore, getProjectRootFromWorktree } from "@fusion/core";

function makeCtx(cwd: string) {
  return { cwd } as any;
}

async function loadExtension() {
  const mod = await import("../extension.js");
  return mod.default;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("extension task tools resolve repo root from worktrees", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("@fusion/core");
  });

  it("exports getProjectRootFromWorktree from @fusion/core", () => {
    expect(typeof getProjectRootFromWorktree).toBe("function");
  });

  it("uses canonical project root for fn_task_show and fn_task_list from worktree cwd", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-4904-cli-"));
    const worktreeRoot = join(repoRoot, ".worktrees", "feature");
    try {
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      const store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Task from canonical root" });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const showTool = tools.get("fn_task_show");
      const listTool = tools.get("fn_task_list");
      expect(showTool).toBeTruthy();
      expect(listTool).toBeTruthy();

      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(worktreeRoot));
      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(worktreeRoot));

      expect(Array.isArray(list.content)).toBe(true);
      expect(typeof list.details?.count).toBe("number");

      expect(show.content[0].text).toContain(created.id);
      expect(show.content[0].text).toContain("Task from canonical root");
      expect(list.content[0].text).toContain(created.id);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical project root for task tools from AI merge temp linked worktrees", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-6079-cli-"));
    const mergeRoot = await mkdtemp(join(tmpdir(), "fusion-ai-merge-fn-6079-"));
    try {
      git(repoRoot, "init -q -b main");
      git(repoRoot, "config user.email test@example.com");
      git(repoRoot, "config user.name Test");
      await writeFile(join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add -A");
      git(repoRoot, "commit -q -m base");

      const store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Task visible from merge worktree" });
      git(repoRoot, `worktree add --detach ${JSON.stringify(mergeRoot)} HEAD`);
      await mkdir(join(mergeRoot, "packages"), { recursive: true });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const showTool = tools.get("fn_task_show");
      const listTool = tools.get("fn_task_list");

      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(mergeRoot));
      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(join(mergeRoot, "packages")));

      expect(show.content[0].text).toContain("Task visible from merge worktree");
      expect(list.content[0].text).toContain(created.id);
    } finally {
      try {
        git(repoRoot, `worktree remove --force ${JSON.stringify(mergeRoot)}`);
      } catch {
        // best effort cleanup
      }
      await rm(mergeRoot, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back when getProjectRootFromWorktree is unavailable in no-task context", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-4927-cli-"));
    const worktreeRoot = join(repoRoot, ".worktrees", "ambient");
    try {
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      const store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Ambient tool check" });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.doMock("@fusion/core", async () => {
        const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
        return {
          ...actual,
          getProjectRootFromWorktree: undefined,
        };
      });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const listTool = tools.get("fn_task_list");
      const showTool = tools.get("fn_task_show");

      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(worktreeRoot));
      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(worktreeRoot));

      expect(Array.isArray(list.content)).toBe(true);
      expect(typeof list.details?.count).toBe("number");
      expect(Array.isArray(show.content)).toBe(true);
      expect(show.content[0]?.text).toContain(created.id);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
