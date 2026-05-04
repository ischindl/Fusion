import { describe, expect, it, vi } from "vitest";
import * as processManager from "../process-manager.js";

describe("provider dependencies", () => {
  it("deduplicates discovered model ids", async () => {
    vi.spyOn(processManager, "discoverDroidModels").mockResolvedValue(["a", "b", "a"]);
    const ids = Array.from(new Set(await processManager.discoverDroidModels()));
    expect(ids).toEqual(["a", "b"]);
  });
});
