import { existsSync, readFileSync } from "node:fs";
import type {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

export type LoginCallbacks = Parameters<AuthStorage["login"]>[1];

export interface DashboardAuthStorage {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(providerId: string, callbacks: LoginCallbacks): Promise<void>;
  logout(provider: string): void;
  getApiKeyProviders(): Array<{ id: string; name: string }>;
  setApiKey(providerId: string, apiKey: string): void;
  clearApiKey(providerId: string): void;
  hasApiKey(providerId: string): boolean;
  getApiKey(providerId: string): Promise<string | undefined>;
  get(providerId: string): { type?: string; key?: string } | undefined;
}

interface ReadFallbackAuthStorage {
  reload(): void;
  hasAuth(provider: string): boolean;
  getApiKey(providerId: string): Promise<string | undefined>;
  get(providerId: string): StoredCredential | undefined;
  getAll(): Record<string, StoredCredential>;
  list(): string[];
}

type StoredCredential = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
};

/**
 * Provider IDs that should be treated as OAuth-backed by the upstream
 * pi-coding-agent AuthStorage but which Fusion reclassifies as API-key
 * providers.  These IDs are stripped from getOAuthProviders() results so
 * the dashboard never offers a browser-based OAuth login for them.
 */
const OAUTH_TO_API_KEY_RECLASSIFICATIONS: ReadonlySet<string> = new Set([
  "anthropic",
]);

const BUILT_IN_API_KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: "anthropic", name: "Anthropic" },
  { id: "brave", name: "Brave Search" },
  { id: "kimi-coding", name: "Kimi" },
  { id: "minimax", name: "Minimax" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "tavily", name: "Tavily" },
  { id: "zai", name: "Zai" },
];

const CLI_PROVIDER_IDS = new Set(["pi-claude-cli", "droid-cli"]);

function getProviderDisplayName(providerId: string): string {
  const knownProviderNames = new Map(
    BUILT_IN_API_KEY_PROVIDERS.map((provider) => [provider.id, provider.name]),
  );

  const knownName = knownProviderNames.get(providerId);
  if (knownName) return knownName;

  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function wrapAuthStorageWithApiKeyProviders(
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  readFallbackAuthStorages: ReadFallbackAuthStorage[] = [],
): DashboardAuthStorage {
  const mergedAuthStorage = mergeAuthStorageReads(authStorage, readFallbackAuthStorages);

  return {
    reload: () => mergedAuthStorage.reload(),
    getOAuthProviders: () =>
      mergedAuthStorage
        .getOAuthProviders()
        .filter((provider) => !OAUTH_TO_API_KEY_RECLASSIFICATIONS.has(provider.id))
        .map((provider) => ({ id: provider.id, name: provider.name })),
    hasAuth: (provider) => mergedAuthStorage.hasAuth(provider),
    login: (providerId, callbacks) =>
      mergedAuthStorage.login(providerId as Parameters<AuthStorage["login"]>[0], callbacks),
    logout: (provider) => mergedAuthStorage.logout(provider),
    getApiKeyProviders: () => {
      // Use the reclassified (filtered) OAuth provider list so that providers
      // moved to API-key (e.g. anthropic) are not skipped by the OAuth dedup.
      const oauthProviderIds = new Set(
        mergedAuthStorage
          .getOAuthProviders()
          .filter((provider) => !OAUTH_TO_API_KEY_RECLASSIFICATIONS.has(provider.id))
          .map((provider) => provider.id),
      );
      const providers = new Map<string, string>();

      for (const provider of BUILT_IN_API_KEY_PROVIDERS) {
        if (!oauthProviderIds.has(provider.id)) {
          providers.set(provider.id, provider.name);
        }
      }

      for (const model of modelRegistry.getAll()) {
        const providerId = model.provider;
        if (
          !providerId ||
          oauthProviderIds.has(providerId) ||
          providers.has(providerId) ||
          CLI_PROVIDER_IDS.has(providerId)
        ) {
          continue;
        }
        providers.set(providerId, getProviderDisplayName(providerId));
      }

      return Array.from(providers, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    setApiKey: (providerId, apiKey) => {
      mergedAuthStorage.set(providerId, { type: "api_key", key: apiKey });
    },
    clearApiKey: (providerId) => {
      mergedAuthStorage.remove(providerId);
    },
    hasApiKey: (providerId) => {
      const credential = mergedAuthStorage.get(providerId);
      return credential?.type === "api_key" && !!credential.key;
    },
    getApiKey: (providerId) => mergedAuthStorage.getApiKey(providerId),
    get: (providerId) => mergedAuthStorage.get(providerId),
  };
}

export function mergeAuthStorageReads(
  authStorage: AuthStorage,
  readFallbackAuthStorages: ReadFallbackAuthStorage[] = [],
): AuthStorage {
  const readAuthStorages = [authStorage, ...readFallbackAuthStorages];
  const getCredential = (providerId: string) => {
    for (const storage of readAuthStorages) {
      const credential = storage.get(providerId);
      if (credential) return credential;
    }
    return undefined;
  };

  return new Proxy(authStorage, {
    get(target, prop, receiver) {
      if (prop === "reload") {
        return () => {
          for (const storage of readAuthStorages) {
            storage.reload();
          }
        };
      }

      if (prop === "get") {
        return getCredential;
      }

      if (prop === "has") {
        return (provider: string) => readAuthStorages.some((storage) => Boolean(storage.get(provider)));
      }

      if (prop === "hasAuth") {
        return (provider: string) => readAuthStorages.some((storage) => storage.hasAuth(provider));
      }

      if (prop === "getAll") {
        return () => ({
          ...readFallbackAuthStorages.reduce(
            (merged, storage) => ({ ...merged, ...storage.getAll() }),
            {} as Record<string, { type?: string; key?: string }>,
          ),
          ...target.getAll(),
        });
      }

      if (prop === "list") {
        return () => Array.from(new Set(readAuthStorages.flatMap((storage) => storage.list())));
      }

      if (prop === "getApiKey") {
        return async (providerId: string) => {
          for (const storage of readAuthStorages) {
            const apiKey = await storage.getApiKey(providerId);
            if (apiKey) return apiKey;
          }
          return undefined;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}

function resolveStoredApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return process.env[key] ?? key;
}

function resolveOAuthApiKey(providerId: string, credential: StoredCredential): string | undefined {
  if (
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    typeof credential.refresh !== "string" ||
    typeof credential.expires !== "number" ||
    Date.now() >= credential.expires
  ) {
    return undefined;
  }

  return getOAuthProvider(providerId)?.getApiKey(credential as OAuthCredentials);
}

function resolveStoredCredentialApiKey(providerId: string, credential: StoredCredential | undefined): string | undefined {
  if (credential?.type === "api_key") {
    return resolveStoredApiKey(credential.key);
  }
  if (credential?.type === "oauth") {
    return resolveOAuthApiKey(providerId, credential);
  }
  return undefined;
}

export function createReadOnlyAuthFileStorage(authPaths: string[]): ReadFallbackAuthStorage {
  let credentials: Record<string, StoredCredential> = {};

  const reload = () => {
    const nextCredentials: Record<string, StoredCredential> = {};
    for (const authPath of authPaths) {
      if (!existsSync(authPath)) {
        continue;
      }
      try {
        const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, StoredCredential>;
        for (const [provider, credential] of Object.entries(parsed)) {
          nextCredentials[provider] ??= credential;
        }
      } catch {
        // Ignore unreadable legacy auth files and continue with other candidates.
      }
    }
    credentials = nextCredentials;
  };

  reload();

  return {
    reload,
    hasAuth: (provider) => Boolean(credentials[provider]),
    get: (provider) => credentials[provider],
    getAll: () => ({ ...credentials }),
    list: () => Object.keys(credentials),
    getApiKey: async (provider) => {
      return resolveStoredCredentialApiKey(provider, credentials[provider]);
    },
  };
}
