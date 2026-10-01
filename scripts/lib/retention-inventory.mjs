// GENERATED FILE — do not edit by hand.
// Regenerate: node scripts/check-retention-coverage.mjs --write
// Check:      node scripts/check-retention-coverage.mjs
/*
FNXC:RetentionCensus 2026-09-23-09:05 (RUFU-257):
The subject set of the retention-coverage ratchet, derived from source structure by
scripts/check-retention-coverage.mjs: every module-scope `new Map`/`new Set` in packages/dashboard/src.
One entry per declaration, keyed by file + declaration name, classified census-registered / bounded /
owner-deleted / config-keyed-registry / fixed-key-set. This file is diff-reviewable on purpose: the
classification of a new module-scope cache must appear in a PR diff, and it cannot be narrowed by
hand because `--write` regenerates it from the scan.
*/

export const RETENTION_INVENTORY_SCHEMA = 1;

/** Declarations whose classification the scanner could not derive. Always empty in a green tree. */
export const RETENTION_INVENTORY = [
  {
    "file": "packages/dashboard/src/agent-generation.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "agent_generation_rate_limits"
    ],
    "ceilingConstant": "AGENT_GENERATION_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(agent_generation_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/agent-generation.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "agent_generation_sessions"
    ],
    "ceilingConstant": "AGENT_GENERATION_SESSION_MAX",
    "justification": "registerBoundedWindowMap(agent_generation_sessions) references `sessions`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/agent-onboarding.ts",
    "name": "activeGenerations",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "agent_onboarding_active_generations"
    ],
    "ceilingConstant": "AGENT_ONBOARDING_ACTIVE_GENERATION_MAX",
    "justification": "registerBoundedRegistryMap(agent_onboarding_active_generations) references `activeGenerations`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/agent-onboarding.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "agent_onboarding_sessions"
    ],
    "ceilingConstant": "AGENT_ONBOARDING_SESSION_MAX",
    "justification": "registerBoundedWindowMap(agent_onboarding_sessions) references `sessions`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/ai-refine.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "ai_refine_rate_limits"
    ],
    "ceilingConstant": "REFINE_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(ai_refine_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/ai-task-search.ts",
    "name": "projectConcurrency",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "ai_task_search_project_concurrency"
    ],
    "ceilingConstant": "AI_TASK_SEARCH_PROJECT_CONCURRENCY_MAX",
    "justification": "registerBoundedRegistryMap(ai_task_search_project_concurrency) references `projectConcurrency`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/ai-task-search.ts",
    "name": "rateWindows",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "ai_task_search_rate_windows"
    ],
    "ceilingConstant": "AI_TASK_SEARCH_RATE_WINDOW_IP_MAX",
    "justification": "registerBoundedWindowMap(ai_task_search_rate_windows) references `rateWindows`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/ai-translate.ts",
    "name": "translateRateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "ai_translate_rate_limits"
    ],
    "ceilingConstant": "TRANSLATE_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(ai_translate_rate_limits) references `translateRateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/antigravity-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "antigravity_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(antigravity_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/antigravity-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat-attachment-content.ts",
    "name": "IMAGE_MIME_TYPES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 5 fixed entries and no mutation site in packages/dashboard/src/chat-attachment-content.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat-attachment-content.ts",
    "name": "TEXT_MIME_TYPES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "derived once at module load from the static text-MIME table and never mutated afterwards; size is the table's row count",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat-project-services.ts",
    "name": "scopedChatManagerCache",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by the resolved ChatStore of a configured project — the value is that project's live ChatManager",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat-project-services.ts",
    "name": "scopedChatStoreCache",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by the resolved TaskStore of a configured project — the value is that project's live ChatStore, so eviction would destroy live state",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat-project-services.ts",
    "name": "scopedChatStoreListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "subscriber set — every add returns an unsubscribe that deletes the listener",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat.ts",
    "name": "CHAT_IDEATION_READ_TOOL_NAMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/chat.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat.ts",
    "name": "CHAT_MISSION_READ_TOOL_NAMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/chat.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/chat.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "chat_rate_limits"
    ],
    "ceilingConstant": "CHAT_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(chat_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/claude-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "claude_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(claude_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/claude-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/cli-chat.ts",
    "name": "BUSY_STATES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 3 fixed entries and no mutation site in packages/dashboard/src/cli-chat.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/cli-package-version.ts",
    "name": "CLI_PACKAGE_NAMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one-entry name table over the package-name constants above; never mutated at runtime",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/cli-package-version.ts",
    "name": "DESKTOP_PACKAGE_NAMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one-entry name table over the package-name constants above; never mutated at runtime",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/cursor-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "cursor_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(cursor_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/cursor-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/dev-server-manager.ts",
    "name": "managerInstances",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by resolved project root — one live DevServerManager per configured root, shared by every request for that root",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/dev-server-routes.ts",
    "name": "runtimes",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by project root — one live store+process-manager runtime per configured root",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/dev-server-store.ts",
    "name": "storeInstances",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by resolved project dir — one live DevServerStore per configured root, shared by every reader",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/devserver-manager.ts",
    "name": "managerInstances",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by resolved project root — one live DevServerManager per configured root",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/file-service.ts",
    "name": "MARKDOWN_SCAN_EXCLUDED_DIRS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 11 fixed entries and no mutation site in packages/dashboard/src/file-service.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/github-tracking-dedup.ts",
    "name": "STOPWORDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 11 fixed entries and no mutation site in packages/dashboard/src/github-tracking-dedup.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/github-tracking-state.ts",
    "name": "LEGACY_COMPLETE_LANES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 1 fixed entries and no mutation site in packages/dashboard/src/github-tracking-state.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/github-tracking.ts",
    "name": "planningSourceIssueLocks",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "per-source-issue serialization queue — the queued tail is deleted once it settles and is owner-checked before deletion",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/grok-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "grok_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(grok_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/grok-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/hermes-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "hermes_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(hermes_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/hermes-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/insights-routes.ts",
    "name": "activeRunControllers",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one AbortController per running insight run — deleted in the run's finally block on success, failure and abort",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/issue-image-attachments.ts",
    "name": "ALLOWED_IMAGE_MIMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 4 fixed entries and no mutation site in packages/dashboard/src/issue-image-attachments.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/issue-image-attachments.ts",
    "name": "GITHUB_IMAGE_HOSTS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 6 fixed entries and no mutation site in packages/dashboard/src/issue-image-attachments.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/knowledge-graph-access.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "knowledge_graph_artifacts"
    ],
    "ceilingConstant": "CACHE_SIZE",
    "justification": "registerRetentionSource(knowledge_graph_artifacts) references `cache`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/knowledge-graph-access.ts",
    "name": "rebuilds",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "knowledge_graph_rebuilds"
    ],
    "ceilingConstant": "KG_REBUILD_TRACKER_MAX",
    "justification": "registerBoundedRegistryMap(knowledge_graph_rebuilds) references `rebuilds`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/lib/codebase-metrics.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "codebase_metrics"
    ],
    "ceilingConstant": "CODEBASE_METRICS_CACHE_MAX",
    "justification": "registerBoundedWindowMap(codebase_metrics) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `TTL`",
      "cache appears on the same line as expiry field `expiresAt`",
      "cache appears on the same line as expiry field `expiry`"
    ]
  },
  {
    "file": "packages/dashboard/src/milestone-slice-interview.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "milestone_interview_rate_limits"
    ],
    "ceilingConstant": "MILESTONE_INTERVIEW_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(milestone_interview_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/milestone-slice-interview.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "milestone_interview_sessions"
    ],
    "ceilingConstant": "MILESTONE_INTERVIEW_SESSION_MAX",
    "justification": "registerBoundedWindowMap(milestone_interview_sessions) references `sessions`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/mission-interview.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "mission_interview_rate_limits"
    ],
    "ceilingConstant": "MISSION_INTERVIEW_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(mission_interview_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/mission-interview.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "mission_interview_sessions"
    ],
    "ceilingConstant": "MISSION_INTERVIEW_SESSION_MAX",
    "justification": "registerBoundedWindowMap(mission_interview_sessions) references `sessions`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/omp-model-cache.ts",
    "name": "cache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "omp_picker_models"
    ],
    "ceilingConstant": "MAX_CACHED_PICKER_BINARIES",
    "justification": "registerBoundedWindowMap(omp_picker_models) references `cache`",
    "expiryEvidence": [
      "cache appears on the same line as expiry field `expires`",
      "cache appears on the same line as expiry field `fetchedAt`",
      "value type `CacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/omp-model-cache.ts",
    "name": "inFlight",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight fetch lease — inFlight.delete(binaryPath) runs in the fetch's 'finally' block, so an entry cannot outlive its request.",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "activeGenerations",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_active_generations"
    ],
    "ceilingConstant": "PLANNING_ACTIVE_GENERATION_MAX",
    "justification": "registerBoundedRegistryMap(planning_active_generations) references `activeGenerations`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "pendingTurnReservations",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_turn_reservations"
    ],
    "ceilingConstant": "PLANNING_PER_SESSION_OPERATION_MAX",
    "justification": "registerBoundedRegistryMap(planning_turn_reservations) references `pendingTurnReservations`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "rateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_rate_limits"
    ],
    "ceilingConstant": "PLANNING_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(planning_rate_limits) references `rateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "sessionPersistenceQueues",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_persistence_queues"
    ],
    "ceilingConstant": "PLANNING_PER_SESSION_OPERATION_MAX",
    "justification": "registerBoundedRegistryMap(planning_persistence_queues) references `sessionPersistenceQueues`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_sessions"
    ],
    "ceilingConstant": "PLANNING_SESSION_MAX",
    "justification": "registerBoundedWindowMap(planning_sessions) references `sessions`",
    "expiryEvidence": [
      "sessions appears on the same line as expiry field `expired`",
      "sessions appears on the same line as expiry field `TTL`"
    ]
  },
  {
    "file": "packages/dashboard/src/planning.ts",
    "name": "settlingTurnOperations",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "planning_settling_turn_operations"
    ],
    "ceilingConstant": "PLANNING_PER_SESSION_OPERATION_MAX",
    "justification": "registerBoundedRegistryMap(planning_settling_turn_operations) references `settlingTurnOperations`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/plugin-routes.ts",
    "name": "DIST_DIR_NAMES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 5 fixed entries and no mutation site in packages/dashboard/src/plugin-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "backendShutdowns",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one shutdown hook per booted backend — removed when that project's store is evicted or shut down",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "initializedProjects",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one flag per opened project — cleared together with its storeCache entry by eviction/shutdown",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "pendingCreations",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight store-creation lease — the entry is deleted in the creation's finally block",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "pendingEvictions",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one eviction barrier per in-flight eviction — deleted when the barrier settles",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "projectRegisteredListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "subscriber set — every add returns an unsubscribe that deletes the listener",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/project-store-resolver.ts",
    "name": "storeCache",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one TaskStore per opened project — dropped by the eviction and shutdown paths that close that store",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/provider-health-monitor.ts",
    "name": "INDEPENDENTLY_METERED_PROVIDERS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 4 fixed entries and no mutation site in packages/dashboard/src/provider-health-monitor.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/remote-auth.ts",
    "name": "shortLivedTokens",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "remote_auth_short_lived_tokens"
    ],
    "ceilingConstant": "MAX_SHORT_LIVED_TOKENS",
    "justification": "registerBoundedWindowMap(remote_auth_short_lived_tokens) references `shortLivedTokens`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/report-pipeline.ts",
    "name": "endorsedSessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "report_endorsed_sessions"
    ],
    "ceilingConstant": "MAX_ENDORSED_REPORT_SESSIONS",
    "justification": "registerBoundedRegistryMap(report_endorsed_sessions) references `endorsedSessions`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/attribute-done-range-files.ts",
    "name": "inFlightAttribution",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "single-flight attribution lease — deleted on settle, including rejection",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/attribute-done-range-files.ts",
    "name": "ownFilesByCommitSet",
    "kind": "Map",
    "classification": "bounded",
    "sources": [],
    "ceilingConstant": "OWN_FILES_CACHE_MAX",
    "justification": "count ceiling `OWN_FILES_CACHE_MAX` declared in packages/dashboard/src/routes/attribute-done-range-files.ts",
    "expiryEvidence": [
      "ownFilesByCommitSet appears on the same line as expiry field `TTL`"
    ]
  },
  {
    "file": "packages/dashboard/src/routes/chat-attachment-config.ts",
    "name": "CHAT_ALLOWED_MIME_TYPES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 11 fixed entries and no mutation site in packages/dashboard/src/routes/chat-attachment-config.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/cli-agent-settings.ts",
    "name": "KNOWN_ADAPTER_IDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 1 fixed entries and no mutation site in packages/dashboard/src/routes/cli-agent-settings.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/plugin-bundled-runtimes.ts",
    "name": "BUNDLED_PLUGIN_IDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 11 fixed entries and no mutation site in packages/dashboard/src/routes/plugin-bundled-runtimes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-agent-core-routes.ts",
    "name": "VALID_AGENT_PERMISSION_KEYS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 1 fixed entries and no mutation site in packages/dashboard/src/routes/register-agent-core-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-command-center-routes.ts",
    "name": "VALID_GROUP_BY",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 6 fixed entries and no mutation site in packages/dashboard/src/routes/register-command-center-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-command-center-routes.ts",
    "name": "VALID_TOKEN_GRANULARITY",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 4 fixed entries and no mutation site in packages/dashboard/src/routes/register-command-center-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-file-workspace-routes.ts",
    "name": "INLINE_PREVIEW_CONTENT_TYPES",
    "kind": "Map",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Map initializer with 22 fixed entries and no mutation site in packages/dashboard/src/routes/register-file-workspace-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-git-github.ts",
    "name": "recentIssuesCache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "github_recent_issues"
    ],
    "ceilingConstant": "RECENT_ISSUES_CACHE_MAX",
    "justification": "registerBoundedWindowMap(github_recent_issues) references `recentIssuesCache`",
    "expiryEvidence": [
      "recentIssuesCache appears on the same line as expiry field `fetchedAt`"
    ]
  },
  {
    "file": "packages/dashboard/src/routes/register-knowledge-routes.ts",
    "name": "GRAPH_EDGE_KINDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "request-parameter enum domain, fixed by the graph schema",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-knowledge-routes.ts",
    "name": "GRAPH_NODE_KINDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "request-parameter enum domain, fixed by the graph schema",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-knowledge-routes.ts",
    "name": "GRAPH_OWNERS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "request-parameter enum domain, fixed by the graph schema",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-knowledge-routes.ts",
    "name": "GRAPH_SYMBOL_KINDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "request-parameter enum domain, fixed by the graph schema",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-knowledge-routes.ts",
    "name": "VALID_SOURCE_KINDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/routes/register-knowledge-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-planning-subtask-routes.ts",
    "name": "planningCreateLocks",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "per-session create-queue tail — deleted when the tail settles, behind an identity check",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-report-routes.ts",
    "name": "ACTION_TYPES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 4 fixed entries and no mutation site in packages/dashboard/src/routes/register-report-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-report-routes.ts",
    "name": "REPORT_TARGETS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/routes/register-report-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-session-diff-routes.ts",
    "name": "taskDiffStatsCache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "task_diff_stats"
    ],
    "ceilingConstant": "TASK_DIFF_STATS_CACHE_MAX",
    "justification": "registerRetentionSource(task_diff_stats) references `taskDiffStatsCache`",
    "expiryEvidence": [
      "taskDiffStatsCache appears on the same line as expiry field `expiresAt`"
    ]
  },
  {
    "file": "packages/dashboard/src/routes/register-session-diff-routes.ts",
    "name": "taskDiffStatsInFlight",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "task_diff_stats_in_flight"
    ],
    "ceilingConstant": "TASK_DIFF_STATS_CACHE_MAX",
    "justification": "registerRetentionSource(task_diff_stats_in_flight) references `taskDiffStatsInFlight`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-system-routes.ts",
    "name": "jobsById",
    "kind": "Map",
    "classification": "bounded",
    "sources": [],
    "ceilingConstant": "SYSTEM_JOB_HISTORY_MAX",
    "justification": "count ceiling `SYSTEM_JOB_HISTORY_MAX` declared in packages/dashboard/src/routes/register-system-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "ARTIFACT_TYPES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 5 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "CURRENT_WORKFLOW_REVIEW_STATUSES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "CURRENT_WORKFLOW_REVIEW_STEP_IDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 2 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "DUPLICATE_STOPWORDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 13 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "LEGACY_WIP_LANES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 1 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "name": "LEGACY_WORKFLOW_REVIEW_STATUSES",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 3 fixed entries and no mutation site in packages/dashboard/src/routes/register-task-workflow-routes.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-voice-routes.ts",
    "name": "pendingSessionReservations",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "voice_pending_session_reservations"
    ],
    "ceilingConstant": "VOICE_PENDING_RESERVATION_PROJECTS_MAX",
    "justification": "registerRetentionSource(voice_pending_session_reservations) references `pendingSessionReservations`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/routes/register-voice-routes.ts",
    "name": "sessions",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "voice_sessions"
    ],
    "ceilingConstant": "VOICE_SESSION_MAX",
    "justification": "registerRetentionSource(voice_sessions) references `sessions`",
    "expiryEvidence": [
      "sessions appears on the same line as expiry field `expires`",
      "value type `Session` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/routes/register-workflow-routes.ts",
    "name": "designRateLimits",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "workflow_design_rate_limits"
    ],
    "ceilingConstant": "DESIGN_RATE_LIMIT_IP_MAX",
    "justification": "registerBoundedWindowMap(workflow_design_rate_limits) references `designRateLimits`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/script-store.ts",
    "name": "storeInstances",
    "kind": "Map",
    "classification": "config-keyed-registry",
    "sources": [],
    "ceilingConstant": null,
    "justification": "keyed by the project's scripts file — one live ScriptStore per configured root",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/shared/chat-toolcall-compact.ts",
    "name": "COMPACT_QUESTION_TOOL_NAME_SET",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "derived once at module load from the static COMPACT_QUESTION_TOOL_NAMES list and never mutated afterwards",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/shared/dashboard-views.ts",
    "name": "DASHBOARD_VIEW_BY_ID",
    "kind": "Map",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "populated once at module init from the static DASHBOARD_VIEWS table (ids + aliases) and never mutated afterwards",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/shared/settings-sections.ts",
    "name": "ADVANCED_SECTION_IDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "literal Set initializer with 11 fixed entries and no mutation site in packages/dashboard/src/shared/settings-sections.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "approvalSseListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one listener set per SSE stream — every add is paired with a delete in the unsubscribe path, so cardinality is live streams, not traffic",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "chatSnippetsSseListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one listener set per SSE stream — every add is paired with a delete in the unsubscribe path, so cardinality is live streams, not traffic",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "cliSessionStateSseListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one listener set per SSE stream — every add is paired with a delete in the unsubscribe path, so cardinality is live streams, not traffic",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "managedConnections",
    "kind": "Map",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one entry per live SSE connection — removed by the connection's close/error handler",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "pluginCustomSseListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one listener set per SSE stream — every add is paired with a delete in the unsubscribe path, so cardinality is live streams, not traffic",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/sse.ts",
    "name": "workflowSseListeners",
    "kind": "Set",
    "classification": "owner-deleted",
    "sources": [],
    "ceilingConstant": null,
    "justification": "one listener set per SSE stream — every add is paired with a delete in the unsubscribe path, so cardinality is live streams, not traffic",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/terminal-service.ts",
    "name": "terminalServices",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "terminal_service_registry"
    ],
    "ceilingConstant": "TERMINAL_SERVICE_ROOTS_MAX",
    "justification": "registerBoundedRegistryMap(terminal_service_registry) references `terminalServices`",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/terminal.ts",
    "name": "ALLOWED_COMMANDS",
    "kind": "Set",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "executable-name allow-list (security policy, see the doc comment above); fixed table, never grown at runtime",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/test/mockCoreEngine.ts",
    "name": "fallbackFns",
    "kind": "Map",
    "classification": "fixed-key-set",
    "sources": [],
    "ceilingConstant": null,
    "justification": "test-only mock engine: keys are the fixed fn_* tool names of the mocked surface, never request-derived",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/view-chunk-manifest.ts",
    "name": "manifestCache",
    "kind": "Map",
    "classification": "census-registered",
    "sources": [
      "dashboard_view_chunk_manifest"
    ],
    "ceilingConstant": "MANIFEST_CACHE_MAX",
    "justification": "registerBoundedRegistryMap(dashboard_view_chunk_manifest) references `manifestCache`",
    "expiryEvidence": [
      "manifestCache appears on the same line as expiry field `mtimeMs`",
      "value type `ManifestCacheEntry` declares an expiry field"
    ]
  },
  {
    "file": "packages/dashboard/src/view-chunk-manifest.ts",
    "name": "warnedMissingEntries",
    "kind": "Set",
    "classification": "bounded",
    "sources": [],
    "ceilingConstant": "WARN_ONCE_KEYS_MAX",
    "justification": "count ceiling `WARN_ONCE_KEYS_MAX` declared in packages/dashboard/src/view-chunk-manifest.ts",
    "expiryEvidence": []
  },
  {
    "file": "packages/dashboard/src/view-chunk-manifest.ts",
    "name": "warnedMissingManifest",
    "kind": "Set",
    "classification": "bounded",
    "sources": [],
    "ceilingConstant": "WARN_ONCE_KEYS_MAX",
    "justification": "count ceiling `WARN_ONCE_KEYS_MAX` declared in packages/dashboard/src/view-chunk-manifest.ts",
    "expiryEvidence": []
  }
];

export default RETENTION_INVENTORY;
