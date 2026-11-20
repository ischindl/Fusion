import { describe, expect, it } from "vitest";

import {
  buildQuestionKeyboard,
  callbackDataFits,
  callbackDataFor,
  capHtml,
  clipText,
  dashboardCardUrl,
  escapeHtml,
  extractAwaitInputPauseEpochMs,
  extractAwaitInputQuestion,
  flatPrefix,
  hasAwaitInputMarker,
  parseInlineOptions,
  renderEventMessage,
} from "../format.js";
import { TELEGRAM_CALLBACK_DATA_BYTE_LIMIT, TELEGRAM_TEXT_CHAR_LIMIT } from "../settings.js";

describe("escapeHtml", () => {
  it("escapes the three characters Telegram HTML treats as markup", () => {
    expect(escapeHtml('<b>&amp;</b>')).toBe("&lt;b&gt;&amp;amp;&lt;/b&gt;");
  });

  it("leaves plain card titles untouched", () => {
    expect(escapeHtml("Fix the lockfile drift")).toBe("Fix the lockfile drift");
  });
});

describe("clipText and capHtml", () => {
  it("leaves a short text alone and clips a long one with an ellipsis", () => {
    expect(clipText("short", 100)).toBe("short");
    expect(clipText("abcdefghij", 5)).toBe("abcd…");
    expect(clipText("abcdefghij", 5)).toHaveLength(5);
    expect(clipText("abc", 0)).toBe("");
  });

  it("never exceeds the message ceiling", () => {
    expect(capHtml("x".repeat(5_000), 100)).toHaveLength(100);
    expect(capHtml("short")).toBe("short");
  });

  it("drops a tag left half-open by the cut", () => {
    const capped = capHtml("<b>aaaaaaaaaa</b>tail", 15);
    expect(capped.endsWith("…")).toBe(true);
    expect(capped).not.toContain("<b>aaaaaa…");
    expect((capped.match(/</g) ?? []).length).toBe((capped.match(/>/g) ?? []).length);
  });
});

describe("flatPrefix", () => {
  it("names the project and the card", () => {
    expect(flatPrefix("Fusion", "RUFU-782")).toBe("[Fusion/RUFU-782]");
    expect(flatPrefix("Fusion", undefined)).toBe("[Fusion]");
    expect(flatPrefix("  ", "RUFU-782")).toBe("[project/RUFU-782]");
  });
});

describe("extractAwaitInputQuestion", () => {
  it("strips the node id and the watermark the engine writes", () => {
    const pausedReason = "workflow-input:step-execute@1730000000000: Which branch should I merge into?";
    expect(extractAwaitInputQuestion(pausedReason)).toBe("Which branch should I merge into?");
    expect(hasAwaitInputMarker(pausedReason)).toBe(true);
  });

  it("keeps a multi-line question intact", () => {
    expect(extractAwaitInputQuestion("workflow-input:ask@123: line one\nline two")).toBe("line one\nline two");
  });

  it("returns undefined for a pause that is not a workflow await-input park", () => {
    expect(extractAwaitInputQuestion("workflow-cli-approval:execute@1: pnpm build")).toBeUndefined();
    expect(extractAwaitInputQuestion("human-plan-approval")).toBeUndefined();
    expect(extractAwaitInputQuestion(undefined)).toBeUndefined();
    expect(extractAwaitInputQuestion("")).toBeUndefined();
    expect(hasAwaitInputMarker("workflow-cli-approval:execute@1: pnpm build")).toBe(false);
  });

  it("returns an empty question when the marker is present but no text follows it", () => {
    expect(extractAwaitInputQuestion("workflow-input:ask@123:   ")).toBe("");
  });
});

/*
* FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
* The watermark is the only thing that says WHICH park a question row belongs to, so the plugin reads it
* out of the marker instead of guessing from "is a row still open". These cases pin the shape the engine
* actually writes (`packages/engine/src/executor/await-input-node.ts`) and, just as importantly, the shapes
* that must yield `undefined` rather than a fabricated date.
*/
describe("extractAwaitInputPauseEpochMs", () => {
  it("reads the epoch the engine stamped for this park", () => {
    expect(extractAwaitInputPauseEpochMs("workflow-input:step-execute@1730000000000: Which branch?"))
      .toBe(1_730_000_000_000);
    expect(extractAwaitInputPauseEpochMs("workflow-input:ask@1: line one\nline two")).toBe(1);
  });

  it("refuses to invent a watermark the marker does not carry", () => {
    // No watermark at all: the pause cannot be dated, so nothing may be concluded about a row's age.
    expect(extractAwaitInputPauseEpochMs("workflow-input:ask: Which branch?")).toBeUndefined();
    expect(extractAwaitInputPauseEpochMs("workflow-input:ask")).toBeUndefined();
    // A different pause family, whose resume semantics this bridge must not touch.
    expect(extractAwaitInputPauseEpochMs("workflow-cli-approval:execute@1: pnpm build")).toBeUndefined();
    expect(extractAwaitInputPauseEpochMs("human-plan-approval")).toBeUndefined();
    expect(extractAwaitInputPauseEpochMs(undefined)).toBeUndefined();
    expect(extractAwaitInputPauseEpochMs("")).toBeUndefined();
  });

  it("treats a non-numeric watermark as absent, not as zero", () => {
    // `0` would make every open row look newer than the pause, which silences the card forever.
    expect(extractAwaitInputPauseEpochMs("workflow-input:ask@soon: Which branch?")).toBeUndefined();
  });
});

describe("buildQuestionKeyboard", () => {
  it("builds no keyboard when there are no options", () => {
    expect(buildQuestionKeyboard("abc", undefined)).toBeUndefined();
    expect(buildQuestionKeyboard("abc", [])).toBeUndefined();
    expect(buildQuestionKeyboard("abc", ["  ", ""])).toBeUndefined();
  });

  it("puts every option on its own row, numbered so a tap names its option", () => {
    const markup = buildQuestionKeyboard("q7f3a", ["main", "develop"]);
    expect(markup?.inline_keyboard).toEqual([
      [{ text: "main", callback_data: "q:q7f3a:0" }],
      [{ text: "develop", callback_data: "q:q7f3a:1" }],
    ]);
  });

  it("refuses a keyboard whose callback_data would cross the 64-byte ceiling", () => {
    const tooLong = "z".repeat(80);
    expect(callbackDataFits(callbackDataFor(tooLong))).toBe(false);
    expect(buildQuestionKeyboard(tooLong, ["yes"])).toBeUndefined();
    expect(Buffer.byteLength(callbackDataFor("short"), "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_BYTE_LIMIT);
  });

  it("caps a button label so a long option cannot break the message", () => {
    const markup = buildQuestionKeyboard("q1", ["y".repeat(200)]);
    expect(markup?.inline_keyboard[0]?.[0]?.text ?? "").toHaveLength(64);
  });
});

describe("parseInlineOptions", () => {
  it("reads an inlined option list, and only a real one", () => {
    expect(parseInlineOptions("Which branch? (main | develop)")).toEqual(["main", "develop"]);
    expect(parseInlineOptions("no options here")).toEqual([]);
    expect(parseInlineOptions("only (one)")).toEqual([]);
    expect(parseInlineOptions(undefined)).toEqual([]);
  });
});

describe("dashboardCardUrl", () => {
  it("adds no link when the base url is not configured", () => {
    expect(dashboardCardUrl(undefined, "p1", "RUFU-782")).toBeUndefined();
    expect(dashboardCardUrl("  ", "p1", "RUFU-782")).toBeUndefined();
  });

  it("carries the project id because task ids are project-local", () => {
    expect(dashboardCardUrl("https://dash.example/", "p1", "RUFU-782")).toBe(
      "https://dash.example/?project=p1&task=RUFU-782",
    );
  });
});

describe("renderEventMessage", () => {
  const base = {
    event: "planning-awaiting-input",
    projectId: "p1",
    projectName: "Fusion",
    taskId: "RUFU-782",
    taskTitle: "Telegram bridge",
  };

  it("prefixes the project and card only in flat mode", () => {
    const flat = renderEventMessage({ ...base, groupingMode: "flat", question: "Which branch?" });
    const topic = renderEventMessage({ ...base, groupingMode: "privateTopics", question: "Which branch?" });
    expect(flat.startsWith("[Fusion/RUFU-782]")).toBe(true);
    expect(topic).not.toContain("[Fusion/RUFU-782]");
  });

  it("escapes a title that contains markup instead of corrupting the message", () => {
    const text = renderEventMessage({ ...base, taskTitle: "<b>evil</b>", groupingMode: "flat" });
    expect(text).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(text).not.toContain("<b>evil</b>");
  });

  it("tells the operator how to answer and links the card only when configured", () => {
    const withLink = renderEventMessage({ ...base, groupingMode: "flat", question: "Which branch?", dashboardBaseUrl: "https://dash.example" });
    const withoutLink = renderEventMessage({ ...base, groupingMode: "flat", question: "Which branch?" });
    expect(withLink).toContain("Open in dashboard");
    expect(withoutLink).not.toContain("Open in dashboard");
    expect(withoutLink).toContain("Answer by replying to this message.");
  });

  it("invites a button press instead of only a reply when options exist", () => {
    const text = renderEventMessage({ ...base, groupingMode: "flat", question: "Which branch?", options: ["main", "develop"] });
    expect(text).toContain("Press an option");
  });

  it("fits a 5000-character question inside the 4096-character ceiling", () => {
    const text = renderEventMessage({ ...base, groupingMode: "flat", question: "q".repeat(5_000) });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_CHAR_LIMIT);
    expect(text).toContain("…");
  });

  it("caps a detail body that alone would exceed the ceiling", () => {
    const text = renderEventMessage({ ...base, event: "task-wedged", groupingMode: "flat", detail: "d".repeat(20_000) });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_CHAR_LIMIT);
    expect(text.endsWith("…")).toBe(true);
  });

  it("keeps the headline and the answer prompt when the question is clipped", () => {
    const text = renderEventMessage({ ...base, groupingMode: "flat", question: "y".repeat(5_000) });
    expect(text).toContain("planning-awaiting-input");
    expect(text).toContain("Answer by replying to this message.");
  });

  it("renders a plain event with no question as headline plus detail", () => {
    const text = renderEventMessage({ ...base, event: "task-wedged", groupingMode: "flat", detail: "merge blocker: pre-merge-gate-pending" });
    expect(text).toContain("task-wedged");
    expect(text).toContain("merge blocker");
    expect(text).not.toContain("Answer by replying");
  });
});
