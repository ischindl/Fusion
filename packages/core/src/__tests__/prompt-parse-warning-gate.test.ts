/**
 * FNXC:ListReadPromptParseCache 2026-11-09-12:05 (RUFU-495 residual pass):
 * Source-level guard for the two invariants a behavioural test cannot see from the outside.
 *
 * (1) ONE SHARED GATE PER WARNING SITE. Every warning about a `PROMPT.md` steps failure must be
 * emitted through `shouldWarnPromptParseFailure(store, <card id>, <detail>)`, which keys the
 * once-per-process memory on the CARD ID. The shipped defect this pass fixed is exactly the shape a
 * behavioural test on one surface cannot see: the gate keyed on card id PLUS the composed message, so
 * each read surface (`listTasks`, `searchTasks`, `searchTasksGlobal`, the detail read, the `updateStep`
 * auto-init) kept its own slot and a single malformed card produced ~1.7 warning lines/s forever.
 * So the guard checks the ARGUMENT ROLES, not just that a gate is present: argument two is the card
 * id and argument three is the detail. A reintroduced `gate(store, detail, detail)` fails here even
 * though every single-surface warning test still passes.
 *
 * (2) ONE FUNNEL PER PARSE. A read path may only obtain steps from `PROMPT.md` through
 * `store.parseStepsFromPrompt`, the memoised funnel. A path that re-reads and re-parses the file
 * itself (or calls the registry parser directly) re-creates the per-card, per-read, per-poll cost
 * this task exists to remove, and no behavioural test notices because the RESULT stays correct.
 *
 * The scan is AST-based on purpose: the same words occur in documentation blocks (the runbook
 * sentence quoting the warning), and a text grep would report those as ungated warnings.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const CORE_SRC = join(__dirname, "..");
/** The three files that own a `PROMPT.md` steps read, a steps failure warning, or the funnel itself. */
const SCANNED_FILES = [
  join(CORE_SRC, "task-store/reads.ts"),
  join(CORE_SRC, "task-store/merge-queue-ops.ts"),
  join(CORE_SRC, "task-store/task-artifacts-ops.ts"),
];

const FAILURE_MARKER = "steps from PROMPT.md";
const GATE_NAME = "shouldWarnPromptParseFailure";
/** The gate's key argument: the bare card `id` or a `*.id` property access — never the message. */
const cardIdArgument = /^(?:[A-Za-z_$][\w$]*\.)*id$/;

function sourceFile(path: string): { sf: ts.SourceFile; text: string } {
  const text = readFileSync(path, "utf-8");
  return {
    sf: ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
    text,
  };
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

describe("prompt-parse warning gate (source-level guard, RUFU-495)", () => {
  /**
   * Finds every `catch` clause that composes or reports a `PROMPT.md` steps failure, and returns the
   * shape of its warning call. A catch that mentions the failure but never warns is legal (the funnel
   * itself caches the message and re-throws without emitting anything).
   */
  const warningSites = SCANNED_FILES.flatMap((path) => {
    const { sf } = sourceFile(path);
    const sites: Array<{
      file: string;
      line: number;
      warns: boolean;
      gated: boolean;
      gateArgs: string[] | null;
      detailIsThirdArg: boolean;
      secondArgIsCardId: boolean;
    }> = [];
    walk(sf, (node) => {
      if (!ts.isCatchClause(node)) return;
      const clauseText = node.getText(sf);
      if (!clauseText.includes(FAILURE_MARKER)) return;
      let warnCall: ts.CallExpression | null = null;
      let gateCall: ts.CallExpression | null = null;
      let gateIsWarnGuard = false;
      walk(node, (inner) => {
        if (!ts.isCallExpression(inner)) return;
        const callee = inner.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "warn") warnCall = inner;
        if (ts.isIdentifier(callee) && callee.text === GATE_NAME) {
          gateCall = inner;
          /*
          Climb out of `!`/parenthesis wrappers to reach the `if` that consumes the gate as its test —
          the gate call's own parent is the `!` node, not the `if`, in the inverted shape.
          */
          let gateExpr: ts.Node = inner;
          let negated = false;
          while (
            ts.isPrefixUnaryExpression(gateExpr.parent) ||
            ts.isParenthesizedExpression(gateExpr.parent)
          ) {
            gateExpr = gateExpr.parent;
            if (ts.isPrefixUnaryExpression(gateExpr)) negated = true;
          }
          const host = gateExpr.parent;
          if (!ts.isIfStatement(host) || host.expression !== gateExpr) return;
          const thenStatement = host.thenStatement;
          const thenText = thenStatement.getText(sf);
          /*
          Two legal shapes, both meaning "one warning per card": the gate ADMITS the warn
          (`if (gate(..)) warn(..)`), or the gate REFUSES the rest of the block
          (`if (!gate(..)) return;`, then the warn follows). A catch that calls the gate for some OTHER
          reason and warns anyway stays a failure — the shape is checked per warn call, not per clause.
          */
          if (!negated && thenText.includes(".warn(")) gateIsWarnGuard = true;
          if (negated && (ts.isReturnStatement(thenStatement) || ts.isThrowStatement(thenStatement))) {
            gateIsWarnGuard = true;
          }
        }
      });
      const args = gateCall ? (gateCall.arguments as unknown as ts.NodeArray<ts.Expression>) : null;
      const second = args && args[1];
      const third = args && args[2];
      if (!warnCall && !gateCall) return;
      sites.push({
        file: relative(join(CORE_SRC, "..", "..", ".."), path),
        line: warnCall
          ? sf.getLineAndCharacterOfPosition(warnCall.getStart(sf)).line + 1
          : sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        warns: Boolean(warnCall),
        gated: gateIsWarnGuard,
        gateArgs: args ? Array.from(args).map((arg) => arg.getText(sf)) : null,
        detailIsThirdArg: Boolean(third && third.getText(sf).includes("detail")),
        // The key must be the CARD: the bare `id` or a `*.id` property access. The shipped defect
        // keyed this same gate on the composed `detail`, which is ALSO a bare identifier, so the
        // argument's NAME is the only thing that distinguishes a card key from a message key.
        secondArgIsCardId: Boolean(second && cardIdArgument.test(second.getText(sf))),
      });
    });
    return sites;
  });

  it("finds the warning sites the fix claims to have gated", () => {
    // 4 read surfaces (detail, listTasks, searchTasks, searchTasksGlobal) + the updateStep auto-init.
    expect(warningSites.length).toBeGreaterThanOrEqual(5);
    expect(warningSites.filter((site) => site.warns).length).toBeGreaterThanOrEqual(5);
  });

  it("gates every prompt-parse warning behind the shared once-per-card helper", () => {
    for (const site of warningSites.filter((entry) => entry.warns)) {
      expect(
        site.gated,
        `${site.file}:${site.line} warns about a PROMPT.md steps failure without gating it on ${GATE_NAME}`,
      ).toBe(true);
    }
  });

  it("keys the gate on the card id, never on the composed message", () => {
    for (const site of warningSites.filter((entry) => entry.gateArgs)) {
      expect(
        site.secondArgIsCardId,
        `${site.file}:${site.line} keys ${GATE_NAME} on ${site.gateArgs?.[1]} — the key must be the card id, ` +
          `or each surface keeps its own once-per-process slot and one malformed card warns forever`,
      ).toBe(true);
      expect(
        site.detailIsThirdArg,
        `${site.file}:${site.line} does not pass the composed detail to ${GATE_NAME}, so the reported text ` +
          `can drift away from what the gate remembered`,
      ).toBe(true);
    }
  });

  it("routes every PROMPT.md steps parse through the single memoised funnel", () => {
    const readSurfaces = [
      join(CORE_SRC, "task-store/reads.ts"),
      join(CORE_SRC, "task-store/merge-queue-ops.ts"),
    ];
    for (const path of readSurfaces) {
      const { sf, text } = sourceFile(path);
      const rel = relative(join(CORE_SRC, "..", "..", ".."), path);
      const offenders: string[] = [];
      walk(sf, (node) => {
        if (!ts.isCallExpression(node)) return;
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
        /*
        Only the STEPS parse is funnelled. The detail read's `readFile(promptPath…)` stays legal: it
        returns the prompt TEXT for the card body, a different product from the parsed plan, and
        memoising it would need its own freshness stamp for no additional saving on the board lane.
        */
        if (name === "parseStepHeadings" || name === "parseStepsFromPromptImpl" || name === "getStepParser") {
          offenders.push(name);
        }
      });
      expect(
        offenders,
        `${rel} resolves steps outside the funnel (${offenders.join(", ")}); read paths must call ` +
          `store.parseStepsFromPrompt so the memo and its freshness check stay below them`,
      ).toEqual([]);
      // The funnel call itself must be present — the guard above only forbids the alternatives.
      expect(text.includes("parseStepsFromPrompt("), `${rel} no longer syncs steps at all`).toBe(true);
    }
  });

  /*
  FNXC:ListReadPromptParseCache 2026-11-09-12:05 (RUFU-495 residual pass):
  The census is the half that makes the rule above complete. Forbidding the alternatives only helps
  while the KNOWN surfaces keep calling the funnel; a new read surface that syncs steps somewhere else
  (a `getTasksForColumn`, a board-feed rollup) would pass a shape check silently. A new funnel call
  site has to appear here with a reason, the same way the repo's other call-site allow-lists work.
  */
  it("keeps the funnel call-site census honest", () => {
    const census: Record<string, number> = {};
    for (const path of SCANNED_FILES) {
      const { sf } = sourceFile(path);
      let calls = 0;
      walk(sf, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "parseStepsFromPrompt") calls += 1;
        if (ts.isIdentifier(callee) && callee.text === "parseStepsFromPromptImpl") calls += 1;
      });
      census[relative(join(CORE_SRC, "..", "..", ".."), path)] = calls;
    }
    expect(census).toEqual({
      // 1 detail read + listTasks rollup + searchTasks rollup + searchTasksGlobal rollup.
      "packages/core/src/task-store/reads.ts": 4,
      // The updateStep auto-init, which degrades to the persisted steps and warns once.
      "packages/core/src/task-store/merge-queue-ops.ts": 1,
      // The funnel's own body: it defines the memo, it does not call itself. Its one caller is the
      // `TaskStore.parseStepsFromPrompt` wrapper in store.ts, which is what every surface above calls.
      "packages/core/src/task-store/task-artifacts-ops.ts": 0,
    });
  });
});
