import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/*
FNXC:RetentionCensus 2026-09-21-23:25 (RUFU-257):
Every module that rate-limits by client address keyed its window map by that address and bounded
nothing: the map grew one permanent entry per distinct IP that ever connected. `chat.ts` had no
sweep at all, the others deleted expired rows only on their own cleanup interval, and none of them
capped how many entries could exist while nobody looked. These cases are the shared parametrized
proof from the spec over every one of those surfaces: 1 000 distinct addresses stay inside the named
ceiling, an advanced clock reclaims them to zero, and a live address is still tracked and still
answered with a reset time.
*/
import {
  CHAT_RATE_LIMIT_IP_MAX,
  __resetChatState,
  checkRateLimit as hitChatRateLimit,
  getRateLimitResetTime as chatRateLimitResetTime,
} from "../chat.js";
import {
  PLANNING_RATE_LIMIT_IP_MAX,
  __resetPlanningState,
  __runPlanningCleanupForTests,
  checkRateLimit as hitPlanningRateLimit,
  getRateLimitResetTime as planningRateLimitResetTime,
} from "../planning.js";
import {
  AGENT_GENERATION_RATE_LIMIT_IP_MAX,
  __resetAgentGenerationState,
  __runAgentGenerationCleanupForTests,
  checkRateLimit as hitAgentGenerationRateLimit,
  getRateLimitResetTime as agentGenerationRateLimitResetTime,
} from "../agent-generation.js";
import {
  REFINE_RATE_LIMIT_IP_MAX,
  __resetRefineState,
  __runRefineRateLimitCleanupForTests,
  checkRateLimit as hitRefineRateLimit,
  getRateLimitResetTime as refineRateLimitResetTime,
} from "../ai-refine.js";
import {
  TRANSLATE_RATE_LIMIT_IP_MAX,
  checkTranslateRateLimit,
  getTranslateRateLimitResetTime,
  resetTranslateRateLimits,
} from "../ai-translate.js";
import {
  AI_TASK_SEARCH_RATE_WINDOW_IP_MAX,
  __resetAiTaskSearchStateForTests,
  checkAiTaskSearchRateLimit,
  getAiTaskSearchRateLimitResetTime,
} from "../ai-task-search.js";
import {
  MILESTONE_INTERVIEW_RATE_LIMIT_IP_MAX,
  __resetMilestoneSliceInterviewState,
  __runMilestoneInterviewCleanupForTests,
  checkRateLimit as hitMilestoneInterviewRateLimit,
  getRateLimitResetTime as milestoneInterviewRateLimitResetTime,
} from "../milestone-slice-interview.js";
import {
  MISSION_INTERVIEW_RATE_LIMIT_IP_MAX,
  __resetMissionInterviewState,
  __runMissionInterviewCleanupForTests,
  checkRateLimit as hitMissionInterviewRateLimit,
  getRateLimitResetTime as missionInterviewRateLimitResetTime,
} from "../mission-interview.js";
import { DESIGN_RATE_LIMIT_IP_MAX } from "../routes/register-workflow-routes.js";
import { retentionCensusSnapshot, type RetentionSourceSnapshot } from "../lib/retention-census.js";

/** Spec reproduction size: enough distinct addresses to be a leak, small enough to stay a unit test. */
const DISTINCT_ADDRESSES = 1_000;

/** Longer than every rate-limit window and every session TTL in the package. */
const PAST_EVERY_WINDOW_MS = 25 * 60 * 60 * 1_000;

const LIVE_IP = "203.0.113.7";

/** Stable, distinct IPv4 literals — the maps key on the address string, nothing else. */
function ipAt(index: number): string {
  return `10.${(index >> 8) & 0xff}.${index & 0xff}.${(index % 251) + 1}`;
}

/**
 * One row per IP-keyed window map. `reclaim` is present when the owning module keeps deletion on its
 * own timer: the census then accounts for the map but must not delete from it, and a faked clock
 * cannot fire an interval that was armed with real timers at import.
 */
interface IpKeyedSurface {
  sourceId: string;
  ceiling: number;
  reset: () => void;
  hit: (ip: string) => unknown;
  resetTime: (ip: string) => Date | null;
  reclaim?: () => void;
}

const AI_TASK_SEARCH_PROJECT = "proj-retention";

const IP_KEYED_SURFACES: IpKeyedSurface[] = [
  {
    sourceId: "chat_rate_limits",
    ceiling: CHAT_RATE_LIMIT_IP_MAX,
    reset: () => __resetChatState(),
    hit: (ip) => hitChatRateLimit(ip),
    resetTime: (ip) => chatRateLimitResetTime(ip),
  },
  {
    sourceId: "planning_rate_limits",
    ceiling: PLANNING_RATE_LIMIT_IP_MAX,
    reset: () => __resetPlanningState(),
    hit: (ip) => hitPlanningRateLimit(ip),
    resetTime: (ip) => planningRateLimitResetTime(ip),
    reclaim: () => __runPlanningCleanupForTests(),
  },
  {
    sourceId: "agent_generation_rate_limits",
    ceiling: AGENT_GENERATION_RATE_LIMIT_IP_MAX,
    reset: () => __resetAgentGenerationState(),
    hit: (ip) => hitAgentGenerationRateLimit(ip),
    resetTime: (ip) => agentGenerationRateLimitResetTime(ip),
    reclaim: () => __runAgentGenerationCleanupForTests(),
  },
  {
    sourceId: "ai_refine_rate_limits",
    ceiling: REFINE_RATE_LIMIT_IP_MAX,
    reset: () => __resetRefineState(),
    hit: (ip) => hitRefineRateLimit(ip),
    resetTime: (ip) => refineRateLimitResetTime(ip),
    reclaim: () => __runRefineRateLimitCleanupForTests(),
  },
  {
    sourceId: "ai_translate_rate_limits",
    ceiling: TRANSLATE_RATE_LIMIT_IP_MAX,
    reset: () => resetTranslateRateLimits(),
    hit: (ip) => checkTranslateRateLimit(ip),
    resetTime: (ip) => getTranslateRateLimitResetTime(ip),
  },
  {
    sourceId: "ai_task_search_rate_windows",
    ceiling: AI_TASK_SEARCH_RATE_WINDOW_IP_MAX,
    reset: () => __resetAiTaskSearchStateForTests(),
    hit: (ip) => checkAiTaskSearchRateLimit(AI_TASK_SEARCH_PROJECT, ip),
    resetTime: (ip) => getAiTaskSearchRateLimitResetTime(AI_TASK_SEARCH_PROJECT, ip),
  },
  {
    sourceId: "milestone_interview_rate_limits",
    ceiling: MILESTONE_INTERVIEW_RATE_LIMIT_IP_MAX,
    reset: () => __resetMilestoneSliceInterviewState(),
    hit: (ip) => hitMilestoneInterviewRateLimit(ip),
    resetTime: (ip) => milestoneInterviewRateLimitResetTime(ip),
    reclaim: () => __runMilestoneInterviewCleanupForTests(),
  },
  {
    sourceId: "mission_interview_rate_limits",
    ceiling: MISSION_INTERVIEW_RATE_LIMIT_IP_MAX,
    reset: () => __resetMissionInterviewState(),
    hit: (ip) => hitMissionInterviewRateLimit(ip),
    resetTime: (ip) => missionInterviewRateLimitResetTime(ip),
    reclaim: () => __runMissionInterviewCleanupForTests(),
  },
];

function censusRow(sourceId: string): RetentionSourceSnapshot {
  const row = retentionCensusSnapshot().sources.find((source) => source.id === sourceId);
  if (!row) {
    throw new Error(`retention census has no row for "${sourceId}" — the bound is not observable`);
  }

  return row;
}

describe("IP-keyed rate-limit windows are bounded and reclaimed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(IP_KEYED_SURFACES)("$sourceId", (surface) => {
    it("holds 1 000 distinct addresses inside its ceiling and reclaims them once expired", () => {
      surface.reset();

      for (let i = 0; i < DISTINCT_ADDRESSES; i++) {
        surface.hit(ipAt(i));
      }

      const loaded = censusRow(surface.sourceId);
      // The instrument sees the load: without this row the growth was invisible until the OOM.
      expect(loaded.entries).toBe(DISTINCT_ADDRESSES);
      expect(loaded.entries).toBeLessThanOrEqual(surface.ceiling);
      expect(loaded.expiredEntries).toBe(0);

      vi.advanceTimersByTime(PAST_EVERY_WINDOW_MS);

      if (surface.reclaim) {
        // The owning module keeps deletion on its own timer, so the instrument has to SEE the stale
        // rows — that visibility is what makes the leak reportable before it becomes an OOM.
        const stale = censusRow(surface.sourceId);
        expect(stale.expiredEntries).toBe(DISTINCT_ADDRESSES);
        surface.reclaim();
      } else {
        // Census-owned reclamation: an expired row never survives a sample at all.
        const sweptDirectly = censusRow(surface.sourceId);
        expect(sweptDirectly.entries).toBe(0);
        expect(sweptDirectly.expiredEntries).toBe(0);
      }

      // `retentionCensusSnapshot()` sweeps before probing, so this read is post-reclaim either way.
      const swept = censusRow(surface.sourceId);
      expect(swept.entries).toBe(0);
      expect(swept.expiredEntries).toBe(0);

      // A live address survives the sweep untouched and is still rate-limited with a reset time.
      surface.hit(LIVE_IP);
      expect(censusRow(surface.sourceId).entries).toBe(1);
      expect(surface.resetTime(LIVE_IP)).toBeInstanceOf(Date);
    });
  });

  // Both ceiling owners get one pressure case each: the census sweep for census-owned maps, and the
  // guard's insert-site enforcement for maps whose deletion owner stays in the module.
  it.each([
    { sourceId: "chat_rate_limits", ceiling: CHAT_RATE_LIMIT_IP_MAX, reset: () => __resetChatState(), hit: (ip: string) => hitChatRateLimit(ip) },
    { sourceId: "planning_rate_limits", ceiling: PLANNING_RATE_LIMIT_IP_MAX, reset: () => __resetPlanningState(), hit: (ip: string) => hitPlanningRateLimit(ip) },
  ])("$sourceId stops growing at its ceiling under over-ceiling pressure", ({ sourceId, ceiling, reset, hit }) => {
    reset();

    const overage = 250;
    for (let i = 0; i < ceiling + overage; i++) {
      hit(ipAt(i));
    }

    const row = censusRow(sourceId);
    expect(row.entries).toBe(ceiling);
    expect(row.entries).toBeLessThanOrEqual(ceiling);
    // The ceiling is a reported pressure state, not just a private cap: it must be visible.
    expect(row.atCeiling).toBe(true);
  });

  it("names the workflow-design window in the census even though its guard is route-private", () => {
    // `checkDesignRateLimit` is intentionally not exported; the bound is asserted through the row the
    // census publishes, which is what an operator reads on /metrics.
    const row = censusRow("workflow_design_rate_limits");
    expect(row.ceiling).toBe(DESIGN_RATE_LIMIT_IP_MAX);
  });
});
