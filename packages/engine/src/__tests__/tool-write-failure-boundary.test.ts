/*
STAS-258: a tool write that lands nothing must not be reported as a success, and must not invent a fourth failure shape.

Two invariants, both checked against the registration surfaces rather than a hand-maintained list this card
keeps, so a newly registered write handler is covered the moment it is registered:

1. False-success scan — inside a tool that asks the store to write, a result whose text forwards an error
   value must carry `isError: true`. The logger files `tool_error` only when that flag is set
   (AgentLogger.onToolEnd), so a missing flag is not a style miss: the agent's own `fn_task_logs_read` shows a
   `tool_result` row for a write that landed nothing.
2. Single-shape scan — a hand-composed store-outage message ("Failed to <op>: <error>", "Could not …") must
   compose through the shared store-result composer (storeErrorResult, or storeWriteFailure where the store can
   answer with a genuine miss). A site that forwards a *typed* failure (its own `code`, or an
   `instanceof <SpecificError>` predicate) keeps its own text: relabelling a validation refusal or a
   state-precondition miss as STORE_UNAVAILABLE would be a different lie.

Guard/validation refusals are exempt by construction: they are one-line reasons that forward no error value,
because nothing was attempted. Read failures are exempt on the word as well as the tool — the read half of the
invariant is STAS-256/STAS-259's, and a read failure wearing a store-outage message is that cards' finding, not
this scan's business.

A scan can only describe shape, not behaviour, so the sentinel-drive in tool-write-failure-boundary-drive.test.ts
is the primary enforcement for the engine, executor, and dashboard lanes; these scans are the CI-pinned net that
also covers the fn CLI lane, whose tool bodies need the whole extension runtime to execute.
*/
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STORE_RETRY_GUIDANCE, storeErrorResult } from "../tool-store-errors.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Every file that registers an `fn_*` tool. */
const REGISTRATION_FILES = [
  "packages/engine/src/agent-tools.ts",
  "packages/engine/src/triage.ts",
  "packages/engine/src/agent-heartbeat.ts",
  "packages/engine/src/merger.ts",
  "packages/engine/src/pi.ts",
  "packages/engine/src/executor/create-task-update-tool.ts",
  "packages/engine/src/executor/create-spawn-agent-tool.ts",
  "packages/engine/src/executor/create-task-done-tool.ts",
  "packages/engine/src/executor/create-review-dispute-tool.ts",
  "packages/engine/src/executor/task-add-dep-tool.ts",
  "packages/engine/src/execution/run-verification-tool.ts",
  "packages/dashboard/src/planning-board-tools.ts",
  "packages/dashboard/src/chat.ts",
  "packages/dashboard/src/chat-conversation-references.ts",
  "packages/cli/src/extension.ts",
].filter((relative) => existsSync(`${REPO_ROOT}/${relative}`));

/** An awaited method whose leading verb means "read", so a read failure stays the read card's problem. */
const READ_METHOD_VERBS = [
  "get",
  "list",
  "resolve",
  "peek",
  "read",
  "is",
  "has",
  "count",
  "find",
  "search",
  "load",
  "fetch",
  "preview",
  "validate",
  "check",
  "assert",
  "describe",
  "enumerate",
  "watch",
  "inspect",
  "explain",
  "lookup",
  "estimate",
  "summarize",
  "browse",
  "diff",
  "show",
  "view",
  "parse",
  "evaluate",
  "sanitize",
];

/** Receivers that are never the task store. */
const NON_STORE_RECEIVERS = new Set(["Promise", "Object", "Array", "JSON", "Math", "globalThis"]);

const TOOL_NAME_LINE = /^\s*name:\s*["'`](fn_[a-z0-9_]+)["'`]/;
const TOP_LEVEL_FUNCTION_LINE = /^(export )?(async )?function /;
const AWAITED_CALL = /(await\s+)?(?:this\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\.([A-Za-z_$][\w$]*)\s*\(/g;
const RETURN_START = /^\s*return\b/;
/* `message` is this repo's conventional local for a forwarded error, e.g. `const message = error instanceof Error ? error.message : String(error)`. */
const ERROR_FORWARDING_WORD = /\b(err|error|errorMessage|message|cause|exception)\b/i;
const READ_FAILURE_PHRASE = /\b(read|reads|reading|resolve[ds]?|lookup|list|get|fetch)\b/i;
const STORE_OUTAGE_PHRASE = /(Failed to |Could not )/;

type Segment = { tool: string; startLine: number; lines: string[] };
type FailureReturn = {
  line: number;
  objectText: string;
  textValue: string;
  forwardsError: boolean;
  hasIsError: boolean;
};

function segments(source: string): Segment[] {
  const lines = source.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (TOOL_NAME_LINE.test(line)) starts.push(index);
  });
  return starts.map((startLine) => {
    let endLine = lines.length;
    for (let index = startLine + 1; index < lines.length; index += 1) {
      if (TOOL_NAME_LINE.test(lines[index]) || TOP_LEVEL_FUNCTION_LINE.test(lines[index])) {
        endLine = index;
        break;
      }
    }
    return { tool: lines[startLine].match(TOOL_NAME_LINE)![1], startLine, lines: lines.slice(startLine, endLine) };
  });
}

/** Store mutations this tool asks for. A tool that asks for none cannot produce a store-write failure. */
function storeWritesAwaited(segment: Segment): string[] {
  const text = segment.lines.join("\n");
  const writes: string[] = [];
  const pattern = new RegExp(AWAITED_CALL.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const [, awaited, receiver, method] = match;
    if (!awaited) continue;
    if (NON_STORE_RECEIVERS.has(receiver)) continue;
    if (READ_METHOD_VERBS.includes(/^([a-z]+)/.exec(method)?.[1] ?? method)) continue;
    writes.push(`${receiver}.${method}`);
  }
  return writes;
}

/** The result object a `return` statement hands back, bounded by its own statement. */
function returnObject(lines: string[], from: number): string {
  const first = lines[from];
  if (/;\s*$/.test(first)) return first;
  const collected: string[] = [];
  for (let index = from; index < Math.min(lines.length, from + 14); index += 1) {
    collected.push(lines[index]);
    const trimmed = lines[index].trim();
    if (/;\s*$/.test(trimmed) || /^\};?\s*$/.test(trimmed) || /^\}\);?,?\s*$/.test(trimmed)) break;
  }
  return collected.join("\n");
}

/** A local `const loud = (text) => ({ … isError: true … })` helper counts as carrying the flag. */
function loudHelperNames(segment: Segment): Set<string> {
  const names = new Set<string>();
  segment.lines.forEach((line, index) => {
    const definition = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{?\s*$/.exec(line);
    if (!definition) return;
    if (/isError:\s*true/.test(segment.lines.slice(index, index + 8).join("\n"))) names.add(definition[1]);
  });
  return names;
}

function failureReturns(segment: Segment): FailureReturn[] {
  const loudHelpers = loudHelperNames(segment);
  const found: FailureReturn[] = [];
  for (let index = 0; index < segment.lines.length; index += 1) {
    if (!RETURN_START.test(segment.lines[index])) continue;
    const objectText = returnObject(segment.lines, index);
    if (!/content:/.test(objectText)) continue; // not a tool result
    /*
     * A generic fallback often sits under a typed-error branch inside the same catch, so "am I in a catch?"
     * has to look back further than the previous statement — 12 lines missed exactly that shape.
     */
    const nearbyCatch = segment.lines.slice(Math.max(0, index - 40), index).some((line) => /\bcatch\b/.test(line));
    const interpolations = objectText.match(/\$\{[^}]*\}/g) ?? [];
    const forwardsError =
      interpolations.some((interpolation) => /\.error\b/.test(interpolation)) ||
      (nearbyCatch && interpolations.some((interpolation) => ERROR_FORWARDING_WORD.test(interpolation))) ||
      [...loudHelpers].some((name) => new RegExp(`return\\s+${name}\\s*\\(`).test(segment.lines[index]));
    if (!forwardsError) continue;
    const hasIsError =
      /isError:\s*true/.test(objectText) ||
      [...loudHelpers].some((name) => new RegExp(`return\\s+${name}\\s*\\(`).test(segment.lines[index]));
    const textValue = /text:\s*(`[^`]*`|"[^"]*"|'[^']*')/.exec(objectText)?.[1] ?? "";
    found.push({ line: segment.startLine + index + 1, objectText, textValue, forwardsError, hasIsError });
  }
  return found;
}

function typedFailureDiscriminator(objectText: string, preceding: string): boolean {
  const window = `${preceding}\n${objectText}`;
  if (/\binstanceof\s+(?!Error\b|unknown\b)[A-Z][\w$]*/.test(window)) return true;
  return /\bcode:\s*(["'`][A-Z0-9_]+["'`]|[A-Za-z_$][\w$.]*)/.test(window);
}

function failureSitesPerFile(relative: string) {
  const source = readFileSync(`${REPO_ROOT}/${relative}`, "utf8");
  return segments(source).map((segment) => ({ segment, failures: failureReturns(segment) }));
}

describe("STAS-258 write-failure boundary (CI-pinned scans over the tool registration surfaces)", () => {
  it("enumerates every file that registers a tool", () => {
    expect(REGISTRATION_FILES).toHaveLength(15);
  });

  it("the composer the scans key on is the shared store shape", () => {
    const composed = storeErrorResult("task update", new Error("boom"));
    expect(composed.content[0].text).toContain(STORE_RETRY_GUIDANCE);
    expect(composed.isError).toBe(true);
  });

  describe.each(REGISTRATION_FILES)("%s", (relative) => {
    const source = readFileSync(`${REPO_ROOT}/${relative}`, "utf8");
    const perTool = failureSitesPerFile(relative);

    it("every registered tool in this file is enumerated", () => {
      const declared = (source.match(new RegExp(TOOL_NAME_LINE.source, "gm")) ?? []).length;
      expect(perTool).toHaveLength(declared);
    });

    it("no attempted write reports its failure as a success row", () => {
      const violations: string[] = [];
      for (const { segment, failures } of perTool) {
        if (storeWritesAwaited(segment).length === 0) continue; // read-only tool: the read card's half
        for (const returned of failures) {
          if (returned.hasIsError) continue;
          violations.push(`${relative}:${returned.line} ${segment.tool}`);
        }
      }
      expect(violations, violations.join(" | ")).toEqual([]);
    });

    it("a hand-composed store-outage message composes through the shared store-result composer instead", () => {
      const violations: string[] = [];
      for (const { segment, failures } of perTool) {
        if (storeWritesAwaited(segment).length === 0) continue;
        for (const returned of failures) {
          if (!STORE_OUTAGE_PHRASE.test(returned.textValue)) continue; // a specific reason, not an outage claim
          if (READ_FAILURE_PHRASE.test(returned.textValue)) continue; // the read card's half
          if (/store(WriteFailure|ErrorResult)\s*\(/.test(returned.objectText)) continue;
          const before = segment.lines
            .slice(Math.max(0, returned.line - segment.startLine - 15), returned.line - segment.startLine)
            .join("\n");
          if (typedFailureDiscriminator(returned.objectText, before)) continue;
          violations.push(`${relative}:${returned.line} ${segment.tool}`);
        }
      }
      expect(violations, violations.join(" | ")).toEqual([]);
    });
  });
});
