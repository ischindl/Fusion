import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "../..");

async function readDesktopFile(relativePath: string): Promise<string> {
  return readFile(path.join(desktopRoot, relativePath), "utf-8");
}

describe("desktop Electron main bundling", () => {
  it("builds dashboard server artifacts and registry manifest from the desktop release build path", async () => {
    const buildScript = await readDesktopFile("scripts/build.ts");

    expect(buildScript).toContain("buildDashboard()");
    expect(buildScript).toContain("dashboardRegistryManifestSource");
    expect(buildScript).toContain("dashboardRegistryManifestDist");
    expect(buildScript).toContain("await cp(dashboardRegistryManifestSource, dashboardRegistryManifestDist)");
  });

  it("externalizes production main-process packages so updater CJS deps are not bundled into ESM", async () => {
    const buildScript = await readDesktopFile("scripts/build.ts");
    const mainBuildBlock = buildScript.match(/entryPoints: \[join\(packageRoot, "src", "main\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];

    expect(mainBuildBlock).toBeDefined();
    expect(mainBuildBlock).toContain('format: "esm"');
    expect(mainBuildBlock).toContain('platform: "node"');
    expect(mainBuildBlock).toContain('packages: "external"');
    expect(mainBuildBlock).toContain("external: mainExternals");

    const preloadBuildBlock = buildScript.match(/entryPoints: \[join\(packageRoot, "src", "preload\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];
    expect(preloadBuildBlock).toBeDefined();
    expect(preloadBuildBlock).toContain('format: "cjs"');
    expect(preloadBuildBlock).toContain('packages: "external"');
  });

  it("keeps development main-process bundling aligned with the production package-external invariant", async () => {
    const devScript = await readDesktopFile("scripts/dev.ts");
    const mainBuildBlock = devScript.match(/entryPoints: \[join\(packageRoot, "src", "main\.ts"\)\],[\s\S]*?logLevel: "info",/m)?.[0];

    expect(mainBuildBlock).toBeDefined();
    expect(mainBuildBlock).toContain('format: "esm"');
    expect(mainBuildBlock).toContain('packages: "external"');
    expect(mainBuildBlock).toContain('external: ["electron"]');
  });

  it("keeps known updater CommonJS dependencies available as packaged runtime files", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    for (const runtimeDependency of [
      "node_modules/electron-updater/**/*",
      "node_modules/fs-extra/**/*",
      "node_modules/graceful-fs/**/*",
    ]) {
      expect(builderConfig).toContain(`- ${runtimeDependency}`);
    }
  });
});
