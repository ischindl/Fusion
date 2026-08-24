import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerModelRoutes } from "../routes/register-model-routes.js";

function setup(useDroidCli?: boolean, mergedSettings: Record<string, unknown> = {}) {
  /*
  FNXC:ModelCatalog 2026-08-23-02:16:
  RUFU-163: production registerModelRoutes also registers POST /models/refresh
  (register-model-routes.ts:259); the fixture router must expose the full
  production route surface or registration throws at setup.
  */
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const postHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    // FNXC:ModelCatalog 2026-08-23-23:12: registerModelRoutes also registers POST /models/refresh (FN-019 operator catalog refresh), so a router fake exposing only `get` throws before any GET handler is captured.
    post: vi.fn(),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useDroidCli }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue(mergedSettings),
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

  return { handler: getHandlers.get("/models")!, refreshCatalog: postHandlers.get("/models/refresh")!, modelRegistry };
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

  it("filters droid-cli models when useDroidCli setting is unset", async () => {
    const { handler } = setup(undefined);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(false);
  });

  it("includes resolved planning model when settings hierarchy resolves one", async () => {
    const { handler } = setup(false, {
      planningProvider: "openai",
      planningModelId: "gpt-4o",
    });
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as {
      resolvedPlanningProvider?: string;
      resolvedPlanningModelId?: string;
    };
    expect(response.resolvedPlanningProvider).toBe("openai");
    expect(response.resolvedPlanningModelId).toBe("gpt-4o");
  });

  it("registers POST /models/refresh alongside GET /models with production refresh semantics", async () => {
    const { handler, refreshCatalog } = setup(true);
    expect(handler).toBeTypeOf("function");
    expect(refreshCatalog).toBeTypeOf("function");
    const json = vi.fn();
    await refreshCatalog({}, { json });
    expect(json.mock.calls[0][0]).toEqual({ outcome: "completed" });
  });
});
