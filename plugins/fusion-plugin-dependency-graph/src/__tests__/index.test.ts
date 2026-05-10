import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PluginLoader, PluginStore } from "@fusion/core";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../index";

const testDirs: string[] = [];

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("dependency graph plugin index", () => {
  it("exports node-importable plugin metadata", () => {
    expect(plugin).toBeDefined();
    expect(plugin.manifest.id).toBe("fusion-plugin-dependency-graph");
    expect(plugin.dashboardViews?.[0]).toEqual(
      expect.objectContaining({
        viewId: "graph",
        componentPath: "./dashboard-view",
      }),
    );
  });

  // Vitest's resolver can mask extensionless-import issues in emitted dist files.
  it("is loadable through package exports", async () => {
    const entryModule = await import("@fusion-plugin-examples/dependency-graph");
    expect(entryModule.default?.manifest?.id).toBe("fusion-plugin-dependency-graph");
    expect(entryModule.default?.dashboardViews?.[0]).toEqual(
      expect.objectContaining({ componentPath: "./dashboard-view" }),
    );

    const viewModule = await import("@fusion-plugin-examples/dependency-graph/dashboard-view");
    expect(typeof viewModule.default).toBe("function");
  });

  const hasNodeImportPrereqs =
    existsSync(join(process.cwd(), "dist/dashboard-view.js")) &&
    existsSync(join(process.cwd(), "node_modules/@fusion/plugin-sdk/dist/index.js"));
  const nodeImportTest = hasNodeImportPrereqs ? it : it.skip;
  nodeImportTest("keeps built entrypoint imports Node-ESM-safe for relative specifiers", () => {
    const script =
      "Promise.all([" +
      "import('./plugins/fusion-plugin-dependency-graph/dist/index.js')," +
      "import('node:fs/promises').then((fs) => fs.readFile('./plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js', 'utf8'))" +
      "]).then(([root, dashboardViewSource]) => {" +
      "if (root.default?.manifest?.id !== 'fusion-plugin-dependency-graph') process.exit(2);" +
      "if (!dashboardViewSource.includes('from \\\"./DependencyGraph.js\\\"')) process.exit(3);" +
      "}).catch((e) => { console.error(e?.code, e?.message); process.exit(1); });";

    const repoRoot = resolve(process.cwd(), "../..");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `Node import check failed: ${result.stderr || result.stdout}`).toBe(0);
  });

  const hasPluginLoaderPrereqs = existsSync(join(process.cwd(), "dist/index.js"));
  const pluginLoaderTest = hasPluginLoaderPrereqs ? it : it.skip;
  pluginLoaderTest("is loadable by PluginLoader without throwing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-3737-plugin-loader-"));
    testDirs.push(rootDir);

    const pluginStore = new PluginStore(rootDir, { inMemoryDb: true, centralGlobalDir: rootDir });
    await pluginStore.init();

    const pluginPath = join(process.cwd(), "dist/index.js");
    await pluginStore.registerPlugin({ manifest: plugin.manifest, path: pluginPath });

    const loader = new PluginLoader({
      pluginStore,
      taskStore: { logActivity: async () => undefined } as never,
      pluginDirs: [dirname(dirname(pluginPath))],
    });

    await loader.loadPlugin(plugin.manifest.id);

    const loaded = loader.getPlugin(plugin.manifest.id);
    expect(loaded?.state).toBe("started");
    expect(loaded?.dashboardViews?.[0]).toEqual(
      expect.objectContaining({ viewId: "graph", componentPath: "./dashboard-view" }),
    );
  });
});
