import { randomBytes, timingSafeEqual } from "node:crypto";
import type { GlobalSettings } from "@fusion/core";
import { AGGREGATE_RECORD_BYTES } from "./lib/retention-census.js";
import { registerBoundedWindowMap } from "./lib/retention/bounded-window-map.js";

export type RemoteTokenValidationStatus = "valid" | "missing" | "invalid" | "expired" | "disabled";
export type RemoteTokenType = "persistent" | "short-lived";

type RemoteAccessSettings = NonNullable<GlobalSettings["remoteAccess"]>;

interface ShortLivedTokenEntry {
  expiresAtMs: number;
  issuedAtMs: number;
}

export interface RemoteTokenValidationResult {
  status: RemoteTokenValidationStatus;
  tokenType?: RemoteTokenType;
  expiresAt?: string;
}

export interface IssueRemoteTokenResult {
  token: string;
  tokenType: RemoteTokenType;
  expiresAt?: string;
}

const DEFAULT_SHORT_LIVED_TTL_MS = 900_000;
const MIN_SHORT_LIVED_TTL_MS = 60_000;
const MAX_SHORT_LIVED_TTL_MS = 86_400_000;

const shortLivedTokens = new Map<string, ShortLivedTokenEntry>();

/**
 * Reporting ceiling for simultaneously live short-lived tokens.
 *
 * FNXC:RetentionCensus 2026-09-21-21:40 (RUFU-257): this table is a security state store, so the
 * deletion rule and the count rule are deliberately different. Expiry reclamation is real deletion
 * and is now owned by the census sample: previously a token was only purged when some later request
 * happened to call issue or validate, so a table that stopped receiving traffic retained every token
 * issued before it stopped — the traffic-gated-deletion half of this task's leak class. Count is a
 * threshold that only reports (`at_ceiling` on `/metrics`), because evicting an unexpired token would
 * sign out a live client to relieve pressure that is itself the symptom, not the cause. A strictly
 * past-expiry token never validates, so reclaiming it cannot change an authentication outcome.
 */
export const MAX_SHORT_LIVED_TOKENS = 2_000;

/*
FNXC:RetentionCensus 2026-09-21-22:40 (RUFU-257):
ONE expiry predicate, shared by this module's own purge and the census sweep, mirroring the
validator: a short-lived token is refused when `nowMs > effectiveExpiryMs`, so the expiry instant
itself is still valid. Reclamation is therefore strictly-past-only — deleting at `<=` would retire a
row the validator would still authenticate, turning a memory bound into a sign-out.
*/
export function remoteShortLivedTokenIsExpired(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs < nowMs;
}

registerBoundedWindowMap<string, ShortLivedTokenEntry>({
  id: "remote_auth_short_lived_tokens",
  map: shortLivedTokens,
  ceiling: MAX_SHORT_LIVED_TOKENS,
  ceilingConstant: "MAX_SHORT_LIVED_TOKENS",
  kind: "token-store",
  expiryOf: (entry) => entry.expiresAtMs,
  isExpired: remoteShortLivedTokenIsExpired,
  // Report-only ceiling: a live credential is never an eviction candidate.
  evictLiveEntries: false,
  // The row is two numbers; the token-hash KEY string is already attributed by the helper, so no
  // value-side string term belongs here.
  valueBytes: () => AGGREGATE_RECORD_BYTES,
});

export function constantTimeEqual(provided: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuffer.length) {
    return false;
  }

  try {
    const providedBuffer = Buffer.from(provided, "utf8");
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function generateRemoteToken(): string {
  return `frt_${randomBytes(20).toString("base64url")}`;
}

export function maskRemoteToken(token: string): string {
  if (token.length <= 8) {
    return "********";
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function resolveEffectiveShortLivedTtlMs(settings: RemoteAccessSettings): number {
  const configured = Number(settings.tokenStrategy.shortLived.ttlMs ?? DEFAULT_SHORT_LIVED_TTL_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_SHORT_LIVED_TTL_MS;
  }

  const maxConfigured = Number(settings.tokenStrategy.shortLived.maxTtlMs ?? MAX_SHORT_LIVED_TTL_MS);
  const boundedMax = Number.isFinite(maxConfigured)
    ? Math.min(Math.max(maxConfigured, MIN_SHORT_LIVED_TTL_MS), MAX_SHORT_LIVED_TTL_MS)
    : MAX_SHORT_LIVED_TTL_MS;

  return Math.min(Math.max(configured, MIN_SHORT_LIVED_TTL_MS), boundedMax);
}

export function issueRemoteAuthToken(
  mode: RemoteTokenType,
  settings: RemoteAccessSettings,
  nowMs: number = Date.now(),
): IssueRemoteTokenResult {
  purgeExpiredRemoteShortLivedTokens(nowMs);
  if (mode === "persistent") {
    const persistentToken = settings.tokenStrategy.persistent.token;
    if (!settings.tokenStrategy.persistent.enabled || !persistentToken) {
      throw new Error("Persistent remote token is not configured");
    }

    return {
      token: persistentToken,
      tokenType: "persistent",
    };
  }

  if (!settings.tokenStrategy.shortLived.enabled) {
    throw new Error("Short-lived token mode is disabled");
  }

  const ttlMs = resolveEffectiveShortLivedTtlMs(settings);
  const token = generateRemoteToken();
  const expiresAtMs = nowMs + ttlMs;

  shortLivedTokens.set(token, { expiresAtMs, issuedAtMs: nowMs });

  return {
    token,
    tokenType: "short-lived",
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function isRemoteAccessTokenStrategyEnabled(settings: RemoteAccessSettings): boolean {
  return settings.tokenStrategy.persistent.enabled || settings.tokenStrategy.shortLived.enabled;
}

function isRemoteProviderEnabled(settings: RemoteAccessSettings): boolean {
  return Boolean(settings.activeProvider != null && settings.providers[settings.activeProvider]?.enabled);
}

export function validateRemoteAuthToken(
  rt: string | null | undefined,
  settings: RemoteAccessSettings,
  nowMs: number = Date.now(),
): RemoteTokenValidationResult {
  if (!isRemoteProviderEnabled(settings) || !isRemoteAccessTokenStrategyEnabled(settings)) {
    return { status: "disabled" };
  }

  if (!rt) {
    return { status: "missing" };
  }

  const persistent = settings.tokenStrategy.persistent;
  if (persistent.enabled && persistent.token && constantTimeEqual(rt, persistent.token)) {
    return { status: "valid", tokenType: "persistent" };
  }

  const shortLived = settings.tokenStrategy.shortLived;
  const issued = shortLivedTokens.get(rt);
  if (shortLived.enabled && issued) {
    const ttlMs = resolveEffectiveShortLivedTtlMs(settings);
    const configuredExpiryMs = issued.issuedAtMs + ttlMs;
    const effectiveExpiryMs = Math.min(issued.expiresAtMs, configuredExpiryMs);
    if (nowMs > effectiveExpiryMs) {
      shortLivedTokens.delete(rt);
      return {
        status: "expired",
        tokenType: "short-lived",
        expiresAt: new Date(effectiveExpiryMs).toISOString(),
      };
    }

    return {
      status: "valid",
      tokenType: "short-lived",
      expiresAt: new Date(effectiveExpiryMs).toISOString(),
    };
  }

  return { status: "invalid" };
}

export function purgeExpiredRemoteShortLivedTokens(nowMs: number = Date.now()): void {
  for (const [token, entry] of shortLivedTokens.entries()) {
    if (remoteShortLivedTokenIsExpired(entry.expiresAtMs, nowMs)) {
      shortLivedTokens.delete(token);
    }
  }
}

export function __resetRemoteAuthStateForTests(): void {
  shortLivedTokens.clear();
}
