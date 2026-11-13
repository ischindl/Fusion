/*
FNXC:OAuthAlarmEvidence 2026-11-08-00:26 (RUFU-498):
The OAuth re-login banner and the engine expiry monitor used to alarm from credential-expiry
state alone, so an expired leftover credential of a provider no lane resolves through kept a
board-wide alarm up forever (measured: `anthropic-subscription` on a 24-project host with zero
anthropic selections in any settings/workflow/agent lane) and demonstrably caused a false
diagnosis when an agent read the alarm as live board state (RUFU-497). This module is the ONE
reference authority every alarm producer consults: it answers "does any model lane resolve a
model through this provider id today?" The gate is a provider-id-set comparison — no provider
name appears in the gate logic; the only provider-pair knowledge is the exported alias closure
below, which exists because a lane selecting `anthropic` can be served by the
`anthropic-subscription` credential (auth preference or absence of an API key routes through
it, and `resolveEffectiveOAuthCredential` in the engine resolves the freshest of the two).
Fail direction for callers is always inclusion: this collector itself never invents providers
(malformed input is ignored) and never throws on corrupt input, but any CALLER error reading
inputs must be treated as "referenced" so a broken scan can never suppress a real alarm.
*/

import { ANTHROPIC_PROVIDER_ID } from "./anthropic-models.js";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../provider-instance.js";

/** Keys whose values are provider ids: everything lane-shaped ends in the singular `Provider`
 *  suffix (`defaultProvider`, `executionProvider`/`planningProvider`/`validatorProvider`/
 *  `mergerProvider`, the `*GlobalProvider` globals, `*FallbackProvider` variants,
 *  `chatDefaultModelProvider`, and `selectedWorkflowModelLanes` overlay keys). Plurals such as
 *  `customProviders` and non-lane keys such as `anthropicAuthPreference` do NOT match — a
 *  preference is not a lane and must never gate an alarm by itself. */
const PROVIDER_KEY_SUFFIX = "Provider";

/** Lane-shaped keys that legitimately carry a provider id without ending in the suffix. */
const EXPLICIT_PROVIDER_VALUE_KEYS: readonly string[] = ["defaultProviderOverride"];

/** Task fields carrying a per-card model-lane provider id (typed fields only — task metadata
 *  and free-text areas are never walked, so prose can never count as a lane reference). */
const TASK_LANE_PROVIDER_FIELDS: readonly string[] = [
  "modelProvider",
  "validatorModelProvider",
  "planningModelProvider",
  "mergerModelProvider",
];

/*
FNXC:OAuthAlarmEvidence 2026-11-08-00:26 (RUFU-498):
Bidirectional alias closure for the Anthropic credential pair. A lane selecting `anthropic`
may execute through the `anthropic-subscription` OAuth token (auth preference / missing API
key), and the engine's freshest-of-two expiry resolution reads both ids as one credential
surface — so either id being referenced keeps BOTH credentials' expiry alarms live. This map
is the only place a provider pair is named; route and monitor share it via these exports.
*/
const PROVIDER_ID_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  [ANTHROPIC_PROVIDER_ID, [ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]],
  [ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, [ANTHROPIC_PROVIDER_ID]],
]);

/** The provider id itself plus every aliased id whose credential can serve a lane that
 *  selected it. Unknown ids close over themselves only. */
export function expandProviderIdAliasClosure(providerId: string): ReadonlySet<string> {
  const aliases = PROVIDER_ID_ALIASES.get(providerId);
  if (!aliases) return new Set([providerId]);
  return new Set([providerId, ...aliases]);
}

/** True when `providerId` (or any credential id that can serve it through the alias closure)
 *  appears in the collected lane-reference set. */
export function isProviderLaneReferenced(
  providerId: string,
  referencedIds: ReadonlySet<string>,
): boolean {
  for (const id of expandProviderIdAliasClosure(providerId)) {
    if (referencedIds.has(id)) return true;
  }
  return false;
}

/** Inputs for {@link collectLaneReferencedProviderIds}. Every array element is untyped
 *  external data (stored settings rows, task rows, agent rows, workflow-definition rows);
 *  malformed entries are skipped rather than thrown on. */
export interface LaneReferenceInput {
  /** Settings objects at any tier: global, project, and the persisted per-(workflow, project)
   *  lane VALUES the callers read from `workflow_settings`
   *  (`store.listWorkflowSettingValuesForProject()` → one values map per workflow). Recursively
   *  swept for non-empty string values under keys ending in `Provider`.
   *
   *  FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P0):
   *  The workflow lane VALUES must arrive HERE, from the caller. `workflowDefinitions` carries
   *  only lane DECLARATIONS (`settings: [{ id, default }]`) plus the IR, and
   *  `selectedWorkflowModelLanes` is a runtime-derived overlay that is never persisted
   *  (see `Settings` in settings-scope.ts), so `getSettings()` alone cannot show which workflow
   *  lane an operator actually pointed at a provider. A caller that omits this tier reports an
   *  expired provider referenced ONLY by a stored workflow lane as unreferenced — which is how
   *  the banner and the `oauth-token-expired` push were both lost while every executor task
   *  failed. Stored values are the only shape that reaches here; declaration defaults do not. */
  settingsObjects?: Iterable<unknown>;
  /** Task-like rows; only the typed lane-provider fields contribute. */
  tasks?: Iterable<unknown>;
  /** Agent-like rows; reads `runtimeConfig.modelProvider` and the provider prefix of the
   *  legacy `runtimeConfig.model = "provider/model"` string. */
  agents?: Iterable<unknown>;
  /** Workflow-definition-like rows; sweeps the IR for node `modelProvider` configs and reads
   *  `default` of lane settings whose declared id ends in `Provider`. Declarations only — the
   *  stored per-project VALUES of those same settings are a `settingsObjects` tier. */
  workflowDefinitions?: Iterable<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addTrimmed(target: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) target.add(trimmed);
  }
}

/** Depth and visited guards keep a pure sweep over hostile/cyclic external rows bounded. */
const MAX_SWEEP_DEPTH = 12;

function sweepProviderKeyedValues(
  value: unknown,
  target: Set<string>,
  visited: WeakSet<object>,
  depth: number,
): void {
  if (depth > MAX_SWEEP_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) sweepProviderKeyedValues(item, target, visited, depth + 1);
    return;
  }
  if (!isRecord(value) || visited.has(value)) return;
  visited.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string"
      && (key.endsWith(PROVIDER_KEY_SUFFIX) || EXPLICIT_PROVIDER_VALUE_KEYS.includes(key))) {
      addTrimmed(target, entry);
    }
    sweepProviderKeyedValues(entry, target, visited, depth + 1);
  }
}

/*
FNXC:OAuthAlarmEvidence 2026-11-08-00:26 (RUFU-498):
The legacy agent runtime-model shape must be split EXACTLY like completeRuntimeModel() in
agent-effective-model.ts does (first slash, slash > 0 and < length - 1), NOT by a stricter
"exactly one slash" rule: that function is what actually resolves the agent's model, so a
collector that refused a value real resolution accepts (e.g. "openai/gpt/x") would suppress an
alarm for a provider some lane genuinely resolves through — the one failure this gate may
never have.
*/
function collectFromAgentRuntimeConfig(agent: unknown, target: Set<string>): void {
  if (!isRecord(agent)) return;
  const runtimeConfig = agent.runtimeConfig;
  if (!isRecord(runtimeConfig)) return;
  addTrimmed(target, runtimeConfig.modelProvider);
  const legacy = typeof runtimeConfig.model === "string" ? runtimeConfig.model.trim() : "";
  const slash = legacy.indexOf("/");
  if (slash > 0 && slash < legacy.length - 1) target.add(legacy.slice(0, slash));
}

function collectFromTask(task: unknown, target: Set<string>): void {
  if (!isRecord(task)) return;
  for (const field of TASK_LANE_PROVIDER_FIELDS) addTrimmed(target, task[field]);
}

function collectFromWorkflowDefinition(definition: unknown, target: Set<string>, visited: WeakSet<object>): void {
  if (!isRecord(definition)) return;
  // Node configs carry `modelProvider` at any nesting; the same suffix sweep reaches them.
  sweepProviderKeyedValues(definition.ir, target, visited, 0);
  const ir = definition.ir;
  const settings = isRecord(ir) && Array.isArray(ir.settings) ? ir.settings : [];
  // A lane setting's value sits under `default`, unreachable to a key-suffix sweep: collect it
  // when the declared setting id itself is lane-shaped. Names/ids/prose never contribute.
  for (const setting of settings) {
    if (isRecord(setting) && typeof setting.id === "string" && setting.id.endsWith(PROVIDER_KEY_SUFFIX)) {
      addTrimmed(target, setting.default);
    }
  }
}

/**
 * Collects every provider id that a model lane references today across the supplied tiers:
 * settings sweeps (global/project/overlay, including `selectedWorkflowModelLanes`), typed task
 * lane fields, durable-agent runtime models, and workflow IR node configs / lane setting
 * defaults. Duplicates dedupe into the returned set; corrupt or absent ELEMENTS are ignored,
 * never thrown on. A `tasks`/`agents`/`workflowDefinitions` value that is not iterable at all
 * DOES throw, deliberately: that shape is a caller wiring bug (a store method that stopped
 * returning an array), and every caller wraps this scan in a catch whose result is
 * "referenced" — so raising keeps a real alarm visible, while quietly treating the tier as
 * empty could suppress one. Apply {@link isProviderLaneReferenced} — not bare `has` — when
 * asking about a provider, so the Anthropic credential alias closure is honored.
 */
export function collectLaneReferencedProviderIds(input: LaneReferenceInput): Set<string> {
  const referenced = new Set<string>();
  const visited = new WeakSet<object>();
  for (const settings of input.settingsObjects ?? []) {
    sweepProviderKeyedValues(settings, referenced, visited, 0);
  }
  for (const task of input.tasks ?? []) collectFromTask(task, referenced);
  for (const agent of input.agents ?? []) collectFromAgentRuntimeConfig(agent, referenced);
  for (const definition of input.workflowDefinitions ?? []) {
    collectFromWorkflowDefinition(definition, referenced, visited);
  }
  return referenced;
}
