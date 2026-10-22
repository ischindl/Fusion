import { describe, expect, it } from "vitest";

import {
  errorTextWithThrowSite,
  formatThrowSite,
  MAX_THROW_SITE_FRAMES,
} from "../workflows/error-throw-site.js";

/*
FNXC:ErrorThrowSite 2026-10-22-13:38:
RUFU-773 unit coverage for the throw-site formatter. The motivating record is a persisted History
body `Plan Review failed before producing a verdict: Cannot read properties of undefined
(reading 'trim')` with no frame anywhere — the fix may only ADD bounded frames after the message,
so every assertion here is either "the message is an exact prefix" or "the frames are bounded /
absent when they would mislead".
*/

const RUFU_773_MESSAGE = "Cannot read properties of undefined (reading 'trim')";

function stackWith(frames: string[], messageLine = `TypeError: ${RUFU_773_MESSAGE}`): string {
  return [messageLine, ...frames].join("\n");
}

function typeErrorWithStack(frames: string[]): TypeError {
  const error = new TypeError(RUFU_773_MESSAGE);
  error.stack = stackWith(frames);
  return error;
}

const FRAMES = [
  "    at buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)",
  "    at runGraphCustomNode (/app/packages/engine/dist/executor/run-graph-custom-node.js:402:11)",
  "    at WorkflowGraphExecutor.executeNodeWithRetries (/app/packages/engine/dist/workflows/workflow-graph-executor.js:2216:20)",
  "    at runOptionalGroup (/app/packages/engine/dist/workflows/workflow-graph-loop.js:297:21)",
  "    at Object.runGraphCustomNode (/app/packages/engine/dist/executor/execute-workflow-graph.js:915:18)",
];

describe("formatThrowSite", () => {
  it("joins the first frames of a multi-frame stack with ' | ' and drops the message line", () => {
    const site = formatThrowSite(typeErrorWithStack(FRAMES.slice(0, 3)));
    expect(site).toBe(
      "at buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)"
      + " | at runGraphCustomNode (/app/packages/engine/dist/executor/run-graph-custom-node.js:402:11)"
      + " | at WorkflowGraphExecutor.executeNodeWithRetries (/app/packages/engine/dist/workflows/workflow-graph-executor.js:2216:20)",
    );
    expect(site).not.toContain("TypeError");
    expect(site).not.toContain(RUFU_773_MESSAGE);
    expect(site).not.toContain("\n");
  });

  it(`bounds the throw site to the first ${MAX_THROW_SITE_FRAMES} frames`, () => {
    const site = formatThrowSite(typeErrorWithStack(FRAMES))!;
    const kept = site.split(" | ");
    expect(kept).toHaveLength(MAX_THROW_SITE_FRAMES);
    expect(kept[0]).toContain("at buildReviewerPrompt");
    expect(kept.at(-1)).toContain("at runOptionalGroup");
    expect(site).not.toContain("Object.runGraphCustomNode");
  });

  it("keeps only frame lines when the stack carries extra non-frame lines", () => {
    const site = formatThrowSite(typeErrorWithStack([
      "  --- async stack boundary ---",
      FRAMES[0],
      "  caused by: undefined is not an object",
      FRAMES[1],
    ]))!;
    expect(site.split(" | ")).toEqual([
      "at buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)",
      "at runGraphCustomNode (/app/packages/engine/dist/executor/run-graph-custom-node.js:402:11)",
    ]);
  });

  it("returns undefined for a non-Error throw, a missing stack, a blank stack, and a frameless stack", () => {
    expect(formatThrowSite("just a string")).toBeUndefined();
    expect(formatThrowSite(undefined)).toBeUndefined();
    expect(formatThrowSite({ message: RUFU_773_MESSAGE })).toBeUndefined();
    expect(formatThrowSite(Object.assign(new TypeError(RUFU_773_MESSAGE), { stack: undefined }))).toBeUndefined();
    expect(formatThrowSite(Object.assign(new TypeError(RUFU_773_MESSAGE), { stack: "   " }))).toBeUndefined();
    expect(formatThrowSite(Object.assign(new TypeError(RUFU_773_MESSAGE), {
      stack: `TypeError: ${RUFU_773_MESSAGE}\nCaused by: nothing callable`,
    }))).toBeUndefined();
  });

  it("reads a real thrown TypeError's own stack without inventing frames", () => {
    let thrown: unknown;
    try {
      (undefined as unknown as { spec: string }).spec.trim();
    } catch (error) {
      thrown = error;
    }
    const site = formatThrowSite(thrown);
    expect(site).toBeDefined();
    expect(site!.startsWith("at ")).toBe(true);
    expect(site!.split(" | ").length).toBeLessThanOrEqual(MAX_THROW_SITE_FRAMES);
  });
});

describe("errorTextWithThrowSite", () => {
  it("keeps the original message as an exact prefix and appends the bounded frames", () => {
    const error = typeErrorWithStack(FRAMES);
    const text = errorTextWithThrowSite(RUFU_773_MESSAGE, error);
    expect(text.startsWith(RUFU_773_MESSAGE)).toBe(true);
    expect(text).toContain(`| at ${"buildReviewerPrompt (/app/packages/engine/dist/executor/run-graph-custom-node.js:120:14)"}`);
    expect(text).not.toContain("Object.runGraphCustomNode");
  });

  it("returns the message byte-identical when no usable stack exists", () => {
    const error = Object.assign(new Error(RUFU_773_MESSAGE), { stack: undefined });
    expect(errorTextWithThrowSite(RUFU_773_MESSAGE, error)).toBe(RUFU_773_MESSAGE);
    expect(errorTextWithThrowSite(RUFU_773_MESSAGE, "not even an Error")).toBe(RUFU_773_MESSAGE);
  });

  it("leaves messages that downstream classifiers own positionally byte-identical", () => {
    // `extractMissingWorktreePathFromSessionStartFailure` reads everything after this prefix as a
    // filesystem path, so appended frames would corrupt the recovery decision.
    const worktreeMessage = `Refusing to start coding agent in missing worktree: /tmp/fusion/worktrees/FN-1`;
    expect(errorTextWithThrowSite(worktreeMessage, typeErrorWithStack(FRAMES))).toBe(worktreeMessage);
    // `isSessionContentionGraphFailure` pattern-matches the published error text.
    const contentionMessage = "active-session path /tmp/session.json is held by task FN-2";
    expect(errorTextWithThrowSite(contentionMessage, typeErrorWithStack(FRAMES))).toBe(contentionMessage);
  });
});
