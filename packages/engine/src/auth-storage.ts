import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

type StoredCredential = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
};

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function getFusionAuthPath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "auth.json");
}

export function getFusionModelsPath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "models.json");
}

function getLegacyAuthPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];
}

function getLegacyModelsPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".pi", "agent", "models.json"),
    join(home, ".pi", "models.json"),
  ];
}

export function getModelRegistryModelsPath(home = getHomeDir()): string {
  const fusionModelsPath = getFusionModelsPath(home);
  if (existsSync(fusionModelsPath)) {
    return fusionModelsPath;
  }

  return getLegacyModelsPaths(home).find((modelsPath) => existsSync(modelsPath)) ?? fusionModelsPath;
}

function readLegacyCredentials(authPaths = getLegacyAuthPaths()): Record<string, StoredCredential> {
  const credentials: Record<string, StoredCredential> = {};

  for (const authPath of authPaths) {
    if (!existsSync(authPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, StoredCredential>;
      for (const [provider, credential] of Object.entries(parsed)) {
        credentials[provider] ??= credential;
      }
    } catch {
      // Ignore invalid legacy auth files and continue with other candidates.
    }
  }

  return credentials;
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

/**
 * Reads API keys from the resolved models.json file.
 *
 * Some providers (e.g., kimi-coding, lmstudio, ollama) store their API keys
 * in `models.json` under `providers.<providerId>.apiKey` rather than in
 * `auth.json`. This function extracts those keys so the auth storage proxy
 * can return them as a fallback when neither Fusion auth nor legacy auth.json
 * contains a key for the provider.
 */
function readModelsJsonApiKeys(home = getHomeDir()): Map<string, string> {
  const apiKeys = new Map<string, string>();
  const modelsPath = getModelRegistryModelsPath(home);

  if (!existsSync(modelsPath)) {
    return apiKeys;
  }

  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const providers = parsed?.providers;
    if (providers) {
      for (const [providerId, config] of Object.entries(providers)) {
        if (config.apiKey) {
          apiKeys.set(providerId, config.apiKey);
        }
      }
    }
  } catch {
    // Ignore invalid models.json files.
  }

  return apiKeys;
}

export function createFusionAuthStorage(): AuthStorage {
  const primary = AuthStorage.create(getFusionAuthPath());
  let legacyCredentials = readLegacyCredentials();
  // models.json provider API keys — third fallback after primary auth and legacy auth.json
  let modelsJsonApiKeys = readModelsJsonApiKeys();

  return new Proxy(primary, {
    // Forward property writes to the target so that methods like
    // `setFallbackResolver` (called by ModelRegistry) correctly update the
    // underlying AuthStorage. Without this trap, writes land on the Proxy
    // object itself and the target's fallbackResolver stays undefined.
    set(target: AuthStorage, prop: string | symbol, value: unknown) {
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },

    get(target, prop, receiver) {
      if (prop === "reload") {
        return () => {
          target.reload();
          legacyCredentials = readLegacyCredentials();
          modelsJsonApiKeys = readModelsJsonApiKeys();
        };
      }

      if (prop === "get") {
        return (provider: string) => target.get(provider) ?? legacyCredentials[provider];
      }

      if (prop === "has") {
        return (provider: string) => target.has(provider) || provider in legacyCredentials || modelsJsonApiKeys.has(provider);
      }

      if (prop === "hasAuth") {
        return (provider: string) => target.hasAuth(provider) || Boolean(legacyCredentials[provider]) || modelsJsonApiKeys.has(provider);
      }

      if (prop === "getAll") {
        return () => ({ ...legacyCredentials, ...target.getAll() });
      }

      if (prop === "list") {
        return () => Array.from(new Set([...Object.keys(legacyCredentials), ...target.list(), ...modelsJsonApiKeys.keys()]));
      }

      if (prop === "getApiKey") {
        return async (provider: string) => {
          // 1. Primary Fusion auth
          const primaryKey = await target.getApiKey(provider);
          if (primaryKey) return primaryKey;

          // 2. Legacy auth.json credentials
          const legacyKey = resolveStoredCredentialApiKey(provider, legacyCredentials[provider]);
          if (legacyKey) return legacyKey;

          // 3. models.json provider API keys (e.g., kimi-coding, lmstudio)
          return modelsJsonApiKeys.get(provider);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}
