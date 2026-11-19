/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
`fn task lock-census` is the only board surface that answers "which live cards can never be
plan-approved, and why?". These fixtures are the exact shapes measured at filing: a 4.5 KB spec with no
`## Mission` (RUFU-424, parked twice, invisible in `fn task list`), the intentional `DUPLICATE: <ID>`
redirect sentinel (RUFU-309), and a lockable control. The census must name the missing section, the
heading to write, the file, and the owner — and must NOT let ten intentional sentinels bury the one
card that is actually stuck.
*/
import { describe, expect, it } from "vitest";

import {
  buildSpecLockCensusRows,
  formatSpecLockCensusRows,
  isLockCensusActionable,
  selectSpecLockCensusTasks,
  type LockCensusRow,
  type LockCensusTask,
} from "../commands/task.js";

const MISSION_LESS_SPEC = `# Task: RUFU-424 - A card whose spec has no mission

## File Scope

- packages/engine/src/triage.ts

## Steps

### Step 0: Preflight

- Verify the live inputs

## Completion Criteria

- [ ] The card is approvable
`;

const LOCKABLE_SPEC = MISSION_LESS_SPEC.replace(
  "## File Scope",
  "## Mission\n\nName the cause of an unavailable spec lock.\n\n## File Scope",
);

/** The redirect sentinel an intentional duplicate park carries as its whole spec (RUFU-309 measured 20 bytes). */
const DUPLICATE_SENTINEL = "DUPLICATE: RUFU-312";

function card(id: string, overrides: Partial<LockCensusTask> = {}): LockCensusTask {
  return {
    id,
    dependencies: [],
    missionId: null,
    sliceId: null,
    sourceParentTaskId: null,
    ...overrides,
  } as LockCensusTask;
}

/** In-memory census deps: the spec text is a fixture, the path is derived the way the command derives it. */
function deps(specs: Record<string, string | null>) {
  return {
    readPrompt: async (task: LockCensusTask) => specs[task.id] ?? null,
    promptPath: (task: LockCensusTask) => `/repo/.fusion/tasks/${task.id}/PROMPT.md`,
  };
}

/** The exit code the command computes from its rows, asserted without spawning the CLI. */
function censusExitCode(rows: readonly LockCensusRow[]): number {
  return rows.some((row) => isLockCensusActionable(row)) ? 1 : 0;
}

describe("fn task lock-census (RUFU-535)", () => {
  it("reports nothing and exits 0 when every card locks", async () => {
    const rows = await buildSpecLockCensusRows([card("FN-1001")], deps({ "FN-1001": LOCKABLE_SPEC }));
    expect(rows).toEqual([]);
    expect(censusExitCode(rows)).toBe(0);
  });

  it("names the missing required section, the heading to write, the spec path, and the owner", async () => {
    const rows = await buildSpecLockCensusRows([card("FN-1002")], deps({ "FN-1002": MISSION_LESS_SPEC }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "FN-1002",
      disposition: "unapprovable",
      reason: "mission-missing",
      missingSection: "mission",
      expectedHeading: "## Mission",
      recoveryOwner: "planner-respec",
      path: "/repo/.fusion/tasks/FN-1002/PROMPT.md",
    });
    expect(rows[0]!.summary).toContain("## Mission");
    expect(rows[0]!.summary).toContain("/repo/.fusion/tasks/FN-1002/PROMPT.md");
    expect(censusExitCode(rows)).toBe(1);
  });

  it("classifies a DUPLICATE redirect sentinel as intentionally-inert and never trips the exit code", async () => {
    const rows = await buildSpecLockCensusRows([card("FN-1003")], deps({ "FN-1003": DUPLICATE_SENTINEL }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: "intentionally-inert", recoveryOwner: "none" });
    expect(isLockCensusActionable(rows[0]!)).toBe(false);
    expect(censusExitCode(rows)).toBe(0);
  });

  it("keeps ten intentional sentinels from burying the one card that really is stuck", async () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, index) => card(`FN-20${String(index).padStart(2, "0")}`)),
      card("FN-2100"),
    ];
    const specs: Record<string, string | null> = { "FN-2100": MISSION_LESS_SPEC };
    for (const task of tasks) if (!(task.id in specs)) specs[task.id] = DUPLICATE_SENTINEL;

    const rows = await buildSpecLockCensusRows(tasks, deps(specs));
    const actionable = rows.filter((row) => isLockCensusActionable(row));

    expect(rows).toHaveLength(11);
    expect(actionable).toHaveLength(1);
    expect(actionable[0]!.id).toBe("FN-2100");
    expect(censusExitCode(rows)).toBe(1);
  });

  it("hands a held card to the operator and an absent spec file to the operator too", async () => {
    const paused = await buildSpecLockCensusRows(
      [card("FN-1004", { userPaused: true, paused: true } as Partial<LockCensusTask>)],
      deps({ "FN-1004": MISSION_LESS_SPEC }),
    );
    expect(paused[0]).toMatchObject({ disposition: "unapprovable", recoveryOwner: "operator" });

    // The row's `prompt` field survives a deleted PROMPT.md, so only the disk read names this class.
    const fileMissing = await buildSpecLockCensusRows(
      [card("FN-1005", { prompt: MISSION_LESS_SPEC } as Partial<LockCensusTask>)],
      deps({}),
    );
    expect(fileMissing[0]).toMatchObject({ disposition: "prompt-file-missing", recoveryOwner: "operator" });
    expect(censusExitCode(paused)).toBe(1);
    expect(censusExitCode(fileMissing)).toBe(1);
  });

  it("prints one row per card with the contract's columns and excludes terminal cards from membership", async () => {
    const rows = await buildSpecLockCensusRows([card("FN-1006")], deps({ "FN-1006": MISSION_LESS_SPEC }));
    const lines = formatSpecLockCensusRows(rows, 3).join("\n");

    expect(lines).toContain("id | disposition | reason | missing section | expected heading | recovery owner | path");
    expect(lines).toContain("FN-1006 | unapprovable | mission-missing | mission | ## Mission | planner-respec | /repo/.fusion/tasks/FN-1006/PROMPT.md");
    expect(lines).toContain("Excluded 3 card(s) in a terminal lane.");

    // `--json` must stay machine-checkable: one object per card with exactly those fields.
    const parsed = JSON.parse(JSON.stringify(rows)) as LockCensusRow[];
    expect(parsed[0]).toHaveProperty("expectedHeading", "## Mission");
    expect(parsed[0]).toHaveProperty("recoveryOwner", "planner-respec");
  });

  it("excludes terminal-lane cards and fails OPEN when the lane vocabulary is unreadable", async () => {
    const store = {
      listWorkflowDefinitions: async () => [
        { ir: { columns: [{ id: "todo", intake: true }, { id: "done", complete: true }] } },
      ],
    } as unknown as Parameters<typeof selectSpecLockCensusTasks>[0];
    const tasks = [
      card("FN-1007", { column: "todo" } as Partial<LockCensusTask>),
      card("FN-1008", { column: "done" } as Partial<LockCensusTask>),
    ] as unknown as Parameters<typeof selectSpecLockCensusTasks>[1];

    const membership = await selectSpecLockCensusTasks(store, tasks);
    expect(membership.candidates.map((task) => task.id)).toEqual(["FN-1007"]);
    expect(membership.excludedTerminalCount).toBe(1);
    expect(membership.laneVocabularyDegraded).toBe(false);

    const degraded = await selectSpecLockCensusTasks(
      undefined as unknown as Parameters<typeof selectSpecLockCensusTasks>[0],
      tasks,
    );
    expect(degraded.candidates).toHaveLength(2);
    expect(degraded.excludedTerminalCount).toBe(0);
    expect(degraded.laneVocabularyDegraded).toBe(true);
  });
});
