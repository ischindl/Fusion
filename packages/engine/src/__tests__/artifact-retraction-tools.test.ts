/*
FNXC:ArtifactRetraction 2026-11-11-12:24 (RUFU-433):
Symptom replica for the retraction surface, driven THROUGH THE TOOL SURFACE against a real PostgreSQL-backed
TaskStore. This is the reported failure, not a unit of it: a reviewer registers a review artifact, its claims
turn out false against the real head, and every later reader — the second reviewer, the merger, the operator —
still finds the false artifact through an ordinary `fn_artifact_list` and quotes it into a verdict, with no
way to withdraw it short of registering a second artifact that disclaims the first.

Why a real store and not the duck-typed fake used by `agent-artifact-tools.test.ts`: the fake would let the
mock decide what "hidden by default" means, so the test would pass while the store leaked tombstones through
some other read. The three facts that actually matter here are store facts reached only through the tool's
own call path — that the default list omits the row, that the opt-in list returns it labelled VOID, and that
`fn_artifact_view` answers with a header instead of the body.

Each case is a whole loop (register → retract → read again), because a retraction whose tool call succeeds
while a read path still serves the content is precisely how a tombstone becomes decorative.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createArtifactListTool,
  createArtifactRegisterTool,
  createArtifactRetractTool,
  createArtifactViewTool,
  createChatArtifactTools,
} from "../agent-tools.js";

/*
FNXC:ArtifactRetraction 2026-11-11-12:25 (RUFU-433): engine tests import `@fusion/core` through the shared
mock wrapper (as `agent-artifact-tools.test.ts` and `agent-tools-intake-column.test.ts` both do) so the
storage-root seams resolve to the test harness instead of a real project root. Without it the register
half of this loop fails on artifact storage resolution and the retraction half never runs at all.
*/
vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>());
});

const FALSE_CLAIM = "APPROVE - zero blocking findings, safe to merge as-is.";

pgDescribe("fn_artifact_retract through the agent tool surface (RUFU-433)", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_artifact_retract_tools" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  async function makeTask(): Promise<string> {
    const task = await store.createTask({ title: "Card whose review artifact was wrong", description: "RUFU-433 tool fixture" });
    return task.id;
  }

  /** Text payload of a tool result, the only shape an agent actually reads. */
  function text(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((part) => part.text ?? "").join("\n");
  }

  async function register(store_: TaskStore, taskId: string, authorId: string) {
    const tool = createArtifactRegisterTool(store_, authorId);
    return tool.execute("call-1", {
      type: "document" as const,
      title: "Review assessment",
      content: FALSE_CLAIM,
      mimeType: "text/markdown",
      taskId,
    });
  }

  async function list(store_: TaskStore, taskId: string, extra: Record<string, unknown> = {}) {
    const tool = createArtifactListTool(store_);
    return tool.execute("call-2", { taskId, ...extra });
  }

  async function view(store_: TaskStore, id: string) {
    const tool = createArtifactViewTool(store_);
    return tool.execute("call-3", { id });
  }

  async function retract(store_: TaskStore, authorId: string, id: string, reason: string) {
    const tool = createArtifactRetractTool(store_, authorId);
    return tool.execute("call-4", { id, reason });
  }

  it("withdraws a false review artifact end to end: hidden by default, VOID on view, row intact", async () => {
    const taskId = await makeTask();
    const registered = await register(store, taskId, "agent-reviewer");
    expect(text(registered)).toContain("Registered artifact");
    const artifactId = (registered.details as { artifactId: string }).artifactId;

    // Precondition: the false claim is discoverable and readable — the state that caused the bad merge.
    expect(text(await list(store, taskId))).toContain(artifactId);
    expect(text(await view(store, artifactId))).toContain(FALSE_CLAIM);

    const retracted = await retract(store, "agent-reviewer", artifactId, "Assessed the wrong head; re-ran against the real base.");
    expect(text(retracted)).toContain("VOID");
    expect((retracted.details as { retracted?: boolean }).retracted).toBe(true);

    // (c) the default listing no longer returns it at all — this is what stops it reaching a verdict.
    expect(text(await list(store, taskId))).not.toContain(artifactId);
    expect(await store.listArtifacts({ taskId })).toHaveLength(0);

    // ...and the explicit opt-in returns it, labelled, with its reason.
    const optedIn = text(await list(store, taskId, { includeRetracted: true }));
    expect(optedIn).toContain(artifactId);
    expect(optedIn).toContain("[VOID]");
    expect(optedIn).toContain("Assessed the wrong head");

    // (d) the view returns a VOID header plus the reason and NONE of the withdrawn content, uri, or body.
    const voided = await view(store, artifactId);
    const voidText = text(voided);
    expect(voidText).toContain("VOID");
    expect(voidText).toContain("Assessed the wrong head");
    expect(voidText).toContain("agent-reviewer");
    expect(voidText).not.toContain(FALSE_CLAIM);
    expect((voided.details as { retracted?: boolean }).retracted).toBe(true);

    // (e) nothing was hard-deleted: the row and its full tombstone are still there for a later reader.
    const row = await store.getArtifact(artifactId);
    expect(row).not.toBeNull();
    expect(row?.retractedAt).toBeTruthy();
    expect(row?.retractedBy).toBe("agent-reviewer");
    expect(row?.retractReason).toBe("Assessed the wrong head; re-ran against the real base.");
  });

  it("leaves the card exactly where it stood: no move, no verdict change, one History trace", async () => {
    const taskId = await makeTask();
    const before = await store.getTask(taskId);
    const artifactId = (await register(store, taskId, "agent-reviewer")).details as { artifactId: string };
    await retract(store, "agent-reviewer", artifactId.artifactId, "Superseded by a remediation run.");

    const after = await store.getTask(taskId);
    expect(after?.column).toBe(before?.column);
    expect(after?.status).toBe(before?.status);
    expect(after?.workflowStepResults ?? {}).toEqual(before?.workflowStepResults ?? {});
    expect(after?.paused).toBe(before?.paused);

    // The card trace is asserted on `task.log` - the History the operator reads. The artifact tools never
    // post an agent task-log entry, so asserting it would pass while the operator-facing trail was missing.
    const trace = after?.log?.find((entry) => (entry.action ?? "").includes("Retracted artifact"));
    expect(trace).toBeTruthy();
    expect(trace?.action).toContain("VOID");
    expect(trace?.action).toContain("Superseded by a remediation run.");
  });

  it("refuses a foreign retractor loudly and writes zero tombstone", async () => {
    const taskId = await makeTask();
    const artifactId = ((await register(store, taskId, "agent-reviewer")).details as { artifactId: string }).artifactId;

    const refused = await retract(store, "agent-other", artifactId, "Not mine, but I would rather it were gone.");
    expect(text(refused)).toContain("Refused");
    // Names the real author so the caller learns whether it has the wrong id or the wrong artifact.
    expect(text(refused)).toContain("agent-reviewer");
    expect((refused.details as { refused?: string }).refused).toBe("not-the-author");

    const row = await store.getArtifact(artifactId);
    expect(row?.retractedAt).toBeFalsy();
    expect(await store.listArtifacts({ taskId })).toHaveLength(1);
  });

  it("refuses a blank reason and reports it as a parameter problem, not a store failure", async () => {
    const taskId = await makeTask();
    const artifactId = ((await register(store, taskId, "agent-reviewer")).details as { artifactId: string }).artifactId;

    const refused = await retract(store, "agent-reviewer", artifactId, "   ");
    expect(text(refused)).toContain("reason");
    expect((refused.details as { refused?: string }).refused).toBe("reason-required");
    expect((await store.getArtifact(artifactId))?.retractedAt).toBeFalsy();
  });

  it("reports an unknown id without claiming a withdrawal", async () => {
    const refused = await retract(store, "agent-reviewer", "art-does-not-exist", "Reason is fine but the id is not.");
    expect(text(refused)).toContain("not found");
    expect((refused.details as { refused?: string }).refused).toBe("not-found");
  });

  it("is idempotent: a second retract reports the existing tombstone instead of a new failure", async () => {
    const taskId = await makeTask();
    const artifactId = ((await register(store, taskId, "agent-reviewer")).details as { artifactId: string }).artifactId;
    await retract(store, "agent-reviewer", artifactId, "Superseded.");

    const again = await retract(store, "agent-reviewer", artifactId, "Superseded again.");
    expect((again.details as { alreadyRetracted?: boolean }).alreadyRetracted).toBe(true);
    // The first reason survives a retry — a re-call must not silently rewrite the recorded justification.
    expect((await store.getArtifact(artifactId))?.retractReason).toBe("Superseded.");
  });

  it("gives the executor fallback author and the chat lane the same author-bound retract", async () => {
    const taskId = await makeTask();
    // Ephemeral executor runs register under the "executor" fallback; retract must bind the same id or
    // their own artifacts would be un-retractable, which is the defect this card removes.
    const executorTool = createArtifactRetractTool(store, "executor");
    expect(executorTool.name).toBe("fn_artifact_retract");
    const chatTools = createChatArtifactTools(store);
    expect(chatTools.map((tool) => tool.name)).toContain("fn_artifact_retract");

    const chatRegister = chatTools.find((tool) => tool.name === "fn_artifact_register")!;
    const created = await chatRegister.execute("call-5", {
      type: "document" as const,
      title: "Chat-authored wireframe",
      content: "chat body",
      task_id: taskId,
    });
    const chatArtifactId = (created.details as { artifactId: string }).artifactId;
    const chatRetract = chatTools.find((tool) => tool.name === "fn_artifact_retract")!;
    const result = await chatRetract.execute("call-6", { id: chatArtifactId, reason: "Wrong card." });
    expect(text(result)).toContain("VOID");
    expect((await store.getArtifact(chatArtifactId))?.retractedBy).toBe("dashboard-chat");
  });

  it("keeps every artifact lane that can register able to retract", () => {
    // The lanes are wired independently; a lane that gained register without retract would leave its own
    // mistakes with no way out, so the pairing is asserted as a surface-invariant rather than per-lane luck.
    expect(typeof createArtifactRetractTool).toBe("function");
    const tool = createArtifactRetractTool(store, "agent-x");
    const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["id", "reason"]);
    expect(schema.required).toContain("reason");
  });
});
