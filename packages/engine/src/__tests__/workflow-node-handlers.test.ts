import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import { createDefaultNodeHandlers } from "../workflow-node-handlers.js";

const task = { id: "FN-5767" } as TaskDetail;
const node = (kind: WorkflowIrNode["kind"], seam?: string): WorkflowIrNode => ({ id: kind, kind, config: seam ? { seam } : {} });

describe("workflow node handlers", () => {
  it("dispatches prompt node to matching seam", async () => {
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success" as const })),
      execute: vi.fn(async () => ({ outcome: "success" as const })),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: vi.fn(async () => ({ outcome: "success" as const })),
    };
    const handlers = createDefaultNodeHandlers(seams);
    await handlers.prompt(node("prompt", "review"), { task, settings: undefined, context: {} });
    expect(seams.review).toHaveBeenCalledOnce();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it("dispatches script node to matching seam", async () => {
    const seams = {
      planning: vi.fn(async () => ({ outcome: "success" as const })),
      execute: vi.fn(async () => ({ outcome: "success" as const })),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: vi.fn(async () => ({ outcome: "success" as const })),
    };
    const handlers = createDefaultNodeHandlers(seams);
    await handlers.script(node("script", "execute"), { task, settings: undefined, context: {} });
    expect(seams.execute).toHaveBeenCalledOnce();
  });

  it("gate returns failure when expected context value does not match", async () => {
    const handlers = createDefaultNodeHandlers({
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
    });

    const result = await handlers.gate(
      { id: "g", kind: "gate", config: { contextKey: "phase", expect: "merge" } },
      { task, settings: undefined, context: { phase: "review" } },
    );

    expect(result).toEqual({ outcome: "failure", value: "gate-mismatch" });
  });

  const noopSeams = () => ({
    planning: vi.fn(async () => ({ outcome: "success" as const })),
    execute: vi.fn(async () => ({ outcome: "success" as const })),
    review: vi.fn(async () => ({ outcome: "success" as const })),
    merge: vi.fn(async () => ({ outcome: "success" as const })),
    schedule: vi.fn(async () => ({ outcome: "success" as const })),
  });

  it("dispatches a custom (non-seam) prompt node to the custom-node runner", async () => {
    const seams = noopSeams();
    const runCustomNode = vi.fn(async () => ({ outcome: "success" as const, value: "APPROVE" }));
    const handlers = createDefaultNodeHandlers(seams, runCustomNode);

    const customNode: WorkflowIrNode = { id: "spec-check", kind: "prompt", config: { prompt: "Check the spec" } };
    const result = await handlers.prompt(customNode, { task, settings: undefined, context: {} });

    expect(runCustomNode).toHaveBeenCalledWith(customNode, task, {});
    expect(result.value).toBe("APPROVE");
    expect(seams.execute).not.toHaveBeenCalled();
    expect(seams.review).not.toHaveBeenCalled();
  });

  it("dispatches a custom script node to the custom-node runner", async () => {
    const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "exit-1" }));
    const handlers = createDefaultNodeHandlers(noopSeams(), runCustomNode);

    const result = await handlers.script(
      { id: "lint", kind: "script", config: { scriptName: "lint" } },
      { task, settings: undefined, context: {} },
    );

    expect(runCustomNode).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("failure");
  });

  it("throws for a custom node when no runner is registered", async () => {
    const handlers = createDefaultNodeHandlers(noopSeams());
    await expect(
      handlers.prompt({ id: "p", kind: "prompt", config: { prompt: "x" } }, { task, settings: undefined, context: {} }),
    ).rejects.toThrow(/custom-node runner/i);
  });

  it("throws for an unknown seam string", async () => {
    const handlers = createDefaultNodeHandlers(noopSeams(), vi.fn());
    await expect(
      handlers.prompt(node("prompt", "deploy"), { task, settings: undefined, context: {} }),
    ).rejects.toThrow(/Unsupported workflow seam/i);
  });

  it("runs an executable gate (prompt-backed) through the runner and gates on its outcome", async () => {
    const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "REVISE" }));
    const handlers = createDefaultNodeHandlers(noopSeams(), runCustomNode);

    const result = await handlers.gate(
      { id: "quality-gate", kind: "gate", config: { prompt: "Block on regressions", gateMode: "gate" } },
      { task, settings: undefined, context: {} },
    );

    expect(runCustomNode).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("failure");
  });

  it("context gate still takes precedence over executable config", async () => {
    const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const }));
    const handlers = createDefaultNodeHandlers(noopSeams(), runCustomNode);

    const result = await handlers.gate(
      { id: "g", kind: "gate", config: { expect: "done", contextKey: "phase", prompt: "x" } },
      { task, settings: undefined, context: { phase: "done" } },
    );

    expect(result.outcome).toBe("success");
    expect(runCustomNode).not.toHaveBeenCalled();
  });
});
