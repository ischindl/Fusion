import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  streamViaCli,
  discoverDroidModels,
  validateCliPresenceAsync,
  validateCliAuthAsync,
  killAllProcesses,
  toolsFromContext,
  writeMcpConfig,
  TOOL_NOT_AVAILABLE_MARKER,
  reconcileToolSurface,
  type McpToolDef,
  type ReconciledToolSurface,
} from "@fusion-plugin-examples/droid-runtime";
import { createHash } from "node:crypto";

process.on("exit", killAllProcesses);

const PROVIDER_ID = "droid-cli";

let cliValidationPromise: Promise<void> | undefined;
type DiscoveredModel = { id: string; name: string; reasoning: boolean; input: Array<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
let discoveredModelsPromise: Promise<DiscoveredModel[]> | undefined;
type StreamSimpleHandler = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]>;

function runCliValidationOnce(): Promise<void> {
  if (cliValidationPromise) return cliValidationPromise;
  cliValidationPromise = (async () => {
    try {
      const presence = await validateCliPresenceAsync();
      if (!presence.ok) {
        console.warn(`[droid-cli] ${presence.error.message}`);
        return;
      }
      await validateCliAuthAsync();
    } catch (error) {
      console.warn("[droid-cli] CLI validation failed; continuing without blocking the session", error);
    }
  })();
  return cliValidationPromise;
}

export async function discoverDroidProviderModels() {
  if (!discoveredModelsPromise) {
    discoveredModelsPromise = (async () => {
      try {
        const ids = Array.from(new Set(await discoverDroidModels()));
        if (ids.length === 0) return [];
        return toProviderModels(ids);
      } catch (error) {
        console.warn("[droid-cli] model auto-discovery failed; registering provider with empty model list", error);
        return [];
      }
    })();
  }
  return discoveredModelsPromise;
}

let cachedMcpConfig: { hash: string; configPath: string } | undefined;

function toProviderModels(ids: string[]): DiscoveredModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  }));
}

/** Project pi's own transcript replay onto the flat shape this package declares. */
function normalizeTranscriptTools(tools: ReturnType<typeof getCurrentTools>): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: Object.fromEntries(Object.entries(tool.parameters)),
  }));
}

/**
 * Write (or reuse) the MCP config file that declares this turn's custom tools to the Droid CLI.
 *
 * FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 * RUFU-520 primary fix, mirrored from the pi-claude-cli bridge so both clones honor one invariant.
 * The two `return cachedMcpConfig?.configPath` answers are gone: one fired when the replay yielded
 * no custom defs and `pi.getAllTools()` was not an array, the other from the `catch`. Each served an
 * earlier call's tool list to a call that could not derive its own, and the hash being computed from
 * that stale list made the drift stick for the rest of the run. A derivation that cannot prove its
 * surface now declares nothing - the honest "no coordination tools this turn" - and clears the cache
 * so the next call re-derives. The cache-hit branch is the only one that returns a stored path, and
 * only while the derived defs are byte-identical to the ones that produced that file.
 */
function ensureMcpConfig(surface: ReconciledToolSurface): string | undefined {
  try {
    if (surface.registryUnreadable) {
      console.warn(
        `${TOOL_NOT_AVAILABLE_MARKER}: pi.getAllTools() returned no array, so this turn declares no custom MCP tools. A previously written config is deliberately not reused.`,
      );
      cachedMcpConfig = undefined;
      return undefined;
    }

    const toolDefs: McpToolDef[] = toolsFromContext(surface.customTools);

    if (toolDefs.length === 0) {
      // Nothing is active and registered under this session's own authority. Declare nothing.
      cachedMcpConfig = undefined;
      return undefined;
    }

    const hash = createHash("sha1").update(JSON.stringify(toolDefs)).digest("hex").slice(0, 12);
    if (cachedMcpConfig?.hash === hash) return cachedMcpConfig.configPath;

    const configPath = writeMcpConfig(toolDefs, hash);
    cachedMcpConfig = { hash, configPath };
    return configPath;
  } catch (error) {
    console.warn(
      `${TOOL_NOT_AVAILABLE_MARKER}: MCP config generation failed, so this turn declares no custom MCP tools rather than reusing a previous config:`,
      error,
    );
    cachedMcpConfig = undefined;
    return undefined;
  }
}

function registerDroidProvider(pi: ExtensionAPI, models: DiscoveredModel[]) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "droid-cli",
    apiKey: "unused",
    api: "droid-cli",
    models,
    streamSimple: ((model, context, options) => {
      void runCliValidationOnce();
      /*
      FNXC:PiTranscriptBridge 2026-09-20-16:20:
      Pi 0.86 carries prompt and tool changes in transcript system messages rather than Context.tools. Replay the current state so Droid receives the active prompt and MCP schema after resume or branching.

      FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
      RUFU-520: the replay is only the text source. `reconcileToolSurface` decides membership from
      `pi.getActiveTools()` intersected with `pi.getAllTools()`, so what the Droid CLI is configured
      with is the session's current surface, and `cliContext.tools` carries that reconciled list
      rather than the raw replay - the prompt cannot advertise a tool the request does not declare.
      */
      const contextTools = normalizeTranscriptTools(getCurrentTools(context.messages));
      const surface = reconcileToolSurface(pi, contextTools);
      const configPath = ensureMcpConfig(surface);
      // FNXC:PiTranscriptBridge 2026-09-20-17:02: Droid's prompt adapter reads Context.tools for MCP instructions, so preserve the normalized transcript declarations in its compatibility context.
      const cliContext = { ...context, systemPrompt: getCurrentSystemPrompt(context.messages), tools: surface.declaredTools };
      return streamViaCli(
        model,
        cliContext as never,
        { ...(options ?? {}), mcpConfigPath: configPath } as never,
      ) as unknown as ReturnType<StreamSimpleHandler>;
    }) as StreamSimpleHandler,
  });
}

export default function (pi: ExtensionAPI) {
  /*
  FNXC:CliRuntime 2026-06-21-18:43:
  Engine and dashboard startup must not start the local Droid CLI merely because the optional extension loaded. Register the provider synchronously with an empty model list, defer validation until an actual droid stream starts, and leave model discovery to explicit picker/status callers so boot with `useDroidCli` enabled still performs zero `droid` spawns.

  FNXC:CliRuntime 2026-06-21-12:00:
  Engine and dashboard startup must not wait for local Droid CLI probes. Every surviving validation/discovery helper remains fire-and-forget, bounded, non-interactive, and resolve-only so a missing or wedged `droid` binary cannot stall extension loading or a session start.
  */

  pi.on("session_start", async () => {
    const allTools = pi.getAllTools();
    if (Array.isArray(allTools)) {
      pi.setActiveTools(allTools.map((t: { name: string }) => t.name));
    }
  });

  try {
    registerDroidProvider(pi, []);
  } catch (err) {
    console.error("[droid-cli] Failed to register provider:", err);
  }
}
