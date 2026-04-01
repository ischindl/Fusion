/**
 * Tests for project.ts commands
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("project commands", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: string | number | null) => never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.resetModules();
  });

  describe("exports", () => {
    it("should export all project command functions", async () => {
      const project = await import("./project.js");
      expect(typeof project.runProjectList).toBe("function");
      expect(typeof project.runProjectAdd).toBe("function");
      expect(typeof project.runProjectRemove).toBe("function");
      expect(typeof project.runProjectShow).toBe("function");
      expect(typeof project.runProjectSetDefault).toBe("function");
      expect(typeof project.runProjectDetect).toBe("function");
    });
  });

  describe("validation", () => {
    it("runProjectAdd should require name and path", async () => {
      const { runProjectAdd } = await import("./project.js");
      // Test with empty name - should exit
      await runProjectAdd("", "/tmp");
      expect(exitSpy).toHaveBeenCalled();
    });
  });
});
