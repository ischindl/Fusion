/*
FNXC:ReviewEscalationNotice 2026-09-28-07:34 (RUFU-371):
A review-convergence escalation is the one review park that is explicitly a human's decision, and it was the
one class the RUFU-180 notification could not announce: RUFU-281 fired the sweep six times in a day, every
row `outcome:"unavailable"`, `stallAgeMs: 0` for a three-day-old park, no mailbox message anywhere. These
tests pin the two repairs: an age read from durable lane-entry evidence instead of a re-stamped observation,
and one idempotent operator notice per escalation window that cannot become a lifecycle dependency.
*/
import { describe, expect, it, vi } from "vitest";
import type { MessageStore, Task, TaskStore } from "@fusion/core";

import {
  REVIEW_CONVERGENCE_HUMAN_STAGE,
  isConvergenceEscalatedTask,
  notifyReviewEscalationUnreachable,
  resolveStallParkAgeMs,
  reviewEscalationNoticeKey,
} from "../notification/review-escalation-notice.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 28, 7, 0, 0);

function fakes() {
  const auditEvents: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const store = {
    recordRunAuditEvent: (input: { mutationType: string; metadata: Record<string, unknown> }) => {
      auditEvents.push({ mutationType: input.mutationType, metadata: input.metadata });
    },
  };
  const keys: string[] = [];
  const messageStore = {
    sendMessageOnce: vi.fn((input: { content: string }, key: string) => {
      keys.push(key);
      return Promise.resolve({ message: {} as never, inserted: keys.length === 1 });
    }),
  };
  return {
    store: store as unknown as TaskStore,
    messageStore: messageStore as unknown as Pick<MessageStore, "sendMessageOnce">,
    auditEvents,
    keys,
  };
}

const escalated = {
  id: "RUFU-281",
  reviewConvergenceStage: 3,
  reviewConvergenceEscalationCount: 1,
} as unknown as Task;

describe("stall age comes from durable park evidence", () => {
  it("reports the real three-day wait even though the observation was just stamped", () => {
    const parkedAt = new Date(NOW - 72 * HOUR).toISOString();
    const age = resolveStallParkAgeMs({
      columnMovedAt: parkedAt,
      updatedAt: new Date(NOW - 60_000).toISOString(),
      // The stall authority re-stamps this on every observation — the source of the old `stallAgeMs: 0`.
      observedAt: new Date(NOW - 1_000).toISOString(),
      now: NOW,
    });
    expect(age).toBe(72 * HOUR);
    expect(age).not.toBeLessThan(71 * HOUR);
  });

  it("falls back to the observation only when no durable timestamp exists", () => {
    expect(resolveStallParkAgeMs({ observedAt: new Date(NOW - 5 * HOUR).toISOString(), now: NOW })).toBe(5 * HOUR);
    expect(resolveStallParkAgeMs({ updatedAt: new Date(NOW - 2 * HOUR).toISOString(), observedAt: new Date(NOW - 1_000).toISOString(), now: NOW }))
      .toBe(2 * HOUR);
    expect(resolveStallParkAgeMs({ now: NOW })).toBeUndefined();
    expect(resolveStallParkAgeMs({ columnMovedAt: "not-a-date", now: NOW })).toBeUndefined();
  });
});

describe("which parks are a convergence escalation", () => {
  it("requires both the durable escalation count and the human stage", () => {
    expect(isConvergenceEscalatedTask(escalated)).toBe(true);
    expect(isConvergenceEscalatedTask({ reviewConvergenceStage: 2, reviewConvergenceEscalationCount: 1 } as never)).toBe(false);
    expect(isConvergenceEscalatedTask({ reviewConvergenceStage: 3, reviewConvergenceEscalationCount: 0 } as never)).toBe(false);
    // A slim row without the fields fails safe: no notice, and no claim that one was sent.
    expect(isConvergenceEscalatedTask({} as never)).toBe(false);
  });

  it("names the stage the protocol parks a human-decision card at", () => {
    expect(REVIEW_CONVERGENCE_HUMAN_STAGE).toBe(3);
  });
});

describe("operator notice for an escalation the wedge service cannot represent", () => {
  it("collapses repeats inside a window and re-announces after it", async () => {
    const { store, messageStore, keys } = fakes();
    const first = await notifyReviewEscalationUnreachable({
      store, messageStore, task: escalated, stallCode: "merge-blocker", stallAgeMs: 72 * HOUR, now: NOW,
    });
    const repeat = await notifyReviewEscalationUnreachable({
      store, messageStore, task: escalated, stallCode: "merge-blocker", stallAgeMs: 73 * HOUR, now: NOW + HOUR,
    });
    const later = await notifyReviewEscalationUnreachable({
      store, messageStore, task: escalated, stallCode: "merge-blocker", stallAgeMs: 80 * HOUR, now: NOW + 8 * HOUR,
    });

    expect([first, repeat, later]).toEqual(["delivered", "delivered", "delivered"]);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain("system:review-convergence-escalation:RUFU-281:3:");
    expect(reviewEscalationNoticeKey("RUFU-281", 3, NOW)).not.toBe(reviewEscalationNoticeKey("RUFU-281", 3, NOW + 7 * HOUR));
  });

  it("records the durable row and reports unavailable when no mailbox store is wired", async () => {
    const { store, auditEvents } = fakes();
    const outcome = await notifyReviewEscalationUnreachable({
      store, messageStore: null, task: escalated, stallCode: "held-human-review", stallAgeMs: 72 * HOUR, now: NOW,
    });

    expect(outcome).toBe("unavailable");
    const row = auditEvents.find((event) => event.mutationType === "task:review-convergence-escalation-notice");
    expect(row?.metadata).toMatchObject({
      taskId: "RUFU-281", reviewConvergenceStage: 3, stallCode: "held-human-review", notice: "unavailable",
    });
    // Ids, counts and fixed enums only: reviewer prose never enters run-audit.
    expect(JSON.stringify(row?.metadata)).not.toMatch(/verdict|finding|reviewer/i);
  });

  it("cannot be delayed by a mailbox sink that never settles", async () => {
    const { store } = fakes();
    const hanging = { sendMessageOnce: () => new Promise<never>(() => {}) } as unknown as Pick<MessageStore, "sendMessageOnce">;
    await expect(notifyReviewEscalationUnreachable({
      store, messageStore: hanging, task: escalated, stallCode: "merge-blocker", now: NOW, timeoutMs: 5,
    })).resolves.toBe("unavailable");
  });
});
