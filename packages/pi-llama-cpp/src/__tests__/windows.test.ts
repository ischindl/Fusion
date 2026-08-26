import { describe, expect, it } from "vitest";
import type { LlamaModel, LlamaProps } from "../retriever.js";
import { resolveLlamaModelWindows } from "../windows.js";

function model(id: string, nCtx?: unknown): LlamaModel {
  return nCtx === undefined ? { id } : { id, meta: { n_ctx: nCtx } };
}

function props(
  dgs: { n_ctx?: unknown; params?: Record<string, unknown> } | undefined,
  topLevelNCtx?: unknown,
): LlamaProps {
  const out: Record<string, unknown> = {};
  if (dgs !== undefined) {
    out.default_generation_settings = dgs;
  }
  if (topLevelNCtx !== undefined) {
    out.n_ctx = topLevelNCtx;
  }
  return out as LlamaProps;
}

describe("resolveLlamaModelWindows", () => {
  it("resolves per-model windows from meta.n_ctx with the maxTokens window cap", () => {
    const windows = resolveLlamaModelWindows(
      [model("small", 32768), model("large", 131072)],
      null,
    );

    expect(windows.get("small")).toEqual({ contextWindow: 32768, maxTokens: 16384 });
    expect(windows.get("large")).toEqual({ contextWindow: 131072, maxTokens: 32000 });
  });

  it("falls back to /props default_generation_settings.n_ctx when a model has no meta", () => {
    const windows = resolveLlamaModelWindows([model("small")], props({ n_ctx: 32768 }));

    expect(windows.get("small")).toEqual({ contextWindow: 32768, maxTokens: 16384 });
  });

  it("falls back to top-level props.n_ctx (older builds) when no default_generation_settings", () => {
    const windows = resolveLlamaModelWindows([model("tiny")], props(undefined, 8192));

    expect(windows.get("tiny")).toEqual({ contextWindow: 8192, maxTokens: 4096 });
  });

  it("falls back to the registry defaults when no metadata is available", () => {
    const noProps = resolveLlamaModelWindows([model("plain")], null);
    const undefinedProps = resolveLlamaModelWindows([model("plain")], undefined);

    expect(noProps.get("plain")).toEqual({
      contextWindow: 128000,
      maxTokens: 32000,
    });
    expect(undefinedProps.get("plain")).toEqual({
      contextWindow: 128000,
      maxTokens: 32000,
    });
  });

  it("skips degenerate meta.n_ctx values and falls through the chain", () => {
    const degenerate: unknown[] = [0, -1, null, "32768", NaN, Infinity];
    for (const value of degenerate) {
      // Falls through to the /props rung when it is valid...
      const withProps = resolveLlamaModelWindows(
        [model("m", value)],
        props({ n_ctx: 16384 }),
      );
      expect(withProps.get("m"), `meta.n_ctx=${String(value)}`).toEqual({
        contextWindow: 16384,
        maxTokens: 8192,
      });

      // ...and to the default window when nothing else is available.
      const noProps = resolveLlamaModelWindows([model("m", value)], null);
      expect(noProps.get("m"), `meta.n_ctx=${String(value)}`).toEqual({
        contextWindow: 128000,
        maxTokens: 32000,
      });
    }
  });

  it("prefers meta.n_ctx over the props rungs for the same model", () => {
    const windows = resolveLlamaModelWindows(
      [model("m", 8192)],
      props({ n_ctx: 32768 }, 65536),
    );

    expect(windows.get("m")).toEqual({ contextWindow: 8192, maxTokens: 4096 });
  });

  describe("maxTokens raw-source selection and cap", () => {
    it("keeps a reported n_predict below the cap", () => {
      const windows = resolveLlamaModelWindows(
        [model("m", 32768)],
        props({ n_ctx: 32768, params: { n_predict: 4096 } }),
      );

      expect(windows.get("m")).toEqual({ contextWindow: 32768, maxTokens: 4096 });
    });

    it("uses the 32000 fallback when n_predict is -1 (unlimited) at the default window", () => {
      const windows = resolveLlamaModelWindows(
        [model("m")],
        props({ params: { n_predict: -1 } }),
      );

      expect(windows.get("m")).toEqual({ contextWindow: 128000, maxTokens: 32000 });
    });

    it("caps the 32000 fallback at half a 32768 window", () => {
      const windows = resolveLlamaModelWindows(
        [model("m", 32768)],
        props({ n_ctx: 32768, params: { n_predict: -1 } }),
      );

      expect(windows.get("m")).toEqual({ contextWindow: 32768, maxTokens: 16384 });
    });

    it("uses params.max_tokens as the alias when n_predict is absent", () => {
      const windows = resolveLlamaModelWindows(
        [model("m", 32768)],
        props({ n_ctx: 32768, params: { max_tokens: 8192 } }),
      );

      expect(windows.get("m")).toEqual({ contextWindow: 32768, maxTokens: 8192 });
    });

    it("caps a large reported n_predict at half the window — never above half", () => {
      const windows = resolveLlamaModelWindows(
        [model("m", 131072)],
        props({ n_ctx: 131072, params: { n_predict: 100000 } }),
      );

      expect(windows.get("m")).toEqual({ contextWindow: 131072, maxTokens: 65536 });
    });
  });

  it("returns an empty map for an empty model list", () => {
    const windows = resolveLlamaModelWindows([], props({ n_ctx: 32768 }));

    expect(windows.size).toBe(0);
  });

  it("contains every listed model id", () => {
    const models = [model("a"), model("b", 32768), model("c")];
    const windows = resolveLlamaModelWindows(models, null);

    expect([...windows.keys()]).toEqual(["a", "b", "c"]);
  });
});
