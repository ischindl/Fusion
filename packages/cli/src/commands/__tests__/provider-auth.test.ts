import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempWorkspace } from "@fusion/test-utils";
import { createReadOnlyAuthFileStorage, mergeAuthStorageReads, wrapAuthStorageWithApiKeyProviders } from "../provider-auth.js";

function makeAuthStorage(credentials: Record<string, { type: string; key?: string; access?: string; refresh?: string; expires?: number }> = {}) {
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    hasAuth: vi.fn((provider: string) => Boolean(credentials[provider])),
    login: vi.fn(),
    logout: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    set: vi.fn((provider: string, credential: { type: string; key?: string }) => {
      credentials[provider] = credential;
    }),
    remove: vi.fn((provider: string) => {
      delete credentials[provider];
    }),
    get: vi.fn((provider: string) => credentials[provider]),
    getAll: vi.fn(() => ({ ...credentials })),
    list: vi.fn(() => Object.keys(credentials)),
    getApiKey: vi.fn(async (provider: string) => credentials[provider]?.key),
  } as any;
}

describe("wrapAuthStorageWithApiKeyProviders", () => {
  it("reads API keys from Fusion auth first and legacy auth fallbacks second", async () => {
    const fusionAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "fusion-key" },
    });
    const legacyAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "legacy-openrouter-key" },
      minimax: { type: "api_key", key: "legacy-minimax-key" },
    });
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);

    expect(await wrapped.getApiKey("openrouter")).toBe("fusion-key");
    expect(await wrapped.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(wrapped.hasApiKey("minimax")).toBe(true);
    expect(wrapped.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
  });

  it("writes API keys only to Fusion auth storage", () => {
    const fusionAuth = makeAuthStorage();
    const legacyAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "legacy-key" },
    });
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);
    wrapped.setApiKey("openrouter", "fusion-key");

    expect(fusionAuth.set).toHaveBeenCalledWith("openrouter", { type: "api_key", key: "fusion-key" });
    expect(legacyAuth.set).not.toHaveBeenCalled();
  });

  it("reloads all read stores so status reflects both locations", () => {
    const fusionAuth = makeAuthStorage();
    const legacyAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [legacyAuth]);
    wrapped.reload();

    expect(fusionAuth.reload).toHaveBeenCalledTimes(1);
    expect(legacyAuth.reload).toHaveBeenCalledTimes(1);
  });

  it("creates an AuthStorage-compatible merged reader for ModelRegistry", async () => {
    const fusionAuth = makeAuthStorage({
      openrouter: { type: "api_key", key: "fusion-key" },
    });
    const legacyAuth = makeAuthStorage({
      minimax: { type: "api_key", key: "legacy-minimax-key" },
    });

    const merged = mergeAuthStorageReads(fusionAuth, [legacyAuth]);

    expect(await merged.getApiKey("openrouter")).toBe("fusion-key");
    expect(await merged.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(merged.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
    expect(merged.list()).toEqual(expect.arrayContaining(["openrouter", "minimax"]));
  });

  it("excludes pi-claude-cli models from API key providers", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = {
      getAll: vi.fn(() => [
        { provider: "pi-claude-cli", id: "claude-cli/sonnet" },
        { provider: "openrouter", id: "openrouter/auto" },
      ]),
    } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("openrouter");
    expect(providerIds).not.toContain("pi-claude-cli");
  });

  it("includes research-only API-key providers", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("brave");
    expect(providerIds).toContain("tavily");
  });

  it("always includes opencode-go when registry has no opencode models", () => {
    const fusionAuth = makeAuthStorage();
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toContain("opencode-go");
  });

  it("keeps explicit API-key aliases when OAuth provider ids collide", () => {
    const fusionAuth = makeAuthStorage();
    fusionAuth.getOAuthProviders = vi.fn(() => [
      { id: "anthropic", name: "Anthropic OAuth" },
      { id: "opencode-go", name: "Opencode Go OAuth" },
    ]);
    const modelRegistry = { getAll: vi.fn(() => []) } as any;

    const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
    const providerIds = wrapped.getApiKeyProviders().map((provider) => provider.id);

    expect(providerIds).toEqual(expect.arrayContaining(["anthropic-api-key", "opencode-go"]));
    expect(providerIds).not.toContain("anthropic");
  });

  it("reads legacy auth JSON without creating missing files", async () => {
    const tempDir = tempWorkspace("fusion-provider-auth-");
    const legacyAgentDir = join(tempDir, ".pi", "agent");
    const legacyAgentAuth = join(legacyAgentDir, "auth.json");
    const missingLegacyAuth = join(tempDir, ".pi", "auth.json");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(legacyAgentAuth, JSON.stringify({ openrouter: { type: "api_key", key: "legacy-key" } }));

    const storage = createReadOnlyAuthFileStorage([legacyAgentAuth, missingLegacyAuth]);

    expect(await storage.getApiKey("openrouter")).toBe("legacy-key");
    expect(existsSync(missingLegacyAuth)).toBe(false);
  });

  it("reads non-expired OAuth credentials from legacy auth JSON except Anthropic model API-key auth", async () => {
    const tempDir = tempWorkspace("fusion-provider-auth-oauth-");
    const legacyAgentDir = join(tempDir, ".pi", "agent");
    const legacyAgentAuth = join(legacyAgentDir, "auth.json");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      legacyAgentAuth,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() + 60_000,
        },
        anthropic: {
          type: "oauth",
          access: "legacy-anthropic-access-token",
          refresh: "legacy-anthropic-refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const storage = createReadOnlyAuthFileStorage([legacyAgentAuth]);

    expect(await storage.getApiKey("openai-codex")).toBe("legacy-access-token");
    expect(await storage.getApiKey("anthropic")).toBeUndefined();
  });

  describe("Anthropic provider classification", () => {
    it("exposes Anthropic subscription OAuth under anthropic and API-key auth under a separate alias", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
        { id: "github-copilot", name: "GitHub Copilot" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      const oauthProviders = wrapped.getOAuthProviders();
      const apiKeyProviders = wrapped.getApiKeyProviders();

      const oauthIds = oauthProviders.map((p) => p.id);
      expect(oauthIds).toContain("anthropic");
      expect(oauthIds).not.toContain("anthropic-api-key");
      expect(oauthProviders).toContainEqual({ id: "anthropic", name: "Anthropic Subscription" });
      expect(oauthIds).toContain("github-copilot");
      expect(apiKeyProviders).toContainEqual({ id: "anthropic-api-key", name: "Anthropic API Key" });
    });

    it("keeps OpenAI API-key provider id unchanged when OAuth uses openai-codex", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "openai-codex", name: "OpenAI Codex" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => [
        { provider: "openai", id: "openai/gpt-4o" },
      ]) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      const apiKeyProviders = wrapped.getApiKeyProviders();

      expect(apiKeyProviders).toContainEqual({ id: "openai", name: "Openai" });
      expect(apiKeyProviders.some((p) => p.id === "openai-codex")).toBe(false);
    });

    it("keeps only explicit built-ins when a model-registry-derived provider is also OAuth-backed", () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "openai", name: "OpenAI OAuth" },
        { id: "github-copilot", name: "GitHub Copilot" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => [
        { provider: "openai", id: "openai/gpt-4o" },
        { provider: "github-copilot", id: "github-copilot/gpt-4o" },
      ]) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      const apiKeyProviders = wrapped.getApiKeyProviders();

      expect(apiKeyProviders.some((p) => p.id === "openai")).toBe(false);
      expect(apiKeyProviders.some((p) => p.id === "github-copilot")).toBe(false);
    });

    it("keeps Anthropic subscription login from overwriting an existing anthropic API key", async () => {
      const fusionAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "sk-ant-api03-existing" },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      fusionAuth.login = vi.fn(async (provider: string) => {
        fusionAuth.set(provider, {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        });
      });
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      await wrapped.login("anthropic", {} as any);

      expect(fusionAuth.login).toHaveBeenCalledWith("anthropic", expect.any(Object));
      expect(wrapped.get("anthropic")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-subscription")?.type).toBe("oauth");
      expect(wrapped.hasAuth("anthropic-subscription")).toBe(true);
      expect(wrapped.get("anthropic-api-key")).toEqual({ type: "api_key", key: "sk-ant-api03-existing" });
      expect(await wrapped.getApiKey("anthropic")).toBe("sk-ant-api03-existing");
    });

    it("logs out Anthropic subscription alias without clearing the raw API key", () => {
      const fusionAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "sk-ant-api03-existing" },
        "anthropic-subscription": {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      wrapped.logout("anthropic-subscription");

      expect(fusionAuth.logout).toHaveBeenCalledWith("anthropic-subscription");
      expect(fusionAuth.logout).not.toHaveBeenCalledWith("anthropic");
      expect(wrapped.get("anthropic-api-key")).toEqual({ type: "api_key", key: "sk-ant-api03-existing" });
    });

    it("logs out legacy Anthropic OAuth stored under the raw anthropic id", () => {
      const fusionAuth = makeAuthStorage({
        anthropic: {
          type: "oauth",
          access: "legacy-oauth-access",
          refresh: "legacy-oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      expect(wrapped.get("anthropic")?.type).toBe("oauth");

      wrapped.logout("anthropic");
      wrapped.reload();

      expect(fusionAuth.get).toHaveBeenCalledWith("anthropic");
      expect(fusionAuth.logout).toHaveBeenCalledWith("anthropic-subscription");
      expect(fusionAuth.logout).toHaveBeenCalledWith("anthropic");
      expect(wrapped.get("anthropic")).toBeUndefined();
      expect(wrapped.get("anthropic-subscription")).toBeUndefined();
      expect(wrapped.get("anthropic-api-key")).toBeUndefined();
    });

    it("round-trips anthropic API-key alias through the underlying anthropic credential", async () => {
      const fusionAuth = makeAuthStorage();
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      wrapped.setApiKey("anthropic-api-key", "sk-ant-api03-test-key");

      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic", {
        type: "api_key",
        key: "sk-ant-api03-test-key",
      });
      expect(wrapped.hasApiKey("anthropic-api-key")).toBe(true);
      expect(wrapped.hasApiKey("anthropic")).toBe(true);
      expect(await wrapped.getApiKey("anthropic-api-key")).toBe("sk-ant-api03-test-key");
      expect(await wrapped.getApiKey("anthropic")).toBe("sk-ant-api03-test-key");
      expect(wrapped.get("anthropic-api-key")).toEqual({ type: "api_key", key: "sk-ant-api03-test-key" });

      wrapped.clearApiKey("anthropic-api-key");

      expect(fusionAuth.remove).toHaveBeenCalledWith("anthropic");
      expect(wrapped.hasApiKey("anthropic-api-key")).toBe(false);
      expect(await wrapped.getApiKey("anthropic-api-key")).toBeUndefined();
      expect(await wrapped.getApiKey("anthropic")).toBeUndefined();
    });

    it("preserves legacy Anthropic OAuth under anthropic when saving the separated API-key alias", async () => {
      const fusionAuth = makeAuthStorage({
        anthropic: {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      wrapped.setApiKey("anthropic-api-key", "sk-ant-api03-new-key");
      const legacyReadCallIndex = fusionAuth.get.mock.calls.findIndex(([provider]) => provider === "anthropic");
      const apiKeyWriteCallIndex = fusionAuth.set.mock.calls.findIndex(([provider]) => provider === "anthropic");

      expect(legacyReadCallIndex).toBeGreaterThanOrEqual(0);
      expect(fusionAuth.get.mock.invocationCallOrder[legacyReadCallIndex]).toBeLessThan(
        fusionAuth.set.mock.invocationCallOrder[apiKeyWriteCallIndex],
      );
      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic-subscription", expect.objectContaining({ type: "oauth" }));
      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic", {
        type: "api_key",
        key: "sk-ant-api03-new-key",
      });
      expect(wrapped.get("anthropic")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-subscription")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-api-key")).toEqual({ type: "api_key", key: "sk-ant-api03-new-key" });
      expect(await wrapped.getApiKey("anthropic")).toBe("sk-ant-api03-new-key");
    });

    it("preserves legacy Anthropic OAuth under anthropic when clearing the separated API-key alias", async () => {
      const fusionAuth = makeAuthStorage({
        anthropic: {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);
      wrapped.clearApiKey("anthropic-api-key");

      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic-subscription", expect.objectContaining({ type: "oauth" }));
      expect(fusionAuth.remove).toHaveBeenCalledWith("anthropic");
      expect(wrapped.get("anthropic")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-subscription")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-api-key")).toBeUndefined();
      expect(await wrapped.getApiKey("anthropic")).toBeUndefined();
    });

    it("does not treat legacy Anthropic OAuth under anthropic as the model API key", async () => {
      const fusionAuth = makeAuthStorage({
        anthropic: {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry);

      expect(wrapped.hasAuth("anthropic")).toBe(true);
      expect(wrapped.get("anthropic")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-subscription")?.type).toBe("oauth");
      expect(wrapped.hasApiKey("anthropic-api-key")).toBe(false);
      expect(wrapped.get("anthropic-api-key")).toBeUndefined();
      expect(await wrapped.getApiKey("anthropic-api-key")).toBeUndefined();
      expect(await wrapped.getApiKey("anthropic")).toBeUndefined();
    });

    it("hydrates fallback Anthropic OAuth as subscription-only instead of the model API key", async () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: {
          type: "oauth",
          access: "legacy-oauth-access",
          refresh: "legacy-oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });
      fusionAuth.getOAuthProviders = vi.fn(() => [
        { id: "anthropic", name: "Anthropic" },
      ]);
      const modelRegistry = { getAll: vi.fn(() => []) } as any;

      const wrapped = wrapAuthStorageWithApiKeyProviders(fusionAuth, modelRegistry, [fallbackAuth]);

      expect(fusionAuth.set).toHaveBeenCalledWith("anthropic-subscription", expect.objectContaining({ type: "oauth" }));
      expect(wrapped.get("anthropic-subscription")?.type).toBe("oauth");
      expect(wrapped.get("anthropic-api-key")).toBeUndefined();
      expect(wrapped.hasApiKey("anthropic")).toBe(false);
      expect(await wrapped.getApiKey("anthropic")).toBeUndefined();
    });
  });

  describe("logout with fallback credentials", () => {
    it("hides fallback credentials after logout", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);

      // Before logout, fallback credentials are visible
      expect(merged.has("anthropic")).toBe(true);
      expect(merged.hasAuth("anthropic")).toBe(true);
      expect(merged.get("anthropic")).toEqual({ type: "api_key", key: "claude-access-token" });

      // Log out
      merged.logout("anthropic");

      // After logout, fallback credentials are hidden
      expect(merged.has("anthropic")).toBe(false);
      expect(merged.hasAuth("anthropic")).toBe(false);
      expect(merged.get("anthropic")).toBeUndefined();
    });

    it("does not resurrect fallback credentials on reload after logout", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // reload() should NOT bring back the fallback credential
      merged.reload();

      expect(merged.has("anthropic")).toBe(false);
      expect(merged.hasAuth("anthropic")).toBe(false);
    });

    it("excludes logged-out providers from getAll()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      const all = merged.getAll();
      expect("anthropic" in all).toBe(false);
      expect("openrouter" in all).toBe(true);
    });

    it("excludes logged-out providers from list()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      expect(merged.list()).not.toContain("anthropic");
      expect(merged.list()).toContain("openrouter");
    });

    it("hides fallback getApiKey after logout", async () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);

      expect(await merged.getApiKey("anthropic")).toBe("claude-access-token");

      merged.logout("anthropic");

      expect(await merged.getApiKey("anthropic")).toBeUndefined();
    });

    it("re-enables fallback credentials after re-authentication via set()", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // Re-authenticate
      merged.set("anthropic", { type: "api_key", key: "new-key" });

      // Provider is visible again (from primary storage)
      expect(merged.has("anthropic")).toBe(true);
    });

    it("only hides the logged-out provider, not other fallback providers", () => {
      const fusionAuth = makeAuthStorage();
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
        openrouter: { type: "api_key", key: "openrouter-key" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // anthropic is hidden
      expect(merged.hasAuth("anthropic")).toBe(false);
      // openrouter is still visible
      expect(merged.hasAuth("openrouter")).toBe(true);
    });

    it("returns false for hasAuth even when underlying storage reports auth via env var", () => {
      // Simulate the real AuthStorage which checks env vars in hasAuth
      const fusionAuth = makeAuthStorage();
      fusionAuth.hasAuth = vi.fn(() => true); // env var would make this true
      const fallbackAuth = makeAuthStorage({
        anthropic: { type: "api_key", key: "claude-access-token" },
      });

      const merged = mergeAuthStorageReads(fusionAuth, [fallbackAuth]);
      merged.logout("anthropic");

      // Even though the underlying storage reports hasAuth=true (env var),
      // the logged-out provider must still return false
      expect(merged.hasAuth("anthropic")).toBe(false);
      expect(merged.has("anthropic")).toBe(false);
    });
  });
});
