import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_ID_TOKEN_PROSE_SOURCE, TASK_ID_TOKEN_SOURCE } from "../execution/branch-conflicts.js";
import { TASK_ID_TOKEN_PROSE_SOURCE as CORE_PROSE, TASK_ID_TOKEN_SOURCE as CORE_TOKEN } from "@fusion/core";

/*
FNXC:TaskIdGrammar 2026-11-18-05:58 (RUFU-730):
RUFU-352 built this grammar in the engine; RUFU-730 moved the definition into `@fusion/core` because core
may not import the engine, and three core parsers were still `FN-\d+`-only as a result. This file is the
ratchet that keeps the move from silently reversing into a fork: the engine must RE-EXPORT core's values
(by identity, not by an equal snapshot) and core must never reach back up into the engine for them.
*/
// Resolved against the repository root, not this test's directory: these are `@fusion/core` sources.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CORE_FILES_FORBIDDEN_FROM_ENGINE = [
  "packages/core/src/tasks/task-id-token.ts",
  "packages/core/src/merge/no-op-completion-marker.ts",
  "packages/core/src/duplicates/explicit-duplicate-marker.ts",
  "packages/core/src/task-store/errors.ts",
  "packages/core/src/tasks/task-title-id-drift.ts",
];

describe("task-id grammar has exactly one dictionary", () => {
  it("the engine re-exports core's token rather than restating it", () => {
    // `toBe` is identity over primitive strings: a re-declared literal with the same text would still
    // pass, which is why the source scans below exist. Together they make a fork impossible.
    expect(TASK_ID_TOKEN_SOURCE).toBe(CORE_TOKEN);
    expect(TASK_ID_TOKEN_PROSE_SOURCE).toBe(CORE_PROSE);
  });

  it("branch-conflicts.ts declares no grammar literal of its own", () => {
    const source = readFileSync(fileURLToPath(new URL("../execution/branch-conflicts.ts", import.meta.url)), "utf8");
    // A re-introduced `[A-Z][A-Z0-9]*-\d+` in this file is the second source of truth this card removes.
    expect(source).not.toMatch(/\[A-Z\]\[A-Z0-9\]\*-/);
    expect(source).toMatch(/from "@fusion\/core"/);
  });

  it.each(CORE_FILES_FORBIDDEN_FROM_ENGINE)("%s never imports the engine", async (relative) => {
    const source = readFileSync(join(REPO_ROOT, relative), "utf8");
    // `@fusion/core` may not import `@fusion/engine` (circularity + statically-analyzable import rule),
    // which is the whole reason the dictionary lives in core and the engine re-exports it.
    expect(source).not.toMatch(/@fusion\/engine/);
  });

  it("the anchored composition agrees with task-id-integrity's canonical grammar", () => {
    // `task-id-integrity.ts` owns a capture-group pattern its detection code indexes into, so it stays a
    // separate literal. The shared token must still decide the same set of ids, or minting and parsing
    // disagree about which strings name a card. The table below states that pattern's MEASURED verdicts
    // rather than copying its source, because a second grammar literal is what this card forbids.
    const expected: Array<[string, boolean]> = [
      ["FN-1", true],
      ["RUFU-517", true],
      ["SANE4-42", true],
      ["x", false],
      ["A1-2-3", false],
    ];
    const anchored = new RegExp(`^${TASK_ID_TOKEN_SOURCE}$`, "i");
    for (const [id, verdict] of expected) {
      expect([id, anchored.test(id)]).toEqual([id, verdict]);
    }
    expect(anchored.test("fn-1")).toBe(true);
  });
});
