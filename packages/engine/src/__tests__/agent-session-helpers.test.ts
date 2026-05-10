import { describe, expect, it } from "vitest";
import {
  extractRuntimeHint,
  resolveHeartbeatSessionModels,
  resolveMergerSessionModel,
} from "../agent-session-helpers.js";

describe("extractRuntimeHint", () => {
  it("returns undefined for undefined config", () => {
    expect(extractRuntimeHint(undefined)).toBeUndefined();
  });

  it("returns undefined when runtimeHint key is missing", () => {
    expect(extractRuntimeHint({})).toBeUndefined();
  });

  it("returns normalized runtime hint when configured", () => {
    expect(extractRuntimeHint({ runtimeHint: " openclaw " })).toBe("openclaw");
  });

  it("returns undefined for whitespace-only runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: "   " })).toBeUndefined();
  });

  it("returns undefined for non-string runtimeHint", () => {
    expect(extractRuntimeHint({ runtimeHint: 42 })).toBeUndefined();
  });
});

describe("resolveHeartbeatSessionModels", () => {
  it("uses agent runtime model as primary and execution settings as fallback", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { model: "anthropic/claude-sonnet-4-5" },
    )).toEqual({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4.1",
    });
  });

  it("uses execution settings model when runtime override is missing", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      {},
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });

  it("does not duplicate fallback when runtime and execution model are the same", () => {
    expect(resolveHeartbeatSessionModels(
      {
        executionProvider: "openai",
        executionModelId: "gpt-4.1",
      },
      { modelProvider: "openai", modelId: "gpt-4.1" },
    )).toEqual({
      defaultProvider: "openai",
      defaultModelId: "gpt-4.1",
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    });
  });
});

describe("resolveMergerSessionModel", () => {
  it("uses assigned agent runtime model when both provider and modelId are present", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4.1",
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { model: "  anthropic/claude-3-5-sonnet-20241022  " },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
    });
  });

  it("falls back to default override pair when runtime model is not fully specified", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4.1",
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelProvider: "anthropic" },
      ),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });

  it("falls back to global defaults when no override pair is configured", () => {
    expect(
      resolveMergerSessionModel(
        {
          defaultProvider: "anthropic",
          defaultModelId: "claude-3-5-sonnet",
        },
        { modelId: "claude-3-opus" },
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("ignores partial override pairs and falls back to global defaults", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });

    expect(
      resolveMergerSessionModel({
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    });
  });

  it("works when assignedAgentRuntimeConfig is undefined", () => {
    expect(
      resolveMergerSessionModel({
        defaultProviderOverride: "openai",
        defaultModelIdOverride: "gpt-4.1",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
    });
  });
});
