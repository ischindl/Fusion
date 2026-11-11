/**
 * The turn's declared tool surface, derived from the live session, never from prior-call state.
 *
 * RUFU-520 closed a silent-wrong-answer class: in long CLI-lane sessions the surface a turn
 * declared could come from an earlier turn (a transcript replay that no longer matches the
 * session, or a cached MCP config file from a previous surface). When that stale surface omitted
 * a coordination tool the prompt still told the agent to call, the model substituted a visible
 * coding tool (`read` on a fabricated `/fusion/<tool-name>` path) or a lookalike tool, and the
 * substituted result arrived in the normal shape.
 */

/*
 * FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 * RUFU-520 invariant, stated once and enforced by this module: the set declared to the model for
 * a turn is `pi.getActiveTools()` names intersected with `pi.getAllTools()` definitions, minus
 * built-ins (pi executes those natively) and minus names pi itself refuses to declare. pi defines
 * the active set as "the set declared to the model" and `hidden` as "registered but unreachable.
 * Activating it has no effect" (pi-coding-agent dist/core/extensions/types.d.ts:383-386), and
 * `AgentSession._applyToolLoadout` declares "the registered, non-hidden ones". So declaring an
 * inactive or hidden tool is a violation of this invariant in the same direction as omitting an
 * active one, and both are refused here.
 *
 * FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 * RUFU-520 also fixes what happens when a name is requested that the run cannot execute. pi's own
 * lookup (`prepareToolCall` in pi-coding-agent's agent loop) is already name-faithful:
 * `tools.find((tool) => tool.name === toolCall.name)`, and an absent name yields an explicit
 * `Tool <name> not found` error result with zero handler calls. The gap was on this side of the
 * bridge: `handleContentBlockStart` returned early for any name `isPiKnownDroidTool` rejected, so
 * a coordination call emitted under a name the turn did not declare vanished silently, and
 * `provider.ts` then rewrote `stopReason: "toolUse"` to `"stop"` because zero tool calls survived.
 * `resolveToolRequestDisposition` replaces that silent skip with an explicit, distinguishable
 * guard for every `fn_`-prefixed or MCP-prefixed request, which is Fusion's own coordination
 * namespace, while internal Claude Code tools (ToolSearch, Task, Agent) keep being skipped.
 */

import { BUILT_IN_TOOL_NAMES } from "./mcp-config.js";
import { CUSTOM_TOOLS_MCP_PREFIX, mapDroidToolNameToPi, isPiKnownDroidTool } from "./tool-mapping.js";

/**
 * Stable marker for "this request named a tool the run cannot execute". It is the greppable
 * identity of the guard on every surface that emits it: the event bridge (both bridge clones),
 * the schema-only MCP server's `tools/call` refusal, and the card History a guarded call leaves.
 */
export const TOOL_NOT_AVAILABLE_MARKER = "TOOL_NOT_AVAILABLE";

/** Fusion's coordination-tool namespace. Every board tool is named `fn_*`. */
export const FUSION_TOOL_NAME_PREFIX = "fn_";

/** Build the guard sentence for a requested tool name. */
export function toolNotAvailableMessage(toolName: string): string {
  return (
    `${TOOL_NOT_AVAILABLE_MARKER}: ${toolName} is not available in this run, so no handler ran ` +
    "for this request. Treat this line as a failed observation: it is not an empty result and no " +
    "other tool's output stands in for it."
  );
}

/** Whether a piece of text is the guard sentence rather than a tool's own result. */
export function isToolNotAvailableMessage(text: string): boolean {
  return text.includes(TOOL_NOT_AVAILABLE_MARKER);
}

/** The pi-ai tool shape this package declares and replays. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A declaration as pi's transcript replay carries it: pi-ai's `normalizeTranscriptTools` keeps
 * `description` and `parameters` optional, so every consumer must normalize before declaring.
 */
export interface ReplayedTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** The subset of a registry entry this module reads. pi's `ToolInfo` is wider. */
interface PiToolInfoLike {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  /** pi's `ToolExposure`: "direct" | "model-only" | "codemode" | "deferred" | "hidden". */
  exposure?: unknown;
}

/** Duck-typed view of the pi extension API. Both readers are defensive: pi's shapes vary by version. */
export interface PiToolSurfaceApi {
  getAllTools(): unknown;
  getActiveTools?(): unknown;
}

export interface ReconciledToolSurface {
  /**
   * The full surface the turn declares to the model: the replayed built-in declarations plus the
   * reconciled custom tools. This is what `cliContext.tools` carries, so the prompt's tool
   * instructions and the MCP schema file cannot disagree.
   */
  declaredTools: ToolDeclaration[];
  /** The custom (non built-in) members of `declaredTools`, ready to become MCP tool defs. */
  customTools: ToolDeclaration[];
  /** Names the replay carried that this turn may not execute, in replay order. */
  droppedNames: string[];
  /** True when `pi.getAllTools()` returned no array, so membership could not be proven. */
  registryUnreadable: boolean;
  /** True when `pi.getActiveTools()` returned no array, so the registry stands in for the active set. */
  activeSetUnreadable: boolean;
}

/**
 * Whether pi would declare this registry entry at all. `hidden`, `codemode`, and `deferred` tools
 * are reachable only through other tools or tool search, and pi keeps them out of the declaration
 * (`_isDeclarable` admits `direct` and `model-only` only). An entry that carries no `exposure`
 * field predates that vocabulary, so it is treated as declarable.
 */
function isDeclarableExposure(info: PiToolInfoLike): boolean {
  if (typeof info.exposure !== "string") return true;
  return info.exposure === "direct" || info.exposure === "model-only";
}

function declarationFromRegistry(info: PiToolInfoLike): ToolDeclaration | undefined {
  if (typeof info.name !== "string" || info.name.length === 0) return undefined;
  const parameters =
    info.parameters && typeof info.parameters === "object"
      ? (info.parameters as Record<string, unknown>)
      : {};
  return {
    name: info.name,
    description: typeof info.description === "string" ? info.description : "",
    parameters,
  };
}

/**
 * Reconcile the turn's declared tool surface from the live session.
 *
 * `replayedTools` is pi's own transcript replay (`getCurrentTools(context.messages)`). It is the
 * source of the *declarations* (the descriptions and schemas pi-ai normalized for the model) but
 * it is never the authority on *membership*: membership is `getActiveTools()` intersected with the
 * registry. Both drift directions are corrected: an active tool the replay lacks is appended, and
 * a replayed tool that is no longer active or declarable is dropped.
 *
 * When the registry cannot be read, the custom surface is empty rather than guessed. Serving the
 * previous turn's file is what produced the fabricated observations this card closes: a stale
 * surface asserts that tools exist that this run cannot execute.
 */
export function reconcileToolSurface(
  pi: PiToolSurfaceApi,
  replayedTools: ReadonlyArray<ReplayedTool> | undefined,
): ReconciledToolSurface {
  const replay = Array.isArray(replayedTools) ? replayedTools : [];
  const registryRaw = pi?.getAllTools?.();
  const registryUnreadable = !Array.isArray(registryRaw);
  const registryEntries = (registryUnreadable ? [] : registryRaw as PiToolInfoLike[]).filter(
    (info): info is PiToolInfoLike & { name: string } => typeof info?.name === "string" && info.name.length > 0,
  );

  const activeRaw = typeof pi?.getActiveTools === "function" ? pi.getActiveTools() : undefined;
  const activeSetUnreadable = !Array.isArray(activeRaw);
  const activeNames = activeSetUnreadable
    ? undefined
    : new Set((activeRaw as unknown[]).filter((name): name is string => typeof name === "string"));

  // Names pi will accept for this turn. Without an active set the registry is the only evidence,
  // and non-declarable exposures are still refused so a hidden tool is never over-declared.
  const declarable = new Map<string, ToolDeclaration>();
  for (const entry of registryEntries) {
    if (BUILT_IN_TOOL_NAMES.has(entry.name)) continue;
    if (!isDeclarableExposure(entry)) continue;
    if (activeNames && !activeNames.has(entry.name)) continue;
    const declaration = declarationFromRegistry(entry);
    if (declaration) declarable.set(entry.name, declaration);
  }

  const declaredTools: ToolDeclaration[] = [];
  const customTools: ToolDeclaration[] = [];
  const droppedNames: string[] = [];
  const emitted = new Set<string>();

  for (const tool of replay) {
    if (!tool || typeof tool.name !== "string") continue;
    if (BUILT_IN_TOOL_NAMES.has(tool.name)) {
      // pi executes the six coding tools natively; their replayed declaration stays as pi wrote it.
      declaredTools.push({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? {},
      });
      emitted.add(tool.name);
      continue;
    }
    const live = declarable.get(tool.name);
    if (!live) {
      // Replayed but not executable this turn: inactive, hidden, filtered, or no longer registered.
      droppedNames.push(tool.name);
      continue;
    }
    declarable.delete(tool.name);
    // Keep pi's own replayed declaration text (it is what earlier turns saw) but only under a name
    // the live session will accept; the registry definition fills any field the replay lacks.
    const reconciled: ToolDeclaration = {
      name: tool.name,
      description: tool.description || live.description,
      parameters:
        tool.parameters && Object.keys(tool.parameters).length > 0 ? tool.parameters : live.parameters,
    };
    declaredTools.push(reconciled);
    customTools.push(reconciled);
    emitted.add(tool.name);
  }

  // Active and registered but absent from the replay: the drop direction of the same invariant.
  for (const [name, live] of declarable) {
    if (emitted.has(name)) continue;
    declaredTools.push(live);
    customTools.push(live);
    emitted.add(name);
  }

  return { declaredTools, customTools, droppedNames, registryUnreadable, activeSetUnreadable };
}

/** What the bridge should do with a `tool_use` block the Droid CLI just requested. */
export type ToolRequestDisposition =
  /** Emit the tool call under its own name; the request's name selects the handler. */
  | "execute"
  /** Refuse explicitly: the name is a Fusion coordination tool this turn cannot execute. */
  | "guard"
  /** Keep skipping: an internal Claude Code tool pi cannot execute and Fusion never declared. */
  | "skip";

/**
 * Decide a tool request from its own name alone.
 *
 * `declaredToolNames` is the reconciled surface of this turn, so a name that is merely *visible* in
 * the Droid CLI's own resumed transcript is not enough to execute. A declared custom name arriving
 * without the MCP prefix executes under its own name rather than being dropped, because pi's lookup
 * is by exact name and the handler exists; an undeclared coordination name is refused out loud.
 *
 * An undefined `declaredToolNames` means the caller has no surface to offer, so no claim about
 * availability can be made in either direction and every pi-known or custom-shaped name passes
 * through name-faithfully, which is the historic behavior. Passing an empty set is the opposite
 * statement (the turn declares nothing) and it guards every coordination request.
 */
export function resolveToolRequestDisposition(
  claudeToolName: string,
  declaredToolNames: ReadonlySet<string> | undefined,
): ToolRequestDisposition {
  const name = typeof claudeToolName === "string" ? claudeToolName : "";
  if (!name) return "skip";

  const isMcpCustom = name.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
  const piName = isMcpCustom || isPiKnownDroidTool(name) ? mapDroidToolNameToPi(name) : name;
  const isFusionTool = piName.startsWith(FUSION_TOOL_NAME_PREFIX);
  const availabilityKnown = declaredToolNames !== undefined;

  if (isMcpCustom) {
    if (!availabilityKnown) return "execute";
    return declaredToolNames.has(piName) ? "execute" : "guard";
  }
  if (isBuiltinClaudeTool(name)) return "execute";
  if (isFusionTool) {
    if (!availabilityKnown) return "execute";
    return declaredToolNames.has(piName) ? "execute" : "guard";
  }
  return "skip";
}

/** Whether the Claude-side name is one of the six coding tools pi owns. */
function isBuiltinClaudeTool(claudeToolName: string): boolean {
  if (!isPiKnownDroidTool(claudeToolName)) return false;
  return BUILT_IN_TOOL_NAMES.has(mapDroidToolNameToPi(claudeToolName));
}
