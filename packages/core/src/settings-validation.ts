import type {
  DirectMergeCommitStrategy,
  GithubAuthMode,
  HeartbeatPromptTemplate,
  HeartbeatScopeDisciplineMode,
  Locale,
  SandboxBackendName,
  SandboxFailureMode,
  SandboxPolicy,
  SandboxProjectSettings,
  UnavailableNodePolicy,
} from "./types.js";
import { isLocale } from "./types.js";

const UNAVAILABLE_NODE_POLICIES: readonly UnavailableNodePolicy[] = ["block", "fallback-local"] as const;
const DIRECT_MERGE_COMMIT_STRATEGIES: readonly DirectMergeCommitStrategy[] = ["auto", "always-squash", "always-rebase"] as const;
const GITHUB_AUTH_MODES: readonly GithubAuthMode[] = ["gh-cli", "token"] as const;
const GITHUB_REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const HEARTBEAT_SCOPE_DISCIPLINE_MODES: readonly HeartbeatScopeDisciplineMode[] = [
  "strict",
  "lite",
  "off",
] as const;
const HEARTBEAT_PROMPT_TEMPLATES: readonly HeartbeatPromptTemplate[] = [
  "default",
  "compact",
] as const;

export const SANDBOX_BACKEND_NAMES: readonly SandboxBackendName[] = [
  "native",
  "sandbox-exec",
  "bubblewrap",
  "docker",
  "podman",
  "custom",
] as const;

export const SANDBOX_FAILURE_MODES: readonly SandboxFailureMode[] = ["fail-hard", "fallback-native"] as const;

/**
 * Validates a project unavailable-node routing policy value.
 *
 * Returns the normalized policy value when valid, otherwise undefined.
 */
export function validateUnavailableNodePolicy(value: unknown): UnavailableNodePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (UNAVAILABLE_NODE_POLICIES as readonly string[]).includes(value)
    ? (value as UnavailableNodePolicy)
    : undefined;
}

/** Returns a validated UI locale for global settings, otherwise undefined. */
export function validateLocale(value: unknown): Locale | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isLocale(value) ? value : undefined;
}

/** Returns a validated direct-merge commit strategy for project settings, otherwise undefined. */
export function validateDirectMergeCommitStrategy(value: unknown): DirectMergeCommitStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (DIRECT_MERGE_COMMIT_STRATEGIES as readonly string[]).includes(value)
    ? (value as DirectMergeCommitStrategy)
    : undefined;
}

/** Returns a validated GitHub auth mode for project settings, otherwise undefined. */
export function validateGithubAuthMode(value: unknown): GithubAuthMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (GITHUB_AUTH_MODES as readonly string[]).includes(value) ? (value as GithubAuthMode) : undefined;
}

/** Returns a validated owner/repo GitHub slug, otherwise undefined. Empty string is treated as unset. */
export function validateGithubRepoSlug(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return GITHUB_REPO_SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Returns a validated heartbeat scope-discipline mode for project/agent settings, otherwise undefined. */
export function validateHeartbeatScopeDisciplineMode(value: unknown): HeartbeatScopeDisciplineMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (HEARTBEAT_SCOPE_DISCIPLINE_MODES as readonly string[]).includes(value)
    ? (value as HeartbeatScopeDisciplineMode)
    : undefined;
}

/** Returns a validated heartbeat prompt template for project/agent settings, otherwise undefined. */
export function validateHeartbeatPromptTemplate(value: unknown): HeartbeatPromptTemplate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (HEARTBEAT_PROMPT_TEMPLATES as readonly string[]).includes(value)
    ? (value as HeartbeatPromptTemplate)
    : undefined;
}

/** Returns a validated sandbox backend name for project settings, otherwise undefined. */
export function validateSandboxBackendName(value: unknown): SandboxBackendName | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (SANDBOX_BACKEND_NAMES as readonly string[]).includes(value) ? (value as SandboxBackendName) : undefined;
}

/** Returns a validated sandbox failure mode for project settings, otherwise undefined. */
export function validateSandboxFailureMode(value: unknown): SandboxFailureMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (SANDBOX_FAILURE_MODES as readonly string[]).includes(value) ? (value as SandboxFailureMode) : undefined;
}

/** Returns a validated sandbox policy object for project settings, otherwise undefined. */
export function validateSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const raw = value as { allowNetwork?: unknown; allowedPaths?: unknown };
  const policy: SandboxPolicy = {};

  if (typeof raw.allowNetwork === "boolean") {
    policy.allowNetwork = raw.allowNetwork;
  }

  if (Array.isArray(raw.allowedPaths)) {
    const candidatePaths = raw.allowedPaths;
    const hasOnlyValidPaths = candidatePaths.every(
      (entry) => typeof entry === "string" && entry.length > 0 && !entry.includes("..") && !entry.startsWith("~"),
    );
    if (hasOnlyValidPaths) {
      policy.allowedPaths = candidatePaths as string[];
    }
  }

  if (policy.allowNetwork === undefined && policy.allowedPaths === undefined) {
    return undefined;
  }
  return policy;
}

/** Returns validated sandbox project settings, otherwise undefined. */
export function validateSandboxProjectSettings(value: unknown): SandboxProjectSettings | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }

  const raw = value as {
    backend?: unknown;
    policy?: unknown;
    failureMode?: unknown;
  };

  const backend = validateSandboxBackendName(raw.backend);
  const policy = validateSandboxPolicy(raw.policy);
  const failureMode = validateSandboxFailureMode(raw.failureMode);

  if (backend === undefined && policy === undefined && failureMode === undefined) {
    return undefined;
  }

  return {
    ...(backend !== undefined ? { backend } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(failureMode !== undefined ? { failureMode } : {}),
  };
}
