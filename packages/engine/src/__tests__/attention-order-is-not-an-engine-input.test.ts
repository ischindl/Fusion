import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
The coupling the requirement forbids, enforced where it would actually appear.

The attention ladder is a PRESENTATION rule: it decides what an operator sees first. The engine reads
lanes too - the dispatcher pulls the next card to execute - and the two reads are already separated by
order mode (`queue-order` is dispatch's, `attention-order` is the board's). That separation is the whole
safety property, and nothing in the type system protects it: one `order: "attention"` in a scheduler call
would make the engine start executing the card that LOOKS most urgent rather than the one that has waited
longest, and every queue-order test would stay green because the dispatcher would still be internally
consistent.

So the guard is textual and it is over this package's production sources: the words that name the
attention lane's inputs may not appear in the engine at all. A false positive here is cheap to resolve -
it names the file - and the failure it prevents is a behaviour no test in either package would report.

Deliberate scope choices:
- `src/__tests__` is excluded. This file itself, and any future test that asserts the absence, must be
  allowed to name the tokens it is looking for.
- The tokens are the API surface names, not the word "attention" in prose. Comments explaining the
  boundary have to be writable, and an assertion over comments would be testing prose, which the project
  rules forbid.

FNXC:BoardOrdering 2026-11-13-14:05 (RUFU-526 code review F-3):
The scope choice above was stated but not implemented: the scan matched over the raw file text, so an
engine comment that legitimately explains the boundary ("unlike `resolveAttentionTier`, dispatch order
...") would fail the guard, and the cheapest way to silence it is to delete a true comment - exactly
the appeasement AGENTS.md records under "Tests Assert Behavior, Never Source Text Or Comments". The
match now runs on `stripComments` output, the same shape `legacy-tombstones.test.ts` uses for the same
reason, so the guard bites the dependency (an import, a call, a string passed as an order mode) and
never the prose that documents it.
*/

/**
 * Drop block and line comments so the scan sees code only. Line-comment detection keeps a `//` inside a
 * URL (`https://...`) intact by requiring the two slashes not to follow a colon, which is why it is not
 * the naive `/\/\/.*$/gm`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Names that only exist on the presentation side of the boundary. */
const FORBIDDEN = [
  "attention-order",
  "attentionReviewScope",
  "afterAttentionKey",
  "taskAttentionOrderBy",
  "taskAttentionOrderCursorPredicate",
  "resolveAttentionTier",
  "sqlAttentionTier",
] as const;

interface SourceFile {
  /** Absolute path, for reading. */
  path: string;
  /** Package-relative path, for reporting. */
  shown: string;
}

function productionSources(dir: string, prefix = ""): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const shown = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Test sources are where the boundary is ASSERTED, so they are allowed to name the tokens.
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...productionSources(path, shown));
    } else if (entry.name.endsWith(".ts")) {
      found.push({ path, shown });
    }
  }
  return found;
}

describe("attention order is not an engine input", () => {
  it("names no attention-lane API anywhere in the engine's production sources", () => {
    const root = new URL("..", import.meta.url).pathname;
    const files = productionSources(root);
    expect(files.length).toBeGreaterThan(50);

    const hits: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file.path, "utf8"));
      for (const token of FORBIDDEN) {
        if (source.includes(token)) hits.push(`${file.shown}: ${token}`);
      }
    }

    expect(hits).toEqual([]);
  });
});
