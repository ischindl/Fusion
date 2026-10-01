import { describe, expect, it, vi } from "vitest";
import extension from "../../index.js";

vi.mock("../retriever.js", () => ({
  isLlamaServerReady: vi.fn(),
  listLlamaModels: vi.fn(),
  getLlamaProps: vi.fn(),
}));
vi.mock("../resolver.js", () => ({
  resolveLlamaServerUrl: vi.fn(),
  resolveLlamaServerApiKey: vi.fn(),
}));

import { getLlamaProps, isLlamaServerReady, listLlamaModels } from "../retriever.js";
import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "../resolver.js";

type RegisteredModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

describe("pi-llama-cpp extension", () => {
  it("does not register provider when server is offline", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(false);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("registers llama-server provider when server is reachable", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(true);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue("abc");
    vi.mocked(listLlamaModels).mockResolvedValue([{ id: "qwen" }]);
    vi.mocked(getLlamaProps).mockResolvedValue(null);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "llama-server",
      expect.objectContaining({
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "abc",
      }),
    );
  });

  it("registers real per-model windows from meta.n_ctx with a window-capped maxTokens", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(true);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue(undefined);
    vi.mocked(listLlamaModels).mockResolvedValue([
      { id: "small", meta: { n_ctx: 32768 } },
      { id: "large", meta: { n_ctx: 131072 } },
    ]);
    vi.mocked(getLlamaProps).mockResolvedValue(null);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const models = (
      registerProvider.mock.calls[0][1] as { models: RegisteredModel[] }
    ).models;
    expect(models).toEqual([
      {
        id: "small",
        name: "small",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 16384,
      },
      {
        id: "large",
        name: "large",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 32000,
      },
    ]);
  });

  it("resolves /props windows and the reported n_predict for models without meta", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(true);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue(undefined);
    vi.mocked(listLlamaModels).mockResolvedValue([{ id: "plain" }]);
    vi.mocked(getLlamaProps).mockResolvedValue({
      default_generation_settings: { n_ctx: 32768, params: { n_predict: 4096 } },
    });
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const models = (
      registerProvider.mock.calls[0][1] as { models: RegisteredModel[] }
    ).models;
    expect(models).toEqual([
      {
        id: "plain",
        name: "plain",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ]);
  });

  it("keeps the 128000/32000 defaults when no window metadata is exposed", async () => {
    vi.mocked(isLlamaServerReady).mockResolvedValue(true);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue(undefined);
    vi.mocked(listLlamaModels).mockResolvedValue([{ id: "plain" }]);
    vi.mocked(getLlamaProps).mockResolvedValue(null);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const models = (
      registerProvider.mock.calls[0][1] as { models: RegisteredModel[] }
    ).models;
    expect(models).toEqual([
      {
        id: "plain",
        name: "plain",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      },
    ]);
  });
});
