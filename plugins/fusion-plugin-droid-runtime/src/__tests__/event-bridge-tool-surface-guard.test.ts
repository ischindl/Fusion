import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * RUFU-520. The bridge must refuse an unavailable coordination tool out loud, under the requested
 * name, and never let another tool's result stand in for it.
 *
 * Before the fix an unknown or undeclared tool_use was dropped by `return`ing in
 * handleContentBlockStart. The visible consequence at the turn level: `provider.ts` rewrote
 * `stopReason: "toolUse"` to `"stop"` because no tool call survived, so an agent mid-run simply
 * lost its coordination call and the transcript carried no trace of it.
 */

vi.mock("@earendil-works/pi-ai", () => ({
  calculateCost: vi.fn(),
}));

import { createEventBridge } from "../event-bridge.js";

function createMockStream() {
  const events: Array<Record<string, unknown>> = [];
  return { push: vi.fn((event: Record<string, unknown>) => events.push(event)), end: vi.fn(), events };
}

const MODEL = { id: "droid-pro", provider: "anthropic", model: "droid-pro" } as never;

function bridgeFor(declaredToolNames: string[] | undefined) {
  const stream = createMockStream();
  const bridge = createEventBridge(stream as never, MODEL, declaredToolNames ? { declaredToolNames } : undefined);
  bridge.handleEvent({ type: "message_start", message: { usage: {} } } as never);
  return { stream, bridge };
}

/** Feed one tool_use block with the given Claude-side name and empty arguments. */
function emitToolUse(bridge: { handleEvent(event: unknown): void }, claudeName: string, index = 0) {
  bridge.handleEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: `toolu_${index}`, name: claudeName },
  });
  bridge.handleEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: "{\"id\":\"FN-1\"}" },
  });
  bridge.handleEvent({ type: "content_block_stop", index });
}

function pushedText(stream: ReturnType<typeof createMockStream>): string {
  return stream.events
    .filter((event) => event.type === "text_delta")
    .map((event) => String((event as { delta?: string }).delta ?? ""))
    .join("");
}

describe("event bridge tool-request guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a declared custom tool call unchanged", () => {
    const { stream, bridge } = bridgeFor(["read", "fn_task_show"]);

    emitToolUse(bridge, "mcp__custom-tools__fn_task_show");

    const types = stream.events.map((event) => event.type);
    expect(types).toContain("toolcall_start");
    const toolCall = bridge.getOutput().content[0] as { type: string; name: string };
    expect(toolCall).toMatchObject({ type: "toolCall", name: "fn_task_show" });
  });

  it("refuses an MCP-prefixed coordination tool the turn does not declare, by name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stream, bridge } = bridgeFor(["read"]);

    emitToolUse(bridge, "mcp__custom-tools__fn_list_agents");

    const text = pushedText(stream);
    expect(text).toContain("TOOL_NOT_AVAILABLE");
    expect(text).toContain("fn_list_agents");
    expect(text).toContain("no handler ran");
    // No tool call of any kind reaches pi, so no other handler can answer for it.
    expect(stream.events.map((event) => event.type)).not.toContain("toolcall_start");
    expect(bridge.getOutput().content.some((block) => block.type === "toolCall")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TOOL_NOT_AVAILABLE"));
    warn.mockRestore();
  });

  it("refuses a bare fn_ name that is not declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stream, bridge } = bridgeFor(["read"]);

    emitToolUse(bridge, "fn_list_agents");

    expect(pushedText(stream)).toContain("TOOL_NOT_AVAILABLE: fn_list_agents");
    expect(bridge.getOutput().content.some((block) => block.type === "toolCall")).toBe(false);
    warn.mockRestore();
  });

  it("executes a declared coordination tool named without the MCP prefix", () => {
    const { stream, bridge } = bridgeFor(["read", "fn_task_show"]);

    emitToolUse(bridge, "fn_task_show");

    expect(stream.events.map((event) => event.type)).toContain("toolcall_start");
    expect(bridge.getOutput().content[0]).toMatchObject({ type: "toolCall", name: "fn_task_show" });
  });

  it("keeps skipping internal CLI Code tools without announcing them", () => {
    const { stream, bridge } = bridgeFor(["read", "fn_task_show"]);

    emitToolUse(bridge, "ToolSearch");

    expect(bridge.getOutput().content).toEqual([]);
    expect(pushedText(stream)).toBe("");
  });

  it("always lets the built-ins through, since pi executes them natively", () => {
    const { stream, bridge } = bridgeFor([]);

    emitToolUse(bridge, "Read");

    expect(bridge.getOutput().content[0]).toMatchObject({ type: "toolCall", name: "read" });
    expect(stream.events.map((event) => event.type)).toContain("toolcall_start");
  });

  it("never routes a guarded request through another tool's handler", () => {
    // The fabricated observation in the sighting was `read` against `/fusion/fn_read_messages`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge } = bridgeFor(["read"]);

    emitToolUse(bridge, "mcp__custom-tools__fn_read_messages", 0);
    emitToolUse(bridge, "Read", 1);

    const blocks = bridge.getOutput().content;
    // The guard occupies its own block; the real Read call keeps its own name and arguments, so
    // neither call can be reported as the other.
    expect(blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("fn_read_messages") });
    expect(blocks[1]).toMatchObject({ type: "toolCall", name: "read" });
    warn.mockRestore();
  });

  it("passes every shape through when the caller supplies no surface", () => {
    // Historic behavior for a caller that has no availability claim to make (a unit harness). Every
    // production transport passes a surface, and bridge-clone-parity.test.ts asserts each call site
    // still does, so this passthrough cannot quietly become a lane again.
    const { bridge } = bridgeFor(undefined);

    emitToolUse(bridge, "mcp__custom-tools__fn_anything");

    expect(bridge.getOutput().content[0]).toMatchObject({ type: "toolCall", name: "fn_anything" });
  });

  it("guards every coordination request when the surface is empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge } = bridgeFor([]);

    emitToolUse(bridge, "mcp__custom-tools__fn_task_show");

    expect(bridge.getOutput().content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("TOOL_NOT_AVAILABLE"),
    });
    warn.mockRestore();
  });

  /*
   FNXC:ToolDispatchIntegrity 2026-11-11-05:24:
   RUFU-520, the acceptance shape the report demanded: two DIFFERENT coordination tools issued
   back-to-back immediately after a coding-tool call, the exact recipe in the sightings ("compare a
   call against the handler that actually ran, once several coding-tool calls have established a last
   used tool"). One of the two is declared and one is not, so the case pins both halves of the
   invariant at once: a declared coordination call still executes under its own name and its own
   arguments after a coding-tool call, and an undeclared one is refused under ITS own name. There is
   no shared slot for a name or an argument to leak through, because each request is classified from
   its own content_block and appended as its own output block.
  */
  it("routes two back-to-back coordination calls after a coding-tool call, each by its own name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge } = bridgeFor(["Read", "Edit", "fn_task_show"]);

    // A coding-tool call first, to establish any prior-call state the runtime could leak.
    emitToolUse(bridge, "Read", 0);
    // Then two coordination calls naming different tools, only one of which this turn declares.
    emitToolUse(bridge, "mcp__custom-tools__fn_task_show", 1);
    emitToolUse(bridge, "mcp__custom-tools__fn_read_messages", 2);

    const blocks = bridge.getOutput().content;
    expect(blocks[0]).toMatchObject({ type: "toolCall", name: "read" });
    expect(blocks[1]).toMatchObject({ type: "toolCall", name: "fn_task_show" });
    expect(blocks[2]).toMatchObject({
      type: "text",
      text: expect.stringContaining("TOOL_NOT_AVAILABLE: fn_read_messages"),
    });
    // Neither coordination call was answered by the coding tool: exactly one read call exists.
    const readCalls = blocks.filter(
      (block) => (block as { name?: string }).name === "read",
    );
    expect(readCalls).toHaveLength(1);
    warn.mockRestore();
  });
});
