import { describe, expect, it, vi } from "vitest";
import { OAuthExpiryMonitor, type AuthStorageLike } from "../oauth-expiry-monitor.js";

function createAuthStorage(initialCredential?: { type?: string; expires?: number }): AuthStorageLike & {
  credential: { type?: string; expires?: number } | undefined;
} {
  return {
    credential: initialCredential,
    reload: vi.fn(),
    getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
    get(providerId: string) {
      if (providerId !== "openai-codex") {
        return undefined;
      }
      return this.credential;
    },
  };
}

describe("OAuthExpiryMonitor", () => {
  it("fires once when an OAuth credential is expired", async () => {
    vi.useFakeTimers();
    const authStorage = createAuthStorage({ type: "oauth", expires: Date.now() - 1_000 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => Date.now(),
    });

    await monitor.start();
    await vi.runOnlyPendingTimersAsync();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "oauth-token-expired",
      expect.objectContaining({
        event: "oauth-token-expired",
        metadata: expect.objectContaining({
          providerId: "openai-codex",
          providerName: "OpenAI Codex",
        }),
      }),
    );
    monitor.stop();
    vi.useRealTimers();
  });

  it("does not fire for non-expired/non-oauth credentials", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => undefined);
    const now = Date.now();

    const cases: Array<{ type?: string; expires?: number } | undefined> = [
      { type: "api_key" },
      { type: "oauth" },
      { type: "oauth", expires: now + 60_000 },
      undefined,
    ];

    for (const credential of cases) {
      const authStorage = createAuthStorage(credential);
      const monitor = new OAuthExpiryMonitor({
        authStorage,
        notificationService: { dispatch } as any,
        intervalMs: 100,
        clock: () => now,
      });

      await monitor.start();
      await vi.runOnlyPendingTimersAsync();
      monitor.stop();
    }

    expect(dispatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("deduplicates dispatches for same provider and expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
    });

    await monitor.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(dispatch).toHaveBeenCalledTimes(1);
    monitor.stop();
    vi.useRealTimers();
  });

  it("re-fires after credential is replaced with a new expiry that later expires", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
    });

    await monitor.start();
    expect(dispatch).toHaveBeenCalledTimes(1);

    authStorage.credential = { type: "oauth", expires: now + 1_000 };
    await vi.advanceTimersByTimeAsync(100);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(2);
    monitor.stop();
    vi.useRealTimers();
  });

  it("stop cancels the interval", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const authStorage = createAuthStorage({ type: "oauth", expires: now - 1 });
    const dispatch = vi.fn(async () => undefined);

    const monitor = new OAuthExpiryMonitor({
      authStorage,
      notificationService: { dispatch } as any,
      intervalMs: 100,
      clock: () => now,
    });

    await monitor.start();
    monitor.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(dispatch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
