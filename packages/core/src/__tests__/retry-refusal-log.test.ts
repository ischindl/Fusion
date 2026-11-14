import { describe, expect, it, vi } from "vitest";
import {
  formatApprovalDestroyingRetryRefusalLine,
  recordApprovalDestroyingRetryRefusal,
  type RetryRefusalLogStore,
} from "../tasks/retry-refusal-log.js";
import type { ApprovalDestroyingRetry } from "../tasks/approval-destroying-retry.js";

/*
FNXC:ApprovalDestroyingRetry 2026-11-14-02:10 (RUFU-599 Step 7):
A refusal the operator only sees in a terminal or a 409 body is a refusal the card never learned about. These
cases pin the three properties the narration has to keep: the card gets ONE line, the line carries the
classifier's own sentence (so the card can never promise a friendlier remedy than the API refused with), and a
hostile log sink cannot turn a refused Retry into a success or a hang.
*/

function refusal(overrides: Partial<ApprovalDestroyingRetry> = {}): ApprovalDestroyingRetry {
  return {
    destroyedApproval: { workflowStepId: "code-review", workflowStepName: "Code Review" },
    waiver: {
      kind: "verdictless-skipped",
      workflowStepId: "post-merge-verification",
      workflowStepName: "Post-merge Verification",
      phase: "post-merge",
    },
    sentence:
      "Retry is refused here: `Code Review` already approved this work. The decision that clears this card is an operator waiver on `post-merge-verification`.",
    ...overrides,
  };
}

describe("recordApprovalDestroyingRetryRefusal", () => {
  it("writes one History line carrying the refusal's own sentence and its source", async () => {
    const once = vi.fn(async () => true);
    const store: RetryRefusalLogStore = { logEntryOnce: once, logEntry: vi.fn(async () => {}) };

    await recordApprovalDestroyingRetryRefusal(store, "RUFU-474", refusal(), "cli");

    expect(once).toHaveBeenCalledTimes(1);
    const [taskId, input] = once.mock.calls[0];
    expect(taskId).toBe("RUFU-474");
    expect(input.action).toContain("Retry is refused here: `Code Review` already approved this work.");
    expect(input.action).toContain("(cli)");
    expect(input.action).not.toContain("Retry the card");
    expect(input.dedupeKey).toBe("approval-destroying-retry:RUFU-474:post-merge-verification:code-review");
    expect(input.windowMs).toBeGreaterThan(0);
  });

  it("falls back to logEntry on a store without logEntryOnce", async () => {
    const logEntry = vi.fn(async () => {});
    await recordApprovalDestroyingRetryRefusal({ logEntry }, "RUFU-474", refusal(), "chat-tool");
    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry.mock.calls[0][0]).toBe("RUFU-474");
    expect(logEntry.mock.calls[0][1]).toContain("Retry is refused here");
  });

  it("never rejects on a hostile sink", async () => {
    const stores: Array<{ label: string; store: RetryRefusalLogStore }> = [
      { label: "throwing", store: { logEntryOnce: () => { throw new Error("sink down"); } } },
      { label: "rejecting", store: { logEntryOnce: () => Promise.reject(new Error("sink down")) } },
      { label: "absent", store: {} },
    ];
    for (const { store } of stores) {
      await expect(recordApprovalDestroyingRetryRefusal(store, "RUFU-474", refusal(), "cli")).resolves.toBeUndefined();
    }
    // A sink that never settles is released by the write bound, not by the sink.
    vi.useFakeTimers();
    try {
      const pending = recordApprovalDestroyingRetryRefusal(
        { logEntryOnce: () => new Promise(() => {}) },
        "RUFU-474",
        refusal(),
        "cli",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("formats the line so the remedy named by the card is the remedy the surface returned", () => {
    const line = formatApprovalDestroyingRetryRefusalLine(refusal(), "dashboard-restart");
    expect(line).toMatch(/^Retry refused \(dashboard-restart\): /);
    expect(line).toContain("operator waiver");
  });
});
