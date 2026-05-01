import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerModelRoutes } from "../routes/register-model-routes.js";

function setup(useDroidCli?: boolean) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useDroidCli }),
    }),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(() => [
      { provider: "droid-cli", id: "droid/model", name: "Droid", reasoning: false, contextWindow: 0 },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
    ]),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return { handler: getHandlers.get("/models")!, modelRegistry };
}

describe("registerModelRoutes droid-cli filter", () => {
  it("filters droid-cli models when useDroidCli is false", async () => {
    const { handler } = setup(false);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(false);
  });

  it("includes droid-cli models when useDroidCli is true", async () => {
    const { handler } = setup(true);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(true);
  });
});
