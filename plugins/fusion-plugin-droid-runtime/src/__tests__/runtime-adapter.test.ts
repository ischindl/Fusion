import { describe, expect, it, vi } from "vitest";
import { DroidRuntimeAdapter } from "../runtime-adapter.js";

describe("DroidRuntimeAdapter", () => {
  it("creates session and describes model", async () => {
    const adapter = new DroidRuntimeAdapter({ droidModel: "droid-pro" });
    const result = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "sys", onText: vi.fn() });
    expect(result.session).toBeDefined();
    expect(adapter.describeModel(result.session)).toContain("droid");
  });
});
