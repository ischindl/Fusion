import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertAgentLogTaskId,
  getAgentLogsImpl,
  getAgentLogCountImpl,
} from "../task-store/task-artifacts-ops.js";
import { assertAgentLogTaskId as assertAgentLogTaskIdGate } from "../index.gate.js";
import type { TaskStore } from "../store.js";

/*
FNXC:AgentLogRead 2026-09-09-15:19:
RUFU-204 gave the task-bound `fn_task_logs_read` an explicit cross-task target, so a CALLER-SUPPLIED id now
reaches `store.taskDir()` — a bare `join(this.tasksDir, id)` — on every lane. `assertAgentLogTaskId` is the
one-safe-path-segment guard placed at the sole production callers of the log readers (getAgentLogsImpl and
getAgentLogCountImpl), so engine, chat, pi, dashboard-route, project-engine, evaluator, and report lanes all
pass through it. These tests lock that guard at the store-op seam itself: an id that cannot name a real card
directory must be refused BEFORE any path join or buffer flush, while ordinary non-canonical ids must resolve
exactly as they did before the guard existed. The guard is deliberately NOT the canonical `TASK_ID_PATTERN`.

FNXC:AgentLogRead 2026-09-09-18:51:
Plan Review (RUFU-204) flagged that the same two store ops also serve non-tool forensic callers that do not
wrap the call in a `try/catch` — `buildArchivedAgentLogFieldsImpl` (`task-id-integrity.ts`) reads
`store.getAgentLogs`/`getAgentLogCount` during an archive snapshot with DB-sourced ids. So the pass-through
half of these tests is load-bearing, not cosmetic: it pins that the rule stays structural (separators,
absolute prefixes, control bytes, `.`/`..`, length) rather than an allowlist, because tightening toward
`[A-Za-z0-9._-]` — let alone `TASK_ID_PATTERN` — would turn a legacy single-segment id into a throw on a
code path that has no error handling. Every accepted id must also reach `taskDir` UNCHANGED: a normalized or
rewritten id would silently read a different card's directory.
*/

const tempDirs: string[] = [];

function tasksRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-agent-log-guard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// A narrow store seam: only the two members the read impls touch. `taskDir` mirrors the real
// `join(tasksDir, id)`; the spies prove whether the guard stopped the call before the store was consulted.
function fakeStore(root = tasksRoot()) {
  const flushAgentLogBuffer = vi.fn();
  const taskDir = vi.fn((id: string) => join(root, id));
  const store = { flushAgentLogBuffer, taskDir } as unknown as TaskStore;
  return { store, flushAgentLogBuffer, taskDir };
}

const REJECTS = [
  { label: "empty string", id: "" },
  { label: "whitespace only", id: "   " },
  { label: "parent-directory traversal", id: "../secrets" },
  { label: "nested traversal", id: "a/b" },
  { label: "absolute path", id: "/etc/passwd" },
  { label: "current-directory marker", id: "." },
  { label: "parent-directory marker", id: ".." },
  { label: "backslash separator", id: "a\\b" },
  { label: "NUL byte", id: "FN\u0000-1" },
];

// Accepted ids are every shape a real card directory can hold. The set deliberately mixes the canonical
// `UPPER-DIGITS` form with the lowercase/hyphen/underscore/dot spellings used by fixtures and legacy rows,
// plus a space — the reviewer's named exposure — because the rule is "one safe path segment", so a legal
// filename character is never a refusal.
const ACCEPTS = [
  { label: "canonical-shaped id", id: "FN-8058" },
  { label: "non-numeric suffix", id: "FN-other" },
  { label: "lowercase with digits", id: "task-1" },
  { label: "multi-segment-hyphen uppercase", id: "FN-LOG-SINGLE" },
  { label: "underscore", id: "task_1" },
  { label: "embedded dot", id: "legacy.task" },
  { label: "leading dot that is not a marker", id: ".cache-task" },
  { label: "internal space (legal filename byte)", id: "legacy task 1" },
  { label: "max-length segment", id: "a".repeat(255) },
];

describe("assertAgentLogTaskId (single-safe-path-segment guard)", () => {
  /*
  FNXC:MergeGatePolicy 2026-09-14-07:55:
  RUFU-204 Code Review died mid-reasoning while checking exactly this: whether the barrel export added
  at `index.ts` has a mirror in `index.gate.ts`. That is load-bearing, not cosmetic — the `engine-core`
  merge-gate vitest project aliases `@fusion/core` to the gate bundle built from `index.gate.ts`, and
  `agent-tools.ts` calls this validator through its `import * as fusionCore from "@fusion/core"`
  namespace, so a gate-barrel omission makes `fn_task_logs_read` resolve `undefined` and TypeError in
  that lane. The barrel's own maintenance rule requires mirroring ordinary `index.ts` changes; the
  exclusion clause ("modules the gate genuinely never touches") cannot apply here because
  `task-artifacts-ops.ts` is inside the gate closure through the TaskStore wiring in `store.ts`. Same
  both-barrels pin as `file-scope-lease.test.ts` establishes.
  */
  it("is exposed from BOTH core barrels (index + index.gate stay in sync)", () => {
    expect(typeof assertAgentLogTaskIdGate).toBe("function");
    // Re-export of the same module instance → the same function, so both barrels cannot drift in behavior.
    expect(assertAgentLogTaskIdGate).toBe(assertAgentLogTaskId);
    expect(() => assertAgentLogTaskIdGate("../secrets")).toThrow(/invalid task id/);
    expect(() => assertAgentLogTaskIdGate("FN-8058")).not.toThrow();
  });

  it("refuses ids that cannot name a card directory", () => {
    for (const { label, id } of REJECTS) {
      expect(() => assertAgentLogTaskId(id), label).toThrow(/invalid task id/);
    }
  });

  it("accepts ordinary non-canonical ids that a card directory can legitimately hold", () => {
    for (const { label, id } of ACCEPTS) {
      expect(() => assertAgentLogTaskId(id), label).not.toThrow();
    }
  });

  it("refuses an id longer than the max segment length", () => {
    expect(() => assertAgentLogTaskId("a".repeat(256))).toThrow(/exceeds/);
  });
});

describe("getAgentLogsImpl / getAgentLogCountImpl consult the guard first", () => {
  for (const { label, id } of REJECTS) {
    it(`refuses a path-unsafe target (${label}) before any path join or buffer flush`, async () => {
      const { store, flushAgentLogBuffer, taskDir } = fakeStore();

      await expect(getAgentLogsImpl(store, id)).rejects.toThrow(/invalid task id/);
      await expect(getAgentLogCountImpl(store, id)).rejects.toThrow(/invalid task id/);

      // The store must never be reached: neither the buffer flush nor the path join runs.
      expect(flushAgentLogBuffer).not.toHaveBeenCalled();
      expect(taskDir).not.toHaveBeenCalled();
    });
  }

  // Non-canonical ids must survive the guard byte-for-byte: these are the ids the un-caught forensic
  // archive-snapshot path (`buildArchivedAgentLogFieldsImpl`) can carry from the DB, and an id that was
  // normalized or rejected there would break archiving instead of just reading an empty page.
  for (const { label, id } of ACCEPTS) {
    it(`passes a non-canonical id through unchanged (${label})`, async () => {
      const { store, flushAgentLogBuffer, taskDir } = fakeStore();

      const entries = await getAgentLogsImpl(store, id);
      const count = await getAgentLogCountImpl(store, id);

      expect(entries).toEqual([]); // an empty task dir reads as an honest empty page
      expect(count).toBe(0);
      expect(flushAgentLogBuffer).toHaveBeenCalled();
      // The exact requested id reaches the join — the guard validates, it never rewrites the target.
      expect(taskDir).toHaveBeenCalledWith(id);
      expect(taskDir.mock.calls[0]![0]).toBe(id);
    });
  }
});
