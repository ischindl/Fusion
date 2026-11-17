/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050) — the four-surface classification guard.

RUFU-1050's 136 cards are planning-lane rows whose continuation waits on planning while `task.status` is
NULL. Asking "is this retryable?" of that shape is exactly the question this repo has already been burned
by answering four times: the FNXC:WorkflowLifecycleColumns note in `task.ts` counts the copies of the retry
gate precisely because surfaces that each re-derive retryability end up answering ONE card differently —
and on this shape the two answers that came out were both wrong in opposite directions. `fn task retry`
refused ("is not in a retryable state (status: none)") while the board's Retry accepted the card and ran
the locked restart planner, which stamps `needs-replan`, empties `steps`, and DELETES `PROMPT.md`. The same
row, one press, either nothing or the destruction of the specification.

The fix is one core predicate (`classifyPlanningStrandedRetry`, which gained the unclaimed-admission leg)
consumed by all four transports. Core's own suite proves what the predicate decides; this scan proves the
part core cannot see — that every surface still ASKS it, and that none of them grew a private status test
next to the shared one. A local `task.status === ...` re-derivation typechecks, passes every behavioural
test written against the surface it lives on, and re-opens the divergence this task exists to close, so the
negative half is the point of the file.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// packages/cli/src/__tests__ -> repo root is four levels up; every path below stays repo-relative.
const REPO_ROOT = resolve(__dirname, "../../../..");

/** The four surfaces that can be told to retry a stranded card. */
const RETRY_SURFACES: Array<{ label: string; file: string; importRe: RegExp }> = [
  { label: "dashboard Retry route", file: "packages/dashboard/src/routes/register-task-workflow-routes.ts", importRe: /\bclassifyPlanningStrandedRetry\b/ },
  { label: "fn task retry (CLI)", file: "packages/cli/src/commands/task.ts", importRe: /\bclassifyPlanningStrandedRetry\b/ },
  { label: "agent task retry tool (pi extension)", file: "packages/cli/src/extension.ts", importRe: /classifyPlanningStrandedRetry/ },
  { label: "engine agent retry tool", file: "packages/engine/src/agent-tools.ts", importRe: /classifyPlanningStrandedRetry/ },
];

describe("RUFU-1050 — all four Retry surfaces ask core about the unclaimed shape", () => {
  for (const surface of RETRY_SURFACES) {
    it(`${surface.label} consumes the shared classification`, () => {
      const source = readFileSync(resolve(REPO_ROOT, surface.file), "utf8");
      expect(source, `${surface.file} must consult the shared classifier`).toMatch(surface.importRe);
      expect(source, `${surface.file} must apply its non-destructive patch`).toMatch(/buildPlanningStrandedRetryPatch/);
    });
  }

  it("none of them re-derives the unclaimed admission from a private status test", () => {
    /*
    The leg core added reads the episode the owning pass wrote, never the bare status, because `status:
    null` in a planning lane is also what a HEALTHY waiting card looks like. A surface that shortcuts to
    `status === null` would let one Retry re-plan every freshly-triaged card on the board. The literal
    below is the shape that shortcut takes in this codebase.
    */
    for (const surface of RETRY_SURFACES) {
      const source = readFileSync(resolve(REPO_ROOT, surface.file), "utf8");
      expect(source, `${surface.file} must not test the raw status for this class`).not.toMatch(
        /status\s*===?\s*null[\s\S]{0,160}(planning|unclaimed)/i,
      );
    }
  });

  it("the unclaimed register lives in core, where the shared Retry patch can name it", () => {
    /*
    The episode key was authored in the engine first, and that placement made it invisible to
    `buildManualRetryResetPatch`: core cannot import the engine, so the operator's Retry could not clear the
    counter the owning pass bounds itself by, and the pass would keep refusing a card the operator had just
    released (RUFU-395's "a Retry that leaves the register behind is not an exit"). The constant is declared
    in core's task-core and re-exported by the engine; this pins the direction of that dependency so a
    future refactor cannot quietly move it back to the engine side and un-make the Retry door.
    */
    const coreTypes = readFileSync(resolve(REPO_ROOT, "packages/core/src/types/task/task-core.ts"), "utf8");
    expect(coreTypes).toMatch(/export const UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY\s*=\s*"unclaimedGraphWork"/);
    const retryPatch = readFileSync(resolve(REPO_ROOT, "packages/core/src/tasks/manual-retry-reset.ts"), "utf8");
    expect(retryPatch).toMatch(/UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY\]:\s*null/);
    const engineSeam = readFileSync(resolve(REPO_ROOT, "packages/engine/src/workflows/unclaimed-graph-work.ts"), "utf8");
    expect(engineSeam, "the engine must re-export core's key, not re-declare a second spelling").not.toMatch(
      /export const UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY\s*=/,
    );
  });
});
