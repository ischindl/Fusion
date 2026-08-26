import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../resolver.js", () => ({
  resolveLlamaServerUrl: vi.fn(),
  resolveLlamaServerApiKey: vi.fn(),
  resetLlamaResolverCache: vi.fn(),
}));

import { getLlamaProps, listLlamaModels } from "../retriever.js";
import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "../resolver.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("pi-llama-cpp retriever", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(resolveLlamaServerUrl).mockResolvedValue("http://127.0.0.1:8080");
    vi.mocked(resolveLlamaServerApiKey).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe("listLlamaModels", () => {
    it("preserves per-model meta on entries", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: "model-a",
              object: "model",
              owned_by: "llamacpp",
              meta: { n_ctx: 32768, n_vocab: 152064 },
            },
            { id: "model-b", object: "model", owned_by: "llamacpp" },
          ],
        }),
      );

      const models = await listLlamaModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("model-a");
      expect(models[0].meta?.n_ctx).toBe(32768);
      expect(models[0].meta?.n_vocab).toBe(152064);
      expect(models[1].id).toBe("model-b");
      expect(models[1].meta).toBeUndefined();
    });

    it("returns [] when the payload lacks a data array", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ models: [] }));

      await expect(listLlamaModels()).resolves.toEqual([]);
    });
  });

  describe("getLlamaProps", () => {
    it("parses a /props payload carrying default_generation_settings", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          default_generation_settings: {
            n_ctx: 32768,
            params: { n_predict: 4096, max_tokens: -1 },
          },
          total_slots: 1,
        }),
      );

      const props = await getLlamaProps();

      expect(props).not.toBeNull();
      expect(props?.default_generation_settings?.n_ctx).toBe(32768);
      expect(props?.default_generation_settings?.params?.n_predict).toBe(4096);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/props",
        expect.objectContaining({ headers: undefined }),
      );
    });

    it("returns null on a non-ok status", async () => {
      fetchMock.mockResolvedValue(
        new Response("internal error", { status: 500 }),
      );

      await expect(getLlamaProps()).resolves.toBeNull();
    });

    it("returns null when the network is down", async () => {
      fetchMock.mockRejectedValue(new Error("fetch failed"));

      await expect(getLlamaProps()).resolves.toBeNull();
    });

    it("returns null on a malformed JSON body", async () => {
      fetchMock.mockResolvedValue(
        new Response("{ not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await expect(getLlamaProps()).resolves.toBeNull();
    });

    it("sends the Bearer header when an API key is configured", async () => {
      vi.mocked(resolveLlamaServerApiKey).mockResolvedValue("secret-key");
      fetchMock.mockResolvedValue(jsonResponse({}));

      await getLlamaProps();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/props",
        expect.objectContaining({ headers: { Authorization: "Bearer secret-key" } }),
      );
    });

    it("omits the Authorization header when no key is set", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await getLlamaProps();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/props",
        expect.objectContaining({ headers: undefined }),
      );
    });
  });
});
