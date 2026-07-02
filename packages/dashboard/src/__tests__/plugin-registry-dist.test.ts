// @vitest-environment node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardRoot = path.resolve(__dirname, "../..");

async function readDashboardFile(relativePath: string): Promise<string> {
  return readFile(path.join(dashboardRoot, relativePath), "utf-8");
}

describe("plugin registry production output", () => {
  it("does not emit a Node 22-invalid static JSON import for registry-manifest.json", async () => {
    const pluginRoutesDist = await readDashboardFile("dist/plugin-routes.js");

    expect(pluginRoutesDist).not.toMatch(/import\s+\w+\s+from\s+["']\.\/registry-manifest\.json["'];?/);
    expect(pluginRoutesDist).toContain('new URL("./registry-manifest.json", import.meta.url)');
    expect(pluginRoutesDist).toContain("JSON.parse");
  });

  it("copies a readable registry manifest beside the emitted dashboard server files", async () => {
    const manifestPath = path.join(dashboardRoot, "dist/registry-manifest.json");
    await expect(access(manifestPath)).resolves.toBeUndefined();

    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as { plugins?: unknown };
    expect(Array.isArray(manifest.plugins)).toBe(true);
  });
});
