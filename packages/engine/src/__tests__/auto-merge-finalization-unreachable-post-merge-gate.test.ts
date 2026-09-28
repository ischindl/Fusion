/*
FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
RUFU-306 bounded the post-merge gate SEED, and the bound held — what stayed unbounded was the DEFERRAL.
Production showed the pair seconds apart, all day, with no operator-visible artifact:

  Auto-merge finalization deferred for SANE-452: required post-merge evidence gate
    'post-merge-verification' has not reported [post-merge gate reseed: workspace]
  Auto-merge finalization deferred for STAS-288: required post-merge evidence gate
    'post-merge-verification' has not reported [post-merge gate reseed: active-continuation]

SANE-452's land is proven, so the missing evidence is not missing work: the `workspace` refusal is issued
by this seam by construction and the card deferred forever with zero seed attempts ever made. These tests
pin the three things that separate a terminal refusal from a transient one, and the operator artifact that
must exist once it is terminal. A negative proof at the bottom shows the pre-fix shape (one indistinguishable
deferral reason) can no longer be produced.
*/
import { describe, expect, it, vi } from "vitest";
import type { MessageStore, TaskStore } from "@fusion/core";

import {
  isTerminalPostMergeReseedRefusal,
  reseedUnrunPostMergeGate,
} from "../merge/post-merge-gate-reseed.js";
import {
  notifyUnreachablePostMergeGate,
  unreachablePostMergeGateNoticeKey,
  unreachablePostMergeGateReason,
} from "../merge/auto-merge-finalization.js";

const GATE_ID = "post-merge-verification";
const BLOCKER = `required post-merge evidence gate '${GATE_ID}' has not reported`;
const HOUR = 60 * 60 * 1000;

function fakeStore() {
  const auditEvents: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const store = {
    recordRunAuditEvent: (input: { mutationType: string; metadata: Record<string, unknown> }) => {
      auditEvents.push({ mutationType: input.mutationType, metadata: input.metadata });
    },
  };
  return { store: store as unknown as TaskStore, auditEvents };
}

function fakeMailbox() {
  const seen = new Map<string, number>();
  const calls: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  const messageStore = {
    sendMessageOnce: vi.fn(async (input: { content: string; metadata: Record<string, unknown> }, key: string) => {
      calls.push({ content: input.content, metadata: input.metadata });
      const hit = (seen.get(key) ?? 0) + 1;
      seen.set(key, hit);
      return { message: {} as never, inserted: hit === 1 };
    }),
  };
  return { messageStore: messageStore as unknown as Pick<MessageStore, "sendMessageOnce">, seen, calls };
}

describe("terminal vs transient post-merge reseed refusals (RUFU-370)", () => {
  it("names the refusals that can never produce the evidence row", () => {
    // SANE-452: refused by this seam by construction — a workspace card is not seedable here at all.
    expect(isTerminalPostMergeReseedRefusal("workspace")).toBe(true);
    // A workflow without the node cannot run it, and a spent budget has nothing left to spend.
    expect(isTerminalPostMergeReseedRefusal("no-post-merge-node")).toBe(true);
    expect(isTerminalPostMergeReseedRefusal("rerun-budget-exhausted")).toBe(true);
    expect(isTerminalPostMergeReseedRefusal("unsupported-store")).toBe(true);
  });

  it("keeps conditions that can genuinely clear on a later pass transient", () => {
    // STAS-288: an active continuation is a real hold that ends; parking it would be a false wedge.
    expect(isTerminalPostMergeReseedRefusal("active-continuation")).toBe(false);
    // Operator holds and a changed workflow selection must stay re-evaluated, never handed off as dead.
    expect(isTerminalPostMergeReseedRefusal("operator-held")).toBe(false);
    expect(isTerminalPostMergeReseedRefusal("workflow-selection-changed")).toBe(false);
    expect(isTerminalPostMergeReseedRefusal("no-merge-proof")).toBe(false);
    expect(isTerminalPostMergeReseedRefusal("seeded")).toBe(false);
  });
});

describe("operator handoff for an unreachable post-merge gate", () => {
  it("delivers one operator artifact per (task, gate, refusal) window", async () => {
    const { store } = fakeStore();
    const { messageStore, seen } = fakeMailbox();
    const now = Date.UTC(2026, 8, 28, 7, 0, 0);

    const first = await notifyUnreachablePostMergeGate({
      store, messageStore, taskId: "SANE-452", gateId: GATE_ID, refusal: "workspace", evidenceBlocker: BLOCKER, now,
    });
    const repeat = await notifyUnreachablePostMergeGate({
      store, messageStore, taskId: "SANE-452", gateId: GATE_ID, refusal: "workspace", evidenceBlocker: BLOCKER,
      now: now + HOUR,
    });

    expect(first).toBe("delivered");
    expect(repeat).toBe("delivered");
    // Same window -> the same idempotency key, so the store collapses the repeat to one row.
    expect(seen.size).toBe(1);
    expect(messageStore.sendMessageOnce).toHaveBeenCalledTimes(2);
    const [notice] = [...seen.keys()];
    expect(notice).toContain("system:unrun-post-merge-gate:SANE-452");
    expect(notice).toContain(":workspace:");
  });

  it("re-announces the same refusal after the cooldown window instead of silencing it forever", () => {
    const early = unreachablePostMergeGateNoticeKey("SANE-452", GATE_ID, "workspace", 0);
    const later = unreachablePostMergeGateNoticeKey("SANE-452", GATE_ID, "workspace", 7 * HOUR);
    expect(early).not.toBe(later);
    // A different refusal on the same card is a different episode, not a duplicate of the first.
    expect(unreachablePostMergeGateNoticeKey("SANE-452", GATE_ID, "workspace", 0))
      .not.toBe(unreachablePostMergeGateNoticeKey("SANE-452", GATE_ID, "rerun-budget-exhausted", 0));
  });

  it("still records the durable handoff row when no mailbox store is wired", async () => {
    const { store, auditEvents } = fakeStore();
    const outcome = await notifyUnreachablePostMergeGate({
      store,
      messageStore: null,
      taskId: "STAS-288",
      gateId: GATE_ID,
      refusal: "workspace",
      evidenceBlocker: BLOCKER,
      now: Date.UTC(2026, 8, 28, 7, 0, 0),
    });

    expect(outcome).toBe("unavailable");
    const row = auditEvents.find((event) => event.mutationType === "task:auto-merge-finalize-post-merge-gate-unreachable");
    expect(row?.metadata).toMatchObject({ taskId: "STAS-288", refusal: "workspace", notice: "unavailable" });
    // The audit row carries ids and fixed enums only — the blocker sentence stays out of run-audit.
    expect(JSON.stringify(row?.metadata)).not.toContain("has not reported");
  });

  it("cannot change or delay finalization when the mailbox sink hangs", async () => {
    const { store } = fakeStore();
    const hanging = {
      sendMessageOnce: () => new Promise<never>(() => {}),
    } as unknown as Pick<MessageStore, "sendMessageOnce">;

    await expect(notifyUnreachablePostMergeGate({
      store, messageStore: hanging, taskId: "SANE-452", gateId: GATE_ID, refusal: "workspace",
      evidenceBlocker: BLOCKER, timeoutMs: 5,
    })).resolves.toBe("unavailable");
  });
});

describe("the forever-defer shape is gone (negative proof)", () => {
  it("a workspace card is refused without a single seed attempt", async () => {
    const task = {
      id: "SANE-452",
      column: "in-review",
      enabledWorkflowSteps: [GATE_ID],
      workflowStepResults: [],
      mergeDetails: { commitSha: "81fb15fd00000000000000000000000000000000" },
      workspaceWorktrees: { saneca: { branch: "fusion/sane-452", worktreePath: "/tmp/x" } },
      log: [],
    } as never;
    const { store } = fakeStore();

    const refusal = await reseedUnrunPostMergeGate(store, task, { source: "auto-merge" });
    expect(refusal).toMatchObject({ seeded: false, reason: "workspace" });

    // Pre-fix, this card's finalization reason was the bare blocker — byte-identical to a transient
    // deferral, which is why the loop was invisible. The terminal reason can no longer equal it.
    const reason = unreachablePostMergeGateReason(BLOCKER, refusal.reason);
    expect(reason).not.toBe(BLOCKER);
    expect(reason).toBe(`${BLOCKER} [post-merge gate unreachable: workspace]`);
  });
});
