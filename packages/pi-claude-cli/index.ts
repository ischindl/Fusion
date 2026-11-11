/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

/*
 * FNXC:ModelCatalog 2026-07-01-17:30:
 * pi-ai 0.80 restructured its static catalog API: the top-level `getModels`
 * export moved to the deprecated `/compat` shim, and the canonical accessor is
 * `getBuiltinModels` from `@earendil-works/pi-ai/providers/all`. pi-claude-cli
 * now pins `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to
 * `^0.80.3` (matching cli/engine) so the whole extension resolves one pi-ai
 * version and the ExtensionAPI stream types stay compatible.
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import { streamViaAcp } from "./src/acp-driver.js";
import {
  validateCliPresenceAsync,
  validateCliAuthAsync,
  killAllProcesses,
} from "./src/process-manager.js";
import { createHash } from "node:crypto";
import {
  toolsFromContext,
  writeMcpConfig,
  buildAcpMcpServers,
  type McpToolDef,
  type UserMcpServerSpec,
} from "./src/mcp-config.js";
import {
  TOOL_NOT_AVAILABLE_MARKER,
  reconcileToolSurface,
  type ReconciledToolSurface,
} from "./src/tool-surface.js";

/**
 * FNXC:pi-claude-cli 2026-06-27-06:39:
 * Route A drives Claude through the ACP bridge only when `FUSION_CLAUDE_ACP=1`
 * AND a bridge binary path is injected via `FUSION_CLAUDE_ACP_BRIDGE`.
 * OFF by default: the live `claude -p` path stays untouched until soak.
 */
function resolveAcpBridgePath(): string | undefined {
  if (process.env.FUSION_CLAUDE_ACP !== "1") return undefined;
  const p = process.env.FUSION_CLAUDE_ACP_BRIDGE;
  return typeof p === "string" && p.length > 0 ? p : undefined;
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
 * Resolve the custom MCP defs for the ACP route from the reconciled surface.
 *
 * FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 * RUFU-520. This used to re-derive the surface itself (`toolsFromContext(contextTools)`, then
 * `getCustomToolDefs(pi)` when that came back empty), which is the same drift in a second place:
 * two authorities for one request, disagreeing per call. The ACP route now consumes the same
 * reconciled surface the `-p` route declares, so both transports see one list.
 */
function resolveToolDefs(surface: ReconciledToolSurface): McpToolDef[] {
  if (surface.registryUnreadable) return [];
  return toolsFromContext(surface.customTools);
}

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

/**
 * FNXC:pi-claude-cli 2026-06-27-06:39:
 * The factory runs per `createFnAgent` call, which the dashboard does for each
 * chat message. Synchronous `execSync` presence + auth probes froze the Node
 * event loop while `claude` cold-started, so memoize the probes as an async
 * Promise: the factory returns immediately, the result logs once, and later
 * calls reuse it.
 */
let cliValidationPromise: Promise<void> | undefined;

function runCliValidationOnce(): Promise<void> {
  if (cliValidationPromise) return cliValidationPromise;
  cliValidationPromise = (async () => {
    const presence = await validateCliPresenceAsync();
    if (!presence.ok) {
      console.warn(`[pi-claude-cli] ${presence.error.message}`);
      return;
    }
    await validateCliAuthAsync();
  })();
  return cliValidationPromise;
}

let cachedMcpConfig: { hash: string; configPath: string } | undefined;
const DEBUG_MCP = process.env.PI_CLAUDE_CLI_DEBUG === "1";

function debugMcp(message: string): void {
  if (!DEBUG_MCP) return;
  console.error(`[pi-claude-cli] ${message}`);
}

function getUserMcpServers(options: unknown): UserMcpServerSpec[] {
  const servers = (options as { mcpServers?: unknown } | undefined)?.mcpServers;
  return Array.isArray(servers) ? servers.filter((server): server is UserMcpServerSpec => Boolean(server && typeof server === "object" && "name" in server)) : [];
}

/**
 * Write (or reuse) the MCP config file that declares this turn's custom tools to the Claude CLI.
 *
 * FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 * RUFU-520 primary fix: every prior-state return in this function is gone. It used to answer
 * `return cachedMcpConfig?.configPath` when the transcript replay yielded no custom defs and
 * `pi.getAllTools()` was not an array, and again from its `catch`, and it re-served the cached path
 * whenever a hash matched. A call whose own derivation failed was therefore served the file an
 * earlier call had written, declaring that earlier call's tools, and because the hash was computed
 * from whatever that stale list was, one bad derivation then persisted for the rest of the run.
 * That is the drift the sightings recorded: `fn_list_agents` invisible for a whole session while
 * `read` stayed visible, so the model called `read` on a fabricated `/fusion/fn_read_messages`
 * path and the board consumed a fabricated observation as a real coordination result.
 *
 * The contract now: the surface is derived from the live session by `reconcileToolSurface` in
 * `tool-surface.ts` (one call per `streamSimple`), and a derivation that cannot prove its surface
 * declares *nothing* rather than guessing. `undefined` means the CLI runs with pi's built-ins only,
 * which is an honest "no coordination tools available this turn"; a stale file would instead assert
 * that tools exist which this run cannot execute, or hide tools it can. The cache is cleared on
 * every such path so the next turn re-derives instead of inheriting the failure. The cache-hit
 * branch is the only path that still returns a stored path, and only because the derived defs are
 * byte-identical to the ones that produced that file.
 *
 * Source of truth, in order:
 * 1. `pi.getActiveTools()` names (what pi will accept this turn), intersected with
 *    `pi.getAllTools()` definitions (the schemas), minus pi's six built-ins and minus any name pi
 *    refuses to declare (`hidden`, `codemode`, `deferred`).
 * 2. The transcript replay supplies the declaration *text* for names already proven member-only;
 *    it is never consulted for membership.
 *
 * Uses warn-don't-block: a failed write logs and degrades to built-ins, it never blocks the send.
 */
function ensureMcpConfig(
  surface: ReconciledToolSurface,
  userMcpServers: UserMcpServerSpec[] = [],
): string | undefined {
  try {
    if (surface.registryUnreadable) {
      console.warn(
        `${TOOL_NOT_AVAILABLE_MARKER}: pi.getAllTools() returned no array, so this turn declares no custom MCP tools. A previously written config is deliberately not reused.`,
      );
      cachedMcpConfig = undefined;
      return undefined;
    }

    const toolDefs = toolsFromContext(surface.customTools);

    if (toolDefs.length === 0 && userMcpServers.length === 0) {
      // Nothing is active and registered under this session's own authority. Declare nothing.
      cachedMcpConfig = undefined;
      return undefined;
    }

    if (surface.droppedNames.length > 0) {
      debugMcp(
        `dropped replayed tool(s) not executable this turn: ${surface.droppedNames.join(", ")}`,
      );
    }

    const hash = createHash("sha1")
      .update(JSON.stringify({ toolDefs, userMcpServerNames: userMcpServers.map((server) => server.name) }))
      .digest("hex")
      .slice(0, 12);

    if (cachedMcpConfig?.hash === hash) {
      debugMcp(`MCP config cache hit (hash=${hash})`);
      return cachedMcpConfig.configPath;
    }

    const configPath = writeMcpConfig(toolDefs, hash, userMcpServers);
    cachedMcpConfig = { hash, configPath };
    const toolNames = toolDefs.map((t) => t.name).join(", ");
    debugMcp(
      `MCP config refreshed with ${toolDefs.length} custom tool(s) [${toolNames}] (hash=${hash})`,
    );
    return configPath;
  } catch (err) {
    console.warn(
      `${TOOL_NOT_AVAILABLE_MARKER}: MCP config generation failed, so this turn declares no custom MCP tools rather than reusing a previous config:`,
      err,
    );
    cachedMcpConfig = undefined;
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation: kick off async, memoized presence + auth probes
    // without blocking the factory. Failures surface via warnings; the actual
    // `claude` subprocess in streamViaCli still reports hard errors on send.
    void runCliValidationOnce();

    const catalogModels = getBuiltinModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    // The installed Pi catalog is the sole source for Claude CLI model metadata.
    const models = catalogModels;

    /*
    FNXC:AgentCwdBoundary 2026-10-18-10:29:
    RUFU-334: pi's `SimpleStreamOptions` carries NO `cwd` field (upstream pi
    1.1.0 `ProviderRequestOptions` is signal/apiKey/fetch/env/headers/sessionId
    only), so `options.cwd` was never populated in a hosted run and both Claude
    transports silently fell back to `process.cwd()` — the directory the engine or
    dashboard process was launched from, which on the incident host was a live
    production deployment checkout. pi DOES hand the session's own working
    directory to every event handler through `ExtensionContext.cwd`, so the
    extension now latches it here and passes it explicitly to the transports.
    Deliberately NOT a `process.cwd()` fallback: an unreadable lane must fail
    loudly rather than repeat the incident.
    */
    let sessionCwd: string | undefined;
    /** Latch pi's session working directory from any event context that carries it. */
    function noteSessionCwd(ctx: ExtensionContext): void {
      if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) sessionCwd = ctx.cwd;
    }

    // Ensure all registered tools are active so pi can execute them.
    // Some tools (find, grep, ls) are registered but not activated by default.
    pi.on("session_start", async (_event, ctx) => {
      noteSessionCwd(ctx);
      const allTools = pi.getAllTools();
      if (Array.isArray(allTools)) {
        pi.setActiveTools(allTools.map((t: { name: string }) => t.name));
      }
    });

    /*
    FNXC:AgentCwdBoundary 2026-10-18-10:29:
    RUFU-334. `turn_start` re-reads the cwd every turn, so a fork, resume, or in-session
    switch that pi never re-announces to this extension still cannot leave a stale cwd
    behind; `agent_start` covers lanes that stream without a turn boundary.
    */
    pi.on("turn_start", (_event, ctx) => { noteSessionCwd(ctx); });
    pi.on("agent_start", (_event, ctx) => { noteSessionCwd(ctx); });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: (model, context, options) => {
        /*
        FNXC:PiTranscriptBridge 2026-10-04-07:28:
        Pi 0.86 replaces the retired Context.tools field with transcript system-message deltas. Replay the current prompt and tool declarations before building either local CLI bridge so resumed and branched sessions retain their latest instructions and MCP schemas.

        FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
        RUFU-520: the replay is now only the *text* source. `reconcileToolSurface` decides
        membership from `pi.getActiveTools()` intersected with `pi.getAllTools()`, so the surface
        declared to the CLI is the session's current one, and `cliContext.tools` carries that
        reconciled list rather than the raw replay. Prompt adapters that read `cliContext.tools` to
        name MCP tools therefore cannot advertise a tool the request does not declare, nor omit one
        it does. One derivation per call, consumed by both transports.
        */
        const contextTools = normalizeTranscriptTools(getCurrentTools(context.messages));
        const surface = reconcileToolSurface(pi, contextTools);
        // FNXC:PiTranscriptBridge 2026-09-20-17:02: Prompt adapters still consume Context.tools for MCP tool-name instructions, so forward Pi's normalized current transcript tools after replacing its retired source field.
        const cliContext = { ...context, systemPrompt: getCurrentSystemPrompt(context.messages), tools: surface.declaredTools };

        /*
        FNXC:AgentCwdBoundary 2026-10-18-10:29:
        RUFU-334: an explicit caller-supplied `cwd` always wins; otherwise use the session
        directory latched from pi's event context. Never `process.cwd()` — the transports
        refuse a still-missing value rather than inherit the host launch directory. Read
        structurally because upstream pi's `SimpleStreamOptions` declares no `cwd` field at
        all; a caller that names a directory (the engine registration seam) extends that
        shape rather than replaces it.
        */
        const agentCwd = (options as { cwd?: string } | undefined)?.cwd ?? sessionCwd;

        // FNXC:pi-claude-cli 2026-06-27-06:39: Route A drives Claude through the ACP bridge only when the kill-switch is on AND a bridge path is injected. OFF by default → `-p` path below.
        const bridgePath = resolveAcpBridgePath();
        if (bridgePath) {
          const toolDefs = resolveToolDefs(surface);
          const userMcpServers = getUserMcpServers(options);
          const hash = createHash("sha1").update(JSON.stringify({ toolDefs, userMcpServerNames: userMcpServers.map((server) => server.name) })).digest("hex").slice(0, 12);
          return streamViaAcp(model, cliContext as never, {
            ...options,
            cwd: agentCwd,
            bridgePath,
            mcpServers: buildAcpMcpServers(toolDefs, hash, userMcpServers),
            // FNXC:pi-claude-cli 2026-06-27-06:39: Forward only HOME/PATH so the bridged `claude` authenticates from the login/keychain session (R17); never inherited process.env or API keys.
            bridgeEnv: { HOME: process.env.HOME, PATH: process.env.PATH },
          });
        }

        const configPath = ensureMcpConfig(surface, getUserMcpServers(options));
        return streamViaCli(model, cliContext as never, {
          ...options,
          cwd: agentCwd,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
