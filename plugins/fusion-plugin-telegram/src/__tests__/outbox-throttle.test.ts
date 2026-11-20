/**
 * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P1):
 * `throttleMsPerChat` is an operator-facing setting that claims to keep the bridge under Telegram's
 * roughly-one-message-per-second-per-chat ceiling. It only claims that if something actually spaces the
 * sends, and until `outbox.ts` existed nothing did: each webhook POST fired its own background delivery, so
 * a burst of events produced a burst of concurrent `sendMessage` calls and the 429s came back as discarded
 * `send-failed` outcomes after the webhook had already been acknowledged.
 *
 * These tests therefore measure the SETTINGS' CLAIM directly: N messages on one chat must occupy N distinct
 * slots at least `throttleMs` apart, and no two sends may ever be in flight together. Time is a virtual
 * clock the test advances, so the contract is asserted with zero real time passing.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_QUEUED_PER_CHAT,
  TelegramOutboxBackoffError,
  TelegramOutboxFullError,
  createTelegramOutbox,
  isOutboxBackoffError,
  isOutboxFullError,
} from "../outbox.js";
import { TelegramApiError } from "../bot-api.js";

const THROTTLE_MS = 1_100;

function logger() {
  const none = () => undefined;
  return { info: none, warn: none, error: none, debug: none };
}

/**
 * A clock the test drives: `sleep` advances it and resolves immediately, which is what lets a 15-message
 * burst be measured over 15.4 simulated seconds in no real time at all. The outbox's spacing logic is
 * unchanged — it still asks for the same waits, they simply cost nothing here.
 */
function virtualClock(start = 1_000) {
  let ms = start;
  const sleeps: number[] = [];
  return {
    now: () => ms,
    sleep: async (waitMs: number) => {
      sleeps.push(waitMs);
      ms += waitMs;
    },
    sleeps,
  };
}

/** Fails the spacing claim if two sends were ever in flight at once. */
function flightTracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    maxInFlight: () => maxInFlight,
    async enter<T>(run: () => Promise<T>): Promise<T> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a microtask, so an unserialized caller would actually interleave here.
      await Promise.resolve();
      const result = await run();
      inFlight -= 1;
      return result;
    },
  };
}

describe("createTelegramOutbox per-chat spacing", () => {
  it("spaces a burst of 15 sends on one chat by at least 14 throttle intervals, never concurrently", async () => {
    const clock = virtualClock();
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    const flight = flightTracker();
    const startedAt: number[] = [];

    const burst = Array.from({ length: 15 }, (_unused, index) => index + 1);
    const settled = await Promise.allSettled(
      burst.map((id) => outbox.send({
        chatId: "chat-a",
        throttleMs: THROTTLE_MS,
        run: () => flight.enter(async () => {
          startedAt.push(clock.now());
          return { messageId: id };
        }),
      })),
    );

    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(startedAt).toHaveLength(15);
    // The claim under test: the 15th message starts no earlier than 14 intervals after the 1st.
    const span = startedAt[14]! - startedAt[0]!;
    expect(span).toBeGreaterThanOrEqual(14 * THROTTLE_MS);
    expect(flight.maxInFlight()).toBe(1);
  });

  it("does not make one chat wait behind another chat's traffic", async () => {
    const clock = virtualClock();
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    const startedAt: Record<string, number[]> = { "chat-a": [], "chat-b": [] };

    await Promise.all([
      ...[1, 2, 3].map((id) => outbox.send({
        chatId: "chat-a",
        throttleMs: THROTTLE_MS,
        run: async () => {
          startedAt["chat-a"]!.push(clock.now());
          return { messageId: id };
        },
      })),
      ...[11, 12].map((id) => outbox.send({
        chatId: "chat-b",
        throttleMs: THROTTLE_MS,
        run: async () => {
          startedAt["chat-b"]!.push(clock.now());
          return { messageId: id };
        },
      })),
    ]);

    // Each chat pays its own spacing; a second chat must not be pushed out to fit the first one's queue.
    expect(startedAt["chat-b"]).toEqual([1_000, 2_100]);
    expect(startedAt["chat-a"]).toEqual([1_000, 2_100, 3_200]);
  });

  it("honors the project's own spacing rather than a value fixed at load time", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    const startedAt: number[] = [];
    const stamp = () => {
      startedAt.push(clock.now());
      return Promise.resolve({ ok: true });
    };

    await outbox.send({ chatId: "chat-c", throttleMs: 5_000, run: stamp });
    await outbox.send({ chatId: "chat-c", throttleMs: 5_000, run: stamp });
    // A tighter setting on the same chat is honored from that point on, not averaged with the old one.
    await outbox.send({ chatId: "chat-c", throttleMs: 1_000, run: stamp });

    expect(startedAt).toEqual([0, 5_000, 6_000]);
  });
});

describe("createTelegramOutbox rate-limit retry", () => {
  function rateLimited(retryAfterMs: number | undefined, attempts = { n: 0 }) {
    return async () => {
      attempts.n += 1;
      throw new TelegramApiError({ method: "sendMessage", httpStatus: 429, errorCode: 429, retryAfterMs });
    };
  }

  it("retries a 429 once, waiting the retry_after Telegram actually asked for", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    let attempts = 0;
    const startedAt: number[] = [];

    const outcome = await outbox.send({
      chatId: "chat-a",
      throttleMs: THROTTLE_MS,
      run: async () => {
        attempts += 1;
        startedAt.push(clock.now());
        if (attempts === 1) {
          throw new TelegramApiError({ method: "sendMessage", httpStatus: 429, errorCode: 429, retryAfterMs: 4_321 });
        }
        return { messageId: 42 };
      },
    });

    expect(outcome).toEqual({ messageId: 42 });
    expect(attempts).toBe(2);
    expect(clock.sleeps).toContain(4_321);
    expect(startedAt).toEqual([0, 4_321]);
  });

  it("falls back to the chat throttle when the 429 carries no retry_after", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    const failing = rateLimited(undefined);

    await expect(outbox.send({ chatId: "chat-a", throttleMs: THROTTLE_MS, run: failing })).rejects.toBeInstanceOf(TelegramApiError);
    expect(clock.sleeps).toContain(THROTTLE_MS);
  });

  it("gives up after the one retry instead of holding an acknowledged event forever", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    let attempts = 0;

    await expect(outbox.send({
      chatId: "chat-a",
      throttleMs: THROTTLE_MS,
      run: async () => {
        attempts += 1;
        throw new TelegramApiError({ method: "sendMessage", httpStatus: 429, errorCode: 429, retryAfterMs: 10 });
      },
    })).rejects.toBeInstanceOf(TelegramApiError);

    expect(attempts).toBe(2);
  });

  it("refuses a backoff longer than the bridge will wait, rather than parking the queue for an hour", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    const failing = rateLimited(3_600_000);

    await expect(outbox.send({ chatId: "chat-a", throttleMs: THROTTLE_MS, run: failing }))
      .rejects.toBeInstanceOf(TelegramOutboxBackoffError);
    expect(clock.sleeps).not.toContain(3_600_000);
    expect(isOutboxBackoffError(new TelegramOutboxBackoffError("chat-a", 1))).toBe(true);
    // A caller that only wanted to know "was this throttled" must not mistake a 400 for a 429.
    expect(isOutboxFullError(new TelegramApiError({ method: "sendMessage", httpStatus: 400 }))).toBe(false);
  });

  it("does not retry an error that was not a rate limit", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    let attempts = 0;

    await expect(outbox.send({
      chatId: "chat-a",
      throttleMs: THROTTLE_MS,
      run: async () => {
        attempts += 1;
        throw new TelegramApiError({ method: "sendMessage", httpStatus: 400, errorCode: 400 });
      },
    })).rejects.toBeInstanceOf(TelegramApiError);

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("createTelegramOutbox backlog ceiling", () => {
  it("refuses new sends past the ceiling instead of queueing questions nobody will read in time", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const outbox = createTelegramOutbox({ logger: logger(), now: () => 0, sleep: async () => undefined });
    const blockedSend = async () => {
      await gate;
      return { messageId: 1 };
    };

    const queued = Array.from({ length: MAX_QUEUED_PER_CHAT }, () => outbox
      .send({
        chatId: "chat-a",
        // Spacing is free here, so every slot is occupied purely by the queue itself.
        throttleMs: 0,
        run: blockedSend,
      })
      .catch((error: unknown) => error));

    const overflow = await outbox.send({ chatId: "chat-a", throttleMs: 0, run: blockedSend }).catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(TelegramOutboxFullError);
    expect(isOutboxFullError(overflow)).toBe(true);
    expect(outbox.queued()).toBeGreaterThan(0);

    releaseGate();
    await Promise.all(queued);
    expect(outbox.queued()).toBe(0);
  });

  it("leaves a chat usable again after a failed send, instead of wedging its queue", async () => {
    const clock = virtualClock(0);
    const outbox = createTelegramOutbox({ logger: logger(), now: clock.now, sleep: clock.sleep });
    let first = true;

    await outbox.send({
      chatId: "chat-a",
      throttleMs: 0,
      run: async () => {
        if (first) {
          first = false;
          throw new TelegramApiError({ method: "sendMessage", httpStatus: 500 });
        }
        return { ok: true };
      },
    }).catch(() => undefined);

    await expect(outbox.send({ chatId: "chat-a", throttleMs: 0, run: async () => ({ ok: true }) })).resolves.toEqual({ ok: true });
    expect(outbox.queued()).toBe(0);
  });
});
