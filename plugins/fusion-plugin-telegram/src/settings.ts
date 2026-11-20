import type { PluginSettingSchema } from "@fusion/plugin-sdk";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Every knob of the Telegram bridge lives here so the operator configures the whole channel from
 * Settings -> Plugins and nothing is hardcoded. Two of these are secrets (`botToken`, `ingestSecret`)
 * and are declared `password` so the dashboard masks them; the plugin must never write either into a
 * log line, a run-audit row, or the status route response (docs/secrets.md). A plugin has no
 * `SecretsStore` handle - `PluginContext` exposes only taskStore/settings/logger/emitEvent and the two
 * optional AI-session factories - so password settings plus a never-print rule are what this card can
 * do, and hardened plugin storage is recorded as follow-up work.
 */

/** Telegram's documented soft rate limit is ~1 message per second per chat; 1100 ms leaves headroom. */
export const DEFAULT_THROTTLE_MS_PER_CHAT = 1100;
export const MIN_THROTTLE_MS_PER_CHAT = 100;
export const MAX_THROTTLE_MS_PER_CHAT = 60_000;

export const DEFAULT_DEDUPE_RETENTION_DAYS = 7;
export const MIN_DEDUPE_RETENTION_DAYS = 1;
export const MAX_DEDUPE_RETENTION_DAYS = 365;

/**
 * Ceiling on one ingest request body. A notification payload is a few hundred bytes, so this only ever
 * refuses a hostile or looping sender; it is checked against `Content-Length` before the body is parsed.
 */
export const INGEST_BODY_BYTE_LIMIT = 64 * 1024;

/** `sendMessage` rejects text longer than this; the formatter truncates instead of failing the send. */
export const TELEGRAM_TEXT_CHAR_LIMIT = 4096;

/** `InlineKeyboardButton.callback_data` is capped at 64 BYTES, which is why it carries an opaque id. */
export const TELEGRAM_CALLBACK_DATA_BYTE_LIMIT = 64;

/** The dashboard's steering-comment ceiling (see `POST /api/tasks/:id/steer`). */
export const STEERING_TEXT_CHAR_LIMIT = 2000;

export type GroupingMode = "privateTopics" | "forumTopic" | "flat";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Accepted decision 2: group by project with Telegram Topics. Bot API 9.3/9.4 lets `createForumTopic`
 * run in a private chat with the user, so `privateTopics` is the default and needs no admin rights;
 * `forumTopic` is the supergroup fallback (needs `can_manage_topics`); `flat` prefixes every message
 * with `[project/CARD]` for clients without topics.
 */
export const GROUPING_MODES: readonly GroupingMode[] = ["privateTopics", "forumTopic", "flat"];
export const DEFAULT_GROUPING_MODE: GroupingMode = "privateTopics";

/** The six `icon_color` values the Bot API accepts for a forum topic. */
export const FORUM_TOPIC_ICON_COLORS: readonly number[] = [
  7322096, 13172662, 14268288, 14277031, 15855930, 12492344,
];

/** Events the operator can opt into. An empty `eventFilter` means "deliver nothing". */
export const EVENT_FILTER_CHOICES: readonly string[] = [
  "planning-awaiting-input",
  "awaiting-approval",
  "awaiting-user-review",
  "cli-agent-awaiting-input",
  "task-wedged",
  "failed",
  "message:agent-to-user",
];

export const settingsSchema: Record<string, PluginSettingSchema> = {
  botToken: {
    type: "password",
    label: "Bot Token",
    group: "Connection",
    description:
      "Token from @BotFather. One bot per Fusion instance: Telegram exposes a single getUpdates stream per token, so the bridge cannot run per project. Never printed to logs or reported by the status route.",
  },
  chatId: {
    type: "string",
    label: "Chat Id",
    group: "Connection",
    description:
      "Private chat id (send the bot /start, then read the id from getUpdates) or the forum supergroup id. Start with -100... for a group.",
  },
  groupingMode: {
    type: "enum",
    label: "Project Grouping",
    group: "Routing",
    enumValues: [...GROUPING_MODES],
    defaultValue: DEFAULT_GROUPING_MODE,
    description:
      "privateTopics: one topic per project inside your private chat with the bot (Bot API 9.3+, enabled per chat in BotFather). forumTopic: one topic per project in a forum supergroup (the bot needs can_manage_topics). flat: no topics, every message is prefixed [project/CARD].",
  },
  hubProjectId: {
    type: "string",
    label: "Hub Project Id",
    group: "Routing",
    description:
      "The project whose settings drive the bot when an event arrives for another project. Leave empty to require each project to configure its own bridge.",
  },
  dashboardBaseUrl: {
    type: "string",
    label: "Dashboard Base URL",
    group: "Routing",
    description: "Absolute URL of this Fusion dashboard. When set, Telegram messages carry a deep link to the card; when empty no link is added.",
  },
  eventFilter: {
    type: "string",
    label: "Event Filter",
    group: "Delivery",
    multiline: true,
    description:
      `Comma- or newline-separated event names to deliver; empty delivers nothing. Known: ${EVENT_FILTER_CHOICES.join(", ")}.`,
  },
  allowedChatIds: {
    type: "array",
    label: "Allowed Chat Ids",
    group: "Security",
    itemType: "string",
    description:
      "Inbound allowlist. EMPTY MEANS NOBODY: the bridge then sends but never acts on a reply. Add your own chat id (and any group chat id you answer from).",
  },
  ingestSecret: {
    type: "password",
    label: "Ingest Secret",
    group: "Security",
    description:
      "Shared secret the notification webhook must present as ?key=. Mandatory: with no secret the ingest route refuses every request, because the route is exempt from the daemon-token gate and the generic webhook provider sends no bearer.",
  },
  throttleMsPerChat: {
    type: "number",
    label: "Throttle Per Chat (ms)",
    group: "Delivery",
    defaultValue: DEFAULT_THROTTLE_MS_PER_CHAT,
    description: "Minimum spacing between two sends to one chat. Telegram returns HTTP 429 above roughly one message per second per chat.",
  },
  dedupeRetentionDays: {
    type: "number",
    label: "Dedupe Retention (days)",
    group: "Delivery",
    defaultValue: DEFAULT_DEDUPE_RETENTION_DAYS,
    description: "How long inbound update ids are kept for replay protection. Older rows are pruned while claiming a new update.",
  },
};

/** Trims a setting and treats an empty string as unset, so a blank field never means "empty target". */
export function getSettingString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads a bounded numeric setting. A missing, non-finite, non-integer, or out-of-range value returns
 * `fallback` rather than clamping: a typo in a rate limit must not silently become "send as fast as
 * Telegram tolerates".
 */
export function getSettingNumber(
  settings: Record<string, unknown>,
  key: string,
  opts: { fallback: number; min: number; max: number },
): number {
  const value = settings[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return opts.fallback;
  const floored = Math.floor(value);
  if (floored < opts.min || floored > opts.max) return opts.fallback;
  return floored;
}

/**
 * Reads a list setting that the operator may express either as a native array or as a
 * comma/newline/semicolon separated string. Order is preserved, entries are trimmed, blanks are
 * dropped, and duplicates collapse to their first occurrence, so a pasted CSV with repeats cannot
 * double-send or double-authorise.
 */
export function getSettingCsv(settings: Record<string, unknown>, key: string): string[] {
  const raw = settings[key];
  const pieces = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of pieces) {
    for (const atom of piece.split(/[,\n;]+/)) {
      const trimmed = atom.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function getGroupingMode(settings: Record<string, unknown>): GroupingMode {
  const value = getSettingString(settings, "groupingMode");
  return (GROUPING_MODES as readonly string[]).includes(value ?? "")
    ? (value as GroupingMode)
    : DEFAULT_GROUPING_MODE;
}

/** The event names this project wants delivered. An empty list is an explicit "deliver nothing". */
export function getEventFilter(settings: Record<string, unknown>): Set<string> {
  return new Set(getSettingCsv(settings, "eventFilter"));
}

export function getThrottleMsPerChat(settings: Record<string, unknown>): number {
  return getSettingNumber(settings, "throttleMsPerChat", {
    fallback: DEFAULT_THROTTLE_MS_PER_CHAT,
    min: MIN_THROTTLE_MS_PER_CHAT,
    max: MAX_THROTTLE_MS_PER_CHAT,
  });
}

export function getDedupeRetentionDays(settings: Record<string, unknown>): number {
  return getSettingNumber(settings, "dedupeRetentionDays", {
    fallback: DEFAULT_DEDUPE_RETENTION_DAYS,
    min: MIN_DEDUPE_RETENTION_DAYS,
    max: MAX_DEDUPE_RETENTION_DAYS,
  });
}

export function getAllowedChatIds(settings: Record<string, unknown>): Set<string> {
  return new Set(getSettingCsv(settings, "allowedChatIds"));
}

/** The bot token. Callers must never log it or place it in a response body (docs/secrets.md). */
export function getBotToken(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "botToken");
}

/** The Telegram chat every project's messages go into. One bot per instance, so one destination. */
export function getChatId(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "chatId");
}

/**
 * Base URL for the deep link to a card. Unset means no link at all rather than a guessed host: a wrong
 * absolute URL in a Telegram message is worse than none, and the operator sees the absence immediately.
 */
export function getDashboardBaseUrl(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "dashboardBaseUrl");
}

/** Last-resort project attribution for an event that names no project (see `correlateProject`). */
export function getHubProjectId(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "hubProjectId");
}

/** The ingest route fails closed on an unset or blank secret, so blank must not read as configured. */
export function isIngestSecretConfigured(settings: Record<string, unknown>): boolean {
  return getSettingString(settings, "ingestSecret") !== undefined;
}

/**
 * Overlays a project's own settings on the hub project's settings, which is how one bot serves every
 * project: the token and the chat live on the hub, and each project may override the knobs that are its
 * own (grouping mode, event filter, throttle).
 *
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * A blank string on the project is "not set here", not "set to nothing", so it must not erase a hub value.
 * Without this rule a project whose Chat Id field is merely empty would inherit no chat at all and every
 * event for it would silently fail with `chat-not-configured`.
 */
export function mergeSettings(
  base: Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  if (!override) return merged;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    merged[key] = value;
  }
  return merged;
}
