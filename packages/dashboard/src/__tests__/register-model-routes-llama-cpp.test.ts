import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerModelRoutes } from "../routes/register-model-routes.js";

function setup(useLlamaCpp?: boolean) {
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
    // FNXC:ModelCatalog 2026-09-06 (merge FN-295 sync): the fixture captures POST handlers so
    // refreshCatalog resolves the registered /models/refresh handler instead of undefined.
    post: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      postHandlers.set(path, handler);
    }),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useLlamaCpp }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(() => [
      { provider: "llama-server", id: "llama3", name: "Llama 3", reasoning: true, contextWindow: 128000 },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
    ]),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return { handler: getHandlers.get("/models")!, refreshCatalog: postHandlers.get("/models/refresh")! };
}

describe("registerModelRoutes llama-server filter", () => {
  it("filters llama-server models when useLlamaCpp is false", async () => {
    const { handler } = setup(false);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(false);
  });

  it("includes llama-server models when useLlamaCpp is true", async () => {
    const { handler } = setup(true);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(true);
  });

  it("filters llama-server models when useLlamaCpp is unset", async () => {
    const { handler } = setup(undefined);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "llama-server")).toBe(false);
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
