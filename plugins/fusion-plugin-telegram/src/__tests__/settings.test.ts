import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEDUPE_RETENTION_DAYS,
  DEFAULT_GROUPING_MODE,
  DEFAULT_THROTTLE_MS_PER_CHAT,
  EVENT_FILTER_CHOICES,
  FORUM_TOPIC_ICON_COLORS,
  getAllowedChatIds,
  getDedupeRetentionDays,
  getEventFilter,
  getGroupingMode,
  getSettingCsv,
  getSettingNumber,
  getSettingString,
  getThrottleMsPerChat,
  settingsSchema,
} from "../settings.js";

describe("telegram settings schema", () => {
  it("declares both secrets as password settings so the dashboard masks them", () => {
    expect(settingsSchema.botToken?.type).toBe("password");
    expect(settingsSchema.ingestSecret?.type).toBe("password");
  });

  it("declares every setting the operator needs to configure the bridge", () => {
    expect(Object.keys(settingsSchema).sort()).toEqual(
      [
        "allowedChatIds",
        "botToken",
        "chatId",
        "dashboardBaseUrl",
        "dedupeRetentionDays",
        "eventFilter",
        "groupingMode",
        "hubProjectId",
        "ingestSecret",
        "throttleMsPerChat",
      ].sort(),
    );
  });

  it("describes every setting so Settings -> Plugins is readable without the README", () => {
    for (const [key, schema] of Object.entries(settingsSchema)) {
      expect(schema?.label, `${key} label`).toBeTruthy();
      expect(schema?.description, `${key} description`).toBeTruthy();
    }
  });

  it("offers only the three accepted grouping modes and defaults to private topics", () => {
    expect(settingsSchema.groupingMode?.enumValues).toEqual(["privateTopics", "forumTopic", "flat"]);
    expect(settingsSchema.groupingMode?.defaultValue).toBe(DEFAULT_GROUPING_MODE);
  });

  it("keeps the event filter vocabulary aligned with the events the bridge renders", () => {
    expect(EVENT_FILTER_CHOICES).toContain("planning-awaiting-input");
    expect(EVENT_FILTER_CHOICES).toContain("message:agent-to-user");
    expect(settingsSchema.eventFilter?.description).toContain("planning-awaiting-input");
  });
});

describe("getSettingString", () => {
  it("treats a blank or whitespace-only value as unset", () => {
    expect(getSettingString({ chatId: "" }, "chatId")).toBeUndefined();
    expect(getSettingString({ chatId: "   " }, "chatId")).toBeUndefined();
    expect(getSettingString({}, "chatId")).toBeUndefined();
    expect(getSettingString({ chatId: 42 }, "chatId")).toBeUndefined();
  });

  it("trims a real value", () => {
    expect(getSettingString({ chatId: "  -1001234  " }, "chatId")).toBe("-1001234");
  });
});

describe("getSettingNumber", () => {
  const bounds = { fallback: 1100, min: 100, max: 60_000 };

  it("falls back for a missing, non-numeric, or non-finite value", () => {
    expect(getSettingNumber({}, "throttleMsPerChat", bounds)).toBe(1100);
    expect(getSettingNumber({ throttleMsPerChat: "1100" }, "throttleMsPerChat", bounds)).toBe(1100);
    expect(getSettingNumber({ throttleMsPerChat: Number.NaN }, "throttleMsPerChat", bounds)).toBe(1100);
    expect(getSettingNumber({ throttleMsPerChat: Number.POSITIVE_INFINITY }, "throttleMsPerChat", bounds)).toBe(1100);
  });

  it("falls back rather than clamping an out-of-bound value", () => {
    expect(getSettingNumber({ throttleMsPerChat: 1 }, "throttleMsPerChat", bounds)).toBe(1100);
    expect(getSettingNumber({ throttleMsPerChat: 10_000_000 }, "throttleMsPerChat", bounds)).toBe(1100);
  });

  it("accepts a value on either inclusive bound and floors fractions", () => {
    expect(getSettingNumber({ throttleMsPerChat: 100 }, "throttleMsPerChat", bounds)).toBe(100);
    expect(getSettingNumber({ throttleMsPerChat: 60_000 }, "throttleMsPerChat", bounds)).toBe(60_000);
    expect(getSettingNumber({ throttleMsPerChat: 1500.7 }, "throttleMsPerChat", bounds)).toBe(1500);
  });
});

describe("getSettingCsv", () => {
  it("accepts a native array and a separated string alike", () => {
    expect(getSettingCsv({ eventFilter: ["failed", "task-wedged"] }, "eventFilter")).toEqual(["failed", "task-wedged"]);
    expect(getSettingCsv({ eventFilter: "failed, task-wedged" }, "eventFilter")).toEqual(["failed", "task-wedged"]);
    expect(getSettingCsv({ eventFilter: "failed\ntask-wedged;failed" }, "eventFilter")).toEqual(["failed", "task-wedged"]);
  });

  it("drops blanks and whitespace and keeps the operator's order", () => {
    expect(getSettingCsv({ eventFilter: " failed ,  , task-wedged " }, "eventFilter")).toEqual(["failed", "task-wedged"]);
    expect(getSettingCsv({ eventFilter: "" }, "eventFilter")).toEqual([]);
    expect(getSettingCsv({}, "eventFilter")).toEqual([]);
  });

  it("collapses duplicates to the first occurrence so a pasted list cannot double-send", () => {
    expect(getSettingCsv({ eventFilter: "failed,failed,failed" }, "eventFilter")).toEqual(["failed"]);
    expect(getSettingCsv({ allowedChatIds: ["1", "1", "2"] }, "allowedChatIds")).toEqual(["1", "2"]);
  });

  it("ignores non-string array entries instead of stringifying them", () => {
    expect(getSettingCsv({ allowedChatIds: ["1", 2, null, "3"] }, "allowedChatIds")).toEqual(["1", "3"]);
  });
});

describe("derived readers", () => {
  it("falls back to the default grouping mode for an unknown value", () => {
    expect(getGroupingMode({ groupingMode: "forumTopic" })).toBe("forumTopic");
    expect(getGroupingMode({ groupingMode: "topics" })).toBe(DEFAULT_GROUPING_MODE);
    expect(getGroupingMode({})).toBe(DEFAULT_GROUPING_MODE);
  });

  it("keeps an empty event filter empty instead of defaulting to every event", () => {
    expect(getEventFilter({}).size).toBe(0);
    expect([...getEventFilter({ eventFilter: "failed,task-wedged" })]).toEqual(["failed", "task-wedged"]);
  });

  it("treats an empty allowlist as nobody", () => {
    expect(getAllowedChatIds({}).size).toBe(0);
    expect(getAllowedChatIds({ allowedChatIds: [] }).size).toBe(0);
    expect(getAllowedChatIds({ allowedChatIds: "123" }).has("123")).toBe(true);
  });

  it("applies the documented defaults for the two numeric knobs", () => {
    expect(getThrottleMsPerChat({})).toBe(DEFAULT_THROTTLE_MS_PER_CHAT);
    expect(getDedupeRetentionDays({})).toBe(DEFAULT_DEDUPE_RETENTION_DAYS);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: 0 })).toBe(DEFAULT_DEDUPE_RETENTION_DAYS);
  });

  it("restricts forum topic colours to the six the Bot API accepts", () => {
    expect(FORUM_TOPIC_ICON_COLORS).toHaveLength(6);
    expect(FORUM_TOPIC_ICON_COLORS.every((color) => Number.isInteger(color) && color > 0)).toBe(true);
  });
});
