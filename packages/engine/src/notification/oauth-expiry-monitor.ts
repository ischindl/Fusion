import type { NotificationPayload } from "@fusion/core";
import { schedulerLog } from "../logger.js";
import type { NotificationService } from "./notification-service.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

interface OAuthProviderInfo {
  id: string;
  name: string;
}

interface OAuthCredential {
  type?: string;
  expires?: number;
}

export interface AuthStorageLike {
  reload?(): void;
  getOAuthProviders?(): OAuthProviderInfo[];
  get?(providerId: string): OAuthCredential | undefined;
}

export interface OAuthExpiryMonitorOptions {
  authStorage: AuthStorageLike;
  notificationService: NotificationService;
  intervalMs?: number;
  clock?: () => number;
  warnBeforeMs?: number;
}

export class OAuthExpiryMonitor {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly warnBeforeMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatchedExpiryKeys = new Set<string>();

  constructor(private readonly opts: OAuthExpiryMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = opts.clock ?? Date.now;
    this.warnBeforeMs = opts.warnBeforeMs ?? 0;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    this.opts.authStorage.reload?.();

    const providers = this.opts.authStorage.getOAuthProviders?.();
    if (!providers?.length) {
      this.dispatchedExpiryKeys.clear();
      return;
    }

    const now = this.clock();
    const activeExpiryKeys = new Set<string>();

    for (const provider of providers) {
      const credential = this.opts.authStorage.get?.(provider.id);
      if (credential?.type !== "oauth" || typeof credential.expires !== "number") {
        continue;
      }

      const expiryKey = `${provider.id}:${credential.expires}`;
      activeExpiryKeys.add(expiryKey);

      if (now + this.warnBeforeMs < credential.expires) {
        continue;
      }
      if (this.dispatchedExpiryKeys.has(expiryKey)) {
        continue;
      }

      const payload: NotificationPayload = {
        event: "oauth-token-expired",
        metadata: {
          providerId: provider.id,
          providerName: provider.name,
          expiresAt: new Date(credential.expires).toISOString(),
        },
      };

      try {
        await this.opts.notificationService.dispatch("oauth-token-expired", payload);
        this.dispatchedExpiryKeys.add(expiryKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        schedulerLog.warn(`OAuth expiry notification dispatch failed provider=${provider.id}: ${message}`);
      }
    }

    for (const key of this.dispatchedExpiryKeys) {
      if (!activeExpiryKeys.has(key)) {
        this.dispatchedExpiryKeys.delete(key);
      }
    }
  }
}
