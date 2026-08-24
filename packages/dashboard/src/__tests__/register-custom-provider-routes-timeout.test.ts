/**
 * Custom-provider routes: per-model `timeoutSeconds` validation and persistence.
 *
 * Contract (mirrors the RUFU-123 contextWindow/maxTokens round-trip):
 *   - `timeoutSeconds` is an optional non-negative finite number (seconds);
 *   - `0` is VALID (it means "timeout disabled" for that model) — unlike the positive-only
 *     window fields it may be persisted as 0;
 *   - omitted values are persisted as absent (legacy entries round-trip byte-identical);
 *   - negative, non-finite, and non-numeric values are rejected with HTTP 400.
 */
import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { ApiError } from "../api-error.js";
import { registerCustomProviderRoutes } from "../routes/register-custom-provider-routes.js";

type Handler = (req: { body: unknown; params: Record<string, string> }, res: unknown) => Promise<void>;

function createRouteHarness(existingProviders: Array<Record<string, unknown>> = []) {
  const post = new Map<string, Handler>();
  const put = new Map<string, Handler>();
  const router = {
    // The registrar registers GET/DELETE/POST-probe routes too; only the POST/PUT handlers
    // under test are captured, the rest are no-ops.
    get: vi.fn(),
    delete: vi.fn(),
    post: vi.fn((path: string, handler: Handler) => {
      post.set(path, handler);
    }),
    put: vi.fn((path: string, handler: Handler) => {
      put.set(path, handler);
    }),
  } as unknown as Router;
  const getSettings = vi.fn().mockResolvedValue({ customProviders: existingProviders });
  const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
  const store = {
    getGlobalSettingsStore: vi.fn(() => ({ getSettings })),
    updateGlobalSettings,
  } as never;

  registerCustomProviderRoutes({
    router,
    store,
    rethrowAsApiError: (err: unknown) => {
      throw err;
    },
  } as never);

  return { post, put, updateGlobalSettings };
}

async function invokeCreate(handler: Handler, body: unknown): Promise<unknown> {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ body, params: {} }, res);
  return res.json.mock.calls[0]?.[0];
}

async function invokeUpdate(handler: Handler, id: string, body: unknown): Promise<unknown> {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  await handler({ body, params: { id } }, res);
  return res.json.mock.calls[0]?.[0];
}

const baseProviderBody = {
  name: "Local LLM",
  apiType: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
};

describe("POST /api/custom-providers per-model timeoutSeconds", () => {
  it("persists timeoutSeconds: 0 (disabled) as 0", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    const created = await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "slow-buffered", name: "Slow Buffered", timeoutSeconds: 0 }],
    });

    expect((created as { models: Array<Record<string, unknown>> }).models[0].timeoutSeconds).toBe(0);
    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBe(0);
  });

  it("persists a positive timeoutSeconds unchanged", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "fast", name: "Fast", timeoutSeconds: 1800 }],
    });

    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBe(1800);
  });

  it("persists omitted timeoutSeconds as absent (legacy round-trip unchanged)", async () => {
    const { post, updateGlobalSettings } = createRouteHarness();
    await invokeCreate(post.get("/custom-providers")!, {
      ...baseProviderBody,
      models: [{ id: "legacy", name: "Legacy", contextWindow: 32768, maxTokens: 4096 }],
    });

    const persisted = updateGlobalSettings.mock.calls[0][0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders[0].models[0].timeoutSeconds).toBeUndefined();
    expect("timeoutSeconds" in persisted.customProviders[0].models[0]).toBe(false);
  });

  it.each([
    ["negative", -5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["string", "300"],
    ["boolean", true],
  ] as const)("rejects %s timeoutSeconds with 400", async (_label, value) => {
    const { post } = createRouteHarness();
    await expect(
      invokeCreate(post.get("/custom-providers")!, {
        ...baseProviderBody,
        models: [{ id: "bad", name: "Bad", timeoutSeconds: value }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("timeoutSeconds") });
  });
});

describe("PUT /api/custom-providers/:id per-model timeoutSeconds", () => {
  const existing = [{ id: "p1", name: "Local LLM", apiType: "openai-compatible", baseUrl: "http://localhost:11434/v1", models: [] }];

  it("persists timeoutSeconds: 0 (disabled) on update", async () => {
    const { put, updateGlobalSettings } = createRouteHarness(existing);
    // The PUT handler reads the existing list; p1 is seeded above.
    await invokeUpdate(put.get("/custom-providers/:id")!, "p1", {
      models: [{ id: "slow", name: "Slow", timeoutSeconds: 0 }],
    });

    const persisted = updateGlobalSettings.mock.calls.at(-1)?.[0] as { customProviders: Array<{ models: Array<Record<string, unknown>> }> };
    expect(persisted.customProviders.some((p) => p.models.some((m) => m.id === "slow" && m.timeoutSeconds === 0))).toBe(true);
  });

  it("rejects negative timeoutSeconds with 400 on update", async () => {
    const { put } = createRouteHarness(existing);
    await expect(
      invokeUpdate(put.get("/custom-providers/:id")!, "p1", {
        models: [{ id: "bad", name: "Bad", timeoutSeconds: -1 }],
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
