import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePluginManifest } from "@fusion/plugin-sdk";
import { resolvePluginEntryFile } from "../commands/plugin.js";
import { runPluginCreate, runPluginNew } from "../commands/plugin-scaffold.js";

describe("plugin-scaffold", () => {
  const tmpBase = join(tmpdir(), `fn-scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("runPluginCreate", () => {
    it("should reject invalid plugin name (uppercase)", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        runPluginCreate("Test-Plugin", { output: join(tmpBase, "test1") }),
      ).rejects.toThrow("exit");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid plugin name"),
      );
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("runPluginNew", () => {
    it("scaffolds standalone plugin output with required files and fields", async () => {
      const outputDir = join(tmpBase, "hello-plugin");
      await runPluginNew("hello-plugin", { output: outputDir });

      const expectedFiles = [
        "package.json",
        "tsconfig.json",
        "vitest.config.ts",
        "manifest.json",
        "src/index.ts",
        "src/__tests__/index.test.ts",
        "README.md",
      ];

      for (const file of expectedFiles) {
        expect(existsSync(join(outputDir, file))).toBe(true);
      }

      const packageJson = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf-8")) as {
        name: string;
        private?: boolean;
        keywords: string[];
        exports: { ".": { types: string; import: string } };
        devDependencies: Record<string, string>;
      };

      expect(packageJson.name).toBe("fusion-plugin-hello-plugin");
      expect(packageJson.keywords).toContain("fusion-plugin");
      expect(packageJson.private).toBeUndefined();
      expect(packageJson.exports["."].types).toBe("./dist/index.d.ts");
      expect(packageJson.exports["."].import).toBe("./dist/index.js");
      expect(Object.keys(packageJson.devDependencies)).toEqual(["@runfusion/fusion"]);
      expect(packageJson.devDependencies["@runfusion/fusion"]).toMatch(/^\^\d+\.\d+\.\d+$/);

      const packageContents = readFileSync(join(outputDir, "package.json"), "utf-8");
      const indexContents = readFileSync(join(outputDir, "src/index.ts"), "utf-8");
      expect(packageContents).not.toContain("@fusion/");
      expect(packageContents).not.toContain("workspace:");
      expect(indexContents).not.toContain("@fusion/");
      expect(indexContents).not.toContain("workspace:");

      const tsconfig = JSON.parse(readFileSync(join(outputDir, "tsconfig.json"), "utf-8")) as {
        extends?: string;
      };
      expect(tsconfig.extends).toBeUndefined();
    });

    it("supports scoped package names", async () => {
      const outputDir = join(tmpBase, "scoped-plugin");
      await runPluginNew("scoped-plugin", { output: outputDir, scope: "acme" });
      const packageJson = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf-8")) as {
        name: string;
      };
      expect(packageJson.name).toBe("@acme/fusion-plugin-scoped-plugin");
    });

    it("rejects invalid plugin names", async () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(runPluginNew("Bad Plugin", { output: join(tmpBase, "bad") })).rejects.toThrow(
        "exit",
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid plugin name"));
      exitMock.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it("produces manifest accepted by validator and loader entry seam", async () => {
      const outputDir = join(tmpBase, "loader-plugin");
      await runPluginNew("loader-plugin", { output: outputDir });

      const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf-8"));
      expect(validatePluginManifest(manifest)).toEqual({ valid: true, errors: [] });

      const distDir = join(outputDir, "dist");
      mkdirSync(distDir, { recursive: true });
      const entryPath = join(distDir, "index.js");
      writeFileSync(entryPath, "export default {};\n");

      await expect(resolvePluginEntryFile(outputDir)).resolves.toBe(entryPath);
    });
  });
});
