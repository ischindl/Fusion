import { describe, it, expect } from "vitest";
import {
  TOOL_NOT_AVAILABLE_MARKER,
  reconcileToolSurface,
  resolveToolRequestDisposition,
  toolNotAvailableMessage,
} from "../tool-surface.js";

/**
 * RUFU-520. The surface a turn declares must come from that turn's own session state.
 *
 * These cases encode both drift directions the sightings showed, plus the refusal contract:
 * a tool that is visible but not executable is never declared, and a request for it is answered
 * with an explicit error instead of another tool's result.
 */

const BUILTIN_READ = { name: "read", description: "Read a file", parameters: { type: "object" } };

function registryTool(name: string, exposure?: string) {
  return {
    name,
    description: `schema for ${name}`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    ...(exposure ? { exposure } : {}),
  };
}

function replayed(name: string) {
  return { name, description: `declared ${name}`, parameters: { type: "object" } };
}

function piApi(options: {
  registry?: unknown;
  active?: unknown;
}) {
  return {
    getAllTools: () => options.registry,
    getActiveTools: () => options.active,
  };
}

describe("reconcileToolSurface", () => {
  it("declares a tool the replay lacks when the session has it active and registered", () => {
    // The drop direction: an active tool absent from the replayed set must still be declared,
    // because the prompt will name it and pi will accept it.
    const surface = reconcileToolSurface(
      piApi({ registry: [registryTool("fn_task_show")], active: ["read", "fn_task_show"] }),
      [BUILTIN_READ],
    );

    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_task_show"]);
    expect(surface.declaredTools.map((tool) => tool.name)).toEqual(["read", "fn_task_show"]);
    expect(surface.droppedNames).toEqual([]);
  });

  it("drops a replayed tool that is no longer active, recording the name", () => {
    const surface = reconcileToolSurface(
      piApi({ registry: [registryTool("fn_list_agents")], active: ["read"] }),
      [BUILTIN_READ, replayed("fn_list_agents")],
    );

    expect(surface.customTools).toEqual([]);
    expect(surface.droppedNames).toEqual(["fn_list_agents"]);
    expect(surface.declaredTools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("drops a replayed tool that is no longer registered at all", () => {
    const surface = reconcileToolSurface(
      piApi({ registry: [], active: ["read"] }),
      [BUILTIN_READ, replayed("fn_send_message")],
    );

    expect(surface.customTools).toEqual([]);
    expect(surface.droppedNames).toEqual(["fn_send_message"]);
  });

  it("never declares a hidden or codemode tool even when the active set names it", () => {
    // pi's own vocabulary: `hidden` is "registered but unreachable. Activating it has no effect",
    // and the active set can legitimately contain it (session_start activates every registered
    // name), so membership is filtered by exposure, not by the active set alone.
    const surface = reconcileToolSurface(
      piApi({
        registry: [registryTool("fn_secret", "hidden"), registryTool("fn_lazy", "codemode")],
        active: ["read", "fn_secret", "fn_lazy"],
      }),
      [replayed("fn_secret"), replayed("fn_lazy")],
    );

    expect(surface.customTools).toEqual([]);
    expect(surface.droppedNames).toEqual(["fn_secret", "fn_lazy"]);
  });

  it("declares direct and model-only exposures", () => {
    const surface = reconcileToolSurface(
      piApi({
        registry: [registryTool("fn_a", "direct"), registryTool("fn_b", "model-only")],
        active: ["fn_a", "fn_b"],
      }),
      [],
    );

    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_a", "fn_b"]);
  });

  it("keeps pi's replayed declaration text for a tool that is genuinely a member", () => {
    const surface = reconcileToolSurface(
      piApi({ registry: [registryTool("fn_task_show")], active: ["fn_task_show"] }),
      [replayed("fn_task_show")],
    );

    expect(surface.customTools[0]).toMatchObject({
      name: "fn_task_show",
      description: "declared fn_task_show",
    });
  });

  it("degrades to no custom tools, flagged, when the registry is unreadable", () => {
    // This is the branch that used to serve the previous turn's config file.
    const surface = reconcileToolSurface(
      piApi({ registry: undefined, active: ["read"] }),
      [BUILTIN_READ, replayed("fn_task_show")],
    );

    expect(surface.registryUnreadable).toBe(true);
    expect(surface.customTools).toEqual([]);
  });

  it("falls back to the registry when the active set is unreadable", () => {
    // Older or duck-typed pi hosts may not expose getActiveTools(); the registry is then the only
    // evidence, and hidden entries are still refused.
    const surface = reconcileToolSurface(
      piApi({ registry: [registryTool("fn_a"), registryTool("fn_hidden", "hidden")] }),
      [],
    );

    expect(surface.activeSetUnreadable).toBe(true);
    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_a"]);
  });

  it("tolerates a missing getActiveTools method entirely", () => {
    const surface = reconcileToolSurface(
      { getAllTools: () => [registryTool("fn_a")] },
      [replayed("fn_a")],
    );

    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_a"]);
  });

  it("excludes the built-ins from the custom surface but keeps them declared", () => {
    const surface = reconcileToolSurface(
      piApi({ registry: [BUILTIN_READ, registryTool("fn_a")], active: ["read", "fn_a"] }),
      [BUILTIN_READ],
    );

    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_a"]);
    expect(surface.declaredTools.map((tool) => tool.name)).toContain("read");
  });

  it("ignores registry entries with no usable name", () => {
    const surface = reconcileToolSurface(
      piApi({ registry: [{ description: "nameless" }, registryTool("fn_a")], active: ["fn_a"] }),
      [],
    );

    expect(surface.customTools.map((tool) => tool.name)).toEqual(["fn_a"]);
  });
});

describe("resolveToolRequestDisposition", () => {
  const declared = new Set(["read", "fn_task_show"]);

  it("executes an MCP-prefixed request whose pi name is declared", () => {
    expect(resolveToolRequestDisposition("mcp__custom-tools__fn_task_show", declared)).toBe("execute");
  });

  it("guards an MCP-prefixed request the turn does not declare", () => {
    expect(resolveToolRequestDisposition("mcp__custom-tools__fn_list_agents", declared)).toBe("guard");
  });

  it("executes a declared coordination tool named without the MCP prefix", () => {
    // The bridge used to discard these because only the prefixed shape was recognised.
    expect(resolveToolRequestDisposition("fn_task_show", declared)).toBe("execute");
  });

  it("guards an undeclared coordination tool named without the MCP prefix", () => {
    expect(resolveToolRequestDisposition("fn_list_agents", declared)).toBe("guard");
  });

  it("executes pi built-ins regardless of the declared set", () => {
    expect(resolveToolRequestDisposition("Read", declared)).toBe("execute");
    expect(resolveToolRequestDisposition("Glob", new Set())).toBe("execute");
  });

  it("skips internal Claude Code tools that pi cannot execute", () => {
    expect(resolveToolRequestDisposition("ToolSearch", declared)).toBe("skip");
    expect(resolveToolRequestDisposition("Task", declared)).toBe("skip");
  });

  it("passes everything through when the caller has no surface to offer", () => {
    // No surface means no claim about availability in either direction.
    expect(resolveToolRequestDisposition("mcp__custom-tools__fn_anything", undefined)).toBe("execute");
    expect(resolveToolRequestDisposition("fn_anything", undefined)).toBe("execute");
    expect(resolveToolRequestDisposition("ToolSearch", undefined)).toBe("skip");
  });

  it("guards every coordination request when the turn declares nothing", () => {
    const empty = new Set<string>(["read"]);
    expect(resolveToolRequestDisposition("mcp__custom-tools__fn_task_show", empty)).toBe("guard");
    expect(resolveToolRequestDisposition("fn_task_show", empty)).toBe("guard");
  });

  it("treats a malformed name as skipped rather than executing it", () => {
    expect(resolveToolRequestDisposition(undefined as unknown as string, declared)).toBe("skip");
    expect(resolveToolRequestDisposition("", declared)).toBe("skip");
  });
});

describe("toolNotAvailableMessage", () => {
  it("names the requested tool and carries the marker", () => {
    const message = toolNotAvailableMessage("fn_list_agents");

    expect(message).toContain(TOOL_NOT_AVAILABLE_MARKER);
    expect(message).toContain("fn_list_agents");
    // The whole point of the guard: it must not be readable as another tool's output.
    expect(message).not.toMatch(/\bread\b/);
    expect(message.toLowerCase()).toContain("no handler ran");
  });
});
