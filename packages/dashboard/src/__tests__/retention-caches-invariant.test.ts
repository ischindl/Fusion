import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/*
FNXC:RetentionCensus 2026-09-21-23:40 (RUFU-257):
The leak this task closes was invisible rather than unfixable: heap grew and nothing in the dashboard
could say which structure held it. These cases are the invariants the fix must keep holding:
1. Every bounded module-scope collection is registered in the census under a named ceiling, and the
   registered set equals the list below — a new unregistered cache is a coverage hole, and a retired id
   left in this list is a stale claim. Both fail loudly here and in `scripts/check-retention-coverage.mjs`.
2. The census explains its own numbers: bytes, ratio, and residual are reported, and a probe that
   throws is surfaced instead of reading as zero.
3. A still-valid credential is never reclaimed by a memory-pressure sweep. The issued-token table is
   the one bounded map whose entries are security state, so its ceiling reports pressure instead of
   signing clients out, and expiry reclamation only ever drops strictly-past-expiry tokens.
*/
import { CHAT_RATE_LIMIT_IP_MAX, __resetChatState, checkRateLimit, getRateLimitResetTime } from "../chat.js";
import {
  MAX_SHORT_LIVED_TOKENS,
  __resetRemoteAuthStateForTests,
  issueRemoteAuthToken,
  purgeExpiredRemoteShortLivedTokens,
  validateRemoteAuthToken,
} from "../remote-auth.js";
import { listRetentionSourceIds, retentionCensusSnapshot } from "../lib/retention-census.js";
import type { RemoteAccessSettings } from "@fusion/core";

/*
 * Every module-scope collection this task bounded. Owning-module import below is what registers a row,
 * so importing a module here is load-bearing: it is how the census becomes complete.
 */
import "../agent-onboarding.js";
import "../agent-generation.js";
import "../planning.js";
import "../terminal-service.js";
import "../ai-refine.js";
import "../ai-translate.js";
import "../ai-task-search.js";
import "../milestone-slice-interview.js";
import "../mission-interview.js";
import "../lib/codebase-metrics.js";
import "../knowledge-graph-access.js";
import "../routes/register-voice-routes.js";
import "../routes/register-workflow-routes.js";
import "../routes/register-session-diff-routes.js";

/**
 * The coverage inventory. Adding a bounded collection means adding its id here (the CI ratchet in
 * Step 4 checks the same thing against the source, so this list cannot quietly drift behind it).
 */
const EXPECTED_BOUNDED_SOURCES = [
  "agent_onboarding_sessions",
  "agent_onboarding_active_generations",
  "agent_generation_sessions",
  "agent_generation_rate_limits",
  "planning_sessions",
  "planning_rate_limits",
  "planning_active_generations",
  "planning_turn_reservations",
  "planning_settling_turn_operations",
  "planning_persistence_queues",
  "terminal_service_registry",
  "terminal_output_buffers",
  "chat_rate_limits",
  "ai_refine_rate_limits",
  "ai_translate_rate_limits",
  "ai_task_search_rate_windows",
  "ai_task_search_project_concurrency",
  "milestone_interview_sessions",
  "milestone_interview_rate_limits",
  "mission_interview_sessions",
  "mission_interview_rate_limits",
  "voice_sessions",
  "voice_pending_session_reservations",
  "session_files",
  "file_diffs",
  "task_diff_stats",
  "workflow_design_rate_limits",
  "remote_auth_short_lived_tokens",
  "codebase_metrics",
  "knowledge_graph_artifacts",
  "knowledge_graph_rebuilds",
].sort();

/** Longer than every rate-limit window in the package. */
const PAST_EVERY_WINDOW_MS = 25 * 60 * 60 * 1_000;

const SHORT_LIVED_TTL_MS = 900_000;

function shortLivedSettings(): RemoteAccessSettings {
  return {
    activeProvider: "cloudflare",
    providers: { cloudflare: { enabled: true } },
    tokenStrategy: {
      persistent: { enabled: false, token: "" },
      shortLived: { enabled: true, ttlMs: SHORT_LIVED_TTL_MS },
    },
  } as unknown as RemoteAccessSettings;
}

describe("retention census coverage", () => {
  beforeEach(() => {
    // The rate-limit windows compare against `Date.now()`, so "advance the clock" means fake timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers exactly the bounded surfaces this task accounts for", () => {
    expect(listRetentionSourceIds().slice().sort()).toEqual(EXPECTED_BOUNDED_SOURCES);
  });

  it("declares a named ceiling for every registered source", () => {
    const rows = retentionCensusSnapshot().sources;
    expect(rows.length).toBeGreaterThan(0);

    // A ceiling with no name cannot be reviewed, and the coverage ratchet resolves it by name.
    const unnamed = rows.filter((row) => row.ceiling === null || row.ceilingConstant === null).map((row) => row.id);
    expect(unnamed).toEqual([]);
  });

  it("reports tracked bytes, coverage ratio, and an honest residual under applied load", () => {
    __resetChatState();
    for (let i = 0; i < 1_000; i++) {
      checkRateLimit(`198.51.${Math.floor(i / 251)}.${(i % 251) + 1}`);
    }

    const snapshot = retentionCensusSnapshot();
    const loaded = snapshot.sources.filter((row) => row.entries > 0);

    // The census names the source holding the load — that is the whole point of the instrument.
    expect(loaded.map((row) => row.id)).toContain("chat_rate_limits");
    expect(snapshot.trackedBytes).toBeGreaterThan(0);
    expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.coverageRatio).toBeGreaterThan(0);
    expect(snapshot.coverageRatio).toBeLessThanOrEqual(1);
    expect(snapshot.residualBytes).toBeGreaterThanOrEqual(0);
    // A probe that throws must be reported, never silently read as zero.
    expect(snapshot.probeFailureCount).toBe(0);
  });

  it("reclaims an expired chat window on the next sample and preserves a live address", () => {
    __resetChatState();
    for (let i = 0; i < 1_000; i++) {
      checkRateLimit(`192.0.2.${Math.floor(i / 251)}.${(i % 251) + 1}`);
    }

    const loaded = retentionCensusSnapshot();
    expect(loaded.sources.find((row) => row.id === "chat_rate_limits")!.entries).toBe(1_000);

    vi.advanceTimersByTime(PAST_EVERY_WINDOW_MS);
    checkRateLimit("203.0.113.7");

    // `chat.ts` owns no cleanup timer, so the census sweep is the only reclamation owner here.
    const swept = retentionCensusSnapshot().sources.find((row) => row.id === "chat_rate_limits");
    expect(swept!.entries).toBe(1);
    expect(swept!.expiredEntries).toBe(0);
    expect(getRateLimitResetTime("203.0.113.7")).toBeInstanceOf(Date);
  });
});

describe("remote short-lived token table is pressure-thresholded, not evicted", () => {
  const settings = shortLivedSettings();

  beforeEach(() => {
    __resetRemoteAuthStateForTests();
  });

  it("keeps honouring live tokens past its reporting ceiling", () => {
    // Real wall clock: these tokens must still be un-expired when the census sample runs, or the
    // expiry sweep (correctly) reclaims them and the case tests nothing about live retention.
    const nowMs = Date.now();
    const issued: string[] = [];

    for (let i = 0; i < MAX_SHORT_LIVED_TOKENS + 250; i++) {
      issued.push(issueRemoteAuthToken("short-lived", settings, nowMs).token);
    }

    const row = retentionCensusSnapshot().sources.find(
      (source) => source.id === "remote_auth_short_lived_tokens",
    );

    expect(row).toBeDefined();
    expect(row!.atCeiling).toBe(true);
    // The ceiling must not sign clients out: every token above the threshold still validates.
    expect(row!.entries).toBe(MAX_SHORT_LIVED_TOKENS + 250);
    for (const token of issued.slice(-5)) {
      expect(validateRemoteAuthToken(token, settings, nowMs).status).toBe("valid");
    }
  });

  it("drops only strictly-past-expiry tokens and still honours a token at its expiry instant", () => {
    const issuedAt = Date.now();
    const live = issueRemoteAuthToken("short-lived", settings, issuedAt).token;
    const stale = issueRemoteAuthToken("short-lived", settings, issuedAt - SHORT_LIVED_TTL_MS - 1).token;
    const atLiveExpiry = issuedAt + SHORT_LIVED_TTL_MS;

    // Past its instant the token is refused, but the table still knows it — the sweep has not run.
    expect(validateRemoteAuthToken(stale, settings, atLiveExpiry).status).toBe("expired");

    // Sweep at exactly the live token's expiry instant; the validator's own rule is `now > expiry`.
    purgeExpiredRemoteShortLivedTokens(atLiveExpiry);

    expect(validateRemoteAuthToken(live, settings, atLiveExpiry).status).toBe("valid");
    // A reclaimed token is unknown rather than expired: it must never read as valid either way.
    expect(validateRemoteAuthToken(stale, settings, atLiveExpiry).status).toBe("invalid");

    const row = retentionCensusSnapshot().sources.find(
      (source) => source.id === "remote_auth_short_lived_tokens",
    );
    expect(row!.entries).toBe(1);
    expect(row!.expiredEntries).toBe(0);
  });
});
