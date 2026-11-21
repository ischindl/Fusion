/*
FNXC:WipAdmissionHeldReason 2026-11-20-23:00 (RUFU-758):
The hold/release sweep reports one reason per refused candidate, and until this card that reason was a
constant: the branch handling `issueRelease`'s refusal threw the returned rejection code away and wrote
"move-rejected-or-no-slot" for every one of them. The sentence that string carries — "a slot was found but
the move was refused" — is FALSE for a card refused by its own plan-premise contract, because that door sits
in `issueRelease`'s `targetIsProcessing` arm and runs BEFORE any reservation is taken. RUFU-757's two red
cases read as "the capacity sweep releases nothing while live_exec=0" precisely because of that: the release
call had refused the card, and the sweep reported it as a capacity failure.

These tests run the SWEEP (`runHoldReleaseSweep`), not `issueRelease` directly, because the defect lived in
what the sweep REPORTS rather than what the release call returns: calling `issueRelease` and asserting its
`rejection` was already green before this fix and would stay green after it. The assertion that encodes the
bug is the reason the sweep publishes, taken from `result.held` — the value the summary line interpolates,
the held-since clock keys on, and the publication loop at the end of the pass turns into the card's badge,
History line and durable episode. Testing `held[0].reason` was therefore correct; testing the rejection code
instead of the reason was not.

A fact that changes how any future test here must be written: the published held reason is resolved through
an explicit refusal-to-gate map, and an unmapped reason returns BEFORE any write. Forwarding a refusal code
without giving it a gate would have made the card explain itself LESS than it does today, so the map is
total by construction (`Record<WipAdmissionRejection, TaskWipAdmissionStallCode>`) and the exhaustiveness
test below is its runtime witness.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import {
  WIP_ADMISSION_STALL_METADATA_KEY,
  WIP_ADMISSION_MOVE_REFUSED_STALL_REASON,
  WIP_ADMISSION_PLAN_PREMISE_STALL_REASON,
  deriveTaskStallReason,
  isWipAdmissionStallCode,
  type TaskWipAdmissionStallCode,
} from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation, type WipAdmissionRejection } from "../execution/hold-release.js";
import {
  wipAdmissionGateHasInLaneRemedy,
  wipAdmissionParkCodeForHeldReason,
} from "../execution/wip-admission-park.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:held-reason-wf";

/** A planned prompt stating no premises is vacuously satisfied — the baseline card the gates let through. */
const PLANNED_PROMPT = "# Planned\n\n## Mission\nImplement the approved work.\n";

/*
A premise bullet whose JSON names a kind the contract does not allow. The checker refuses the CONTRACT
before it ever resolves a git identity, so this shape reproduces `plan-premise-invalid` with no repository
on disk — the malformed-verbatim case the RUFU-246 ladder already narrates, seen here from the sweep.
*/
const MALFORMED_PREMISE_PROMPT = '# Planned\n\n## Mission\nDo the work.\n\n## Plan Premises\n\n- {"kind":"shell","path":"App.tsx"}\n\n## Steps\n';

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    columnMovedAt: "2026-11-02T00:00:00.000Z",
    prompt: PLANNED_PROMPT,
    ...over,
  } as Task;
}

/** The Coding shape: one capacity hold releasing into one WIP-limited column, with room by default. */
const ir = {
  version: "v2",
  id: WF,
  name: "held-reason",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

interface Harness {
  store: TaskStore;
  /** Every episode patch the sweep published, in write order. */
  markerPatches: Array<Record<string, unknown>>;
  history: string[];
  moveTaskIf: ReturnType<typeof vi.fn>;
  reserveSlot: ReturnType<typeof vi.fn>;
}

/**
 * The sweep's whole store surface. `updateTask` applies a key-level `sourceMetadataPatch` the way the real
 * store does — a fake that dropped what the recorder wrote made every pass look like a first refusal — and
 * `updateTaskAtomic` applies the mutate callback so the plan-premise ladder's own episode really persists.
 *
 * `getTasksDir` is deliberately NOT implemented: without it the premise checker falls back to `task.prompt`
 * and `evaluateUnplannedForExecution` treats the card as planned, so a test sets the plan document by
 * setting `prompt` and the premise gate is the only readiness door left standing.
 */
function harness(tasks: Task[], opts: { moves?: boolean; settings?: Record<string, unknown> } = {}): Harness {
  const moves = opts.moves ?? true;
  const settings = opts.settings ?? { maxConcurrent: 3 };
  const selection = { workflowId: WF, stepIds: [] };
  const markerPatches: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  const moveTaskIf = vi.fn(async (id: string, column: string) => {
    const cur = tasks.find((t) => t.id === id)!;
    if (moves) cur.column = column;
    return { task: cur, moved: moves };
  });
  const reserveSlot = vi.fn(() => ({ release: vi.fn() }));
  const store = {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    moveTaskIf,
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const cur = tasks.find((t) => t.id === id);
      const meta = patch.sourceMetadataPatch;
      if (cur && meta && typeof meta === "object") {
        cur.sourceMetadata = { ...(cur.sourceMetadata ?? {}), ...(meta as Record<string, unknown>) };
        if (WIP_ADMISSION_STALL_METADATA_KEY in (meta as object)) markerPatches.push(meta as Record<string, unknown>);
      }
      return cur ?? undefined;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => unknown) => {
      const cur = tasks.find((t) => t.id === _id)!;
      const patch = await mutate(cur);
      if (patch) {
        const { sourceMetadataPatch, ...rest } = patch as Record<string, unknown> & { sourceMetadataPatch?: Record<string, unknown> };
        if (sourceMetadataPatch) cur.sourceMetadata = { ...(cur.sourceMetadata ?? {}), ...sourceMetadataPatch };
        Object.assign(cur, rest);
      }
      return cur;
    }),
    logEntryOnce: vi.fn(async (_id: string, entry: { action: string }) => {
      history.push(entry.action);
      return true;
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      history.push(action);
    }),
    getTaskDocument: vi.fn(async () => null),
    upsertTaskDocument: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
  return { store, markerPatches, history, moveTaskIf, reserveSlot };
}

const now = () => Date.parse("2026-11-02T00:00:00.000Z");

/** The LAST episode the sweep published — what a reader of the row would find. */
function episodeOf(h: Harness): Record<string, unknown> | undefined {
  for (const patch of [...h.markerPatches].reverse()) {
    const value = patch[WIP_ADMISSION_STALL_METADATA_KEY];
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  return undefined;
}

describe("hold/release sweep reports the refusal identity it was actually given", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  /*
  The load-bearing case, and the one RUFU-757's card actually hit. A malformed plan-premise contract refuses
  the crossing; the sweep must say WHICH door refused it. Note what the sweep never does here: no slot is
  reserved and no move is attempted, because the premise door sits ahead of both. That is precisely why
  "a slot was found but the move was refused" is not a paraphrase of this refusal but a contradiction of it.
  */
  it("names plan-premise-invalid when the card's own premise contract refuses the crossing", async () => {
    const contender = task({ id: "PREMISED", prompt: MALFORMED_PREMISE_PROMPT });
    const h = harness([contender]);

    const result = await runHoldReleaseSweep(h.store, { now });

    // The verbatim refusal code, not a collapse onto a code the release call never returned.
    expect(result.held).toContainEqual({ taskId: "PREMISED", reason: "plan-premise-invalid" });
    // …and the gate the publication loop resolved from it.
    const episode = episodeOf(h);
    expect(episode).toMatchObject({
      code: "plan-premise-unmet",
      fromColumn: "todo",
      toColumn: "in-progress",
      stallCount: 1,
    });
    // The capacity pool WAS consulted before the release call and demonstrably did not refuse: the
    // forensics on the episode are the proof, so a reader can see the column had room while the card was
    // being refused. That is the measurement that makes the old label refutable from the row alone.
    expect(Number(episode?.limit)).toBeGreaterThan(Number(episode?.occupants));
    // The card explains itself on its own face, and names the premise gate as the refusing authority.
    const history = h.history.join("\n");
    expect(history).toContain("gate: plan-premise-unmet");
    expect(history).not.toContain("downstream-full");
    // Nothing was reserved or moved: the refusal happened ahead of both.
    expect(h.reserveSlot).not.toHaveBeenCalled();
    expect(h.moveTaskIf).not.toHaveBeenCalled();
    expect(contender.column).toBe("todo");
  });

  /*
  A plan document that cannot be read is a different fact from a malformed one and must not be flattened into
  it: RUFU-246 deliberately keeps `unavailable` retryable with NO escalation episode, so no other surface
  narrates this card. Before this fix its only explanation was a capacity sentence; now the park marker is
  the whole record, which is why the History assertion matters more here than anywhere else in this file.
  */
  it("names plan-premise-unavailable when the authoritative plan cannot be read", async () => {
    const contender = task({ id: "UNREADABLE", prompt: undefined });
    const h = harness([contender]);

    const result = await runHoldReleaseSweep(h.store, { now });

    expect(result.held).toContainEqual({ taskId: "UNREADABLE", reason: "plan-premise-unavailable" });
    expect(episodeOf(h)).toMatchObject({ code: "plan-premise-unmet" });
    expect(h.history.join("\n")).toContain("plan-premise-unmet");
    expect(h.reserveSlot).not.toHaveBeenCalled();
  });

  /*
  The codeless refusals keep today's label UNCHANGED, and that is a requirement rather than an accident: a
  slot really was sought and the in-transaction move really refused, which is exactly what the string says.
  Asserting the fallback still fires is what stops this fix from being a blanket replacement of the literal.
  */
  it("keeps move-rejected-or-no-slot for a refusal that carries no code at all", async () => {
    const contender = task({ id: "READY" });
    // The lane reads below its limit, so the sweep's own count says "room"; the store still refuses.
    const h = harness([contender], { moves: false });

    const result = await runHoldReleaseSweep(h.store, { now });

    expect(result.held).toContainEqual({ taskId: "READY", reason: "move-rejected-or-no-slot" });
    expect(episodeOf(h)).toMatchObject({ code: "move-rejected-or-no-slot" });
    // The move was genuinely attempted here — the label's premise holds.
    expect(h.moveTaskIf).toHaveBeenCalled();
    expect(contender.column).toBe("todo");
  });

  /*
  A card skipped before the release call reports NOTHING, so a published reason always belongs to a card the
  sweep actually refused. A pause is the skip: `sweepSkipsCardBeforeIrResolution` answers before any IR read,
  so the card never reaches a held entry and the publication loop has nothing to publish.
  */
  it("publishes nothing for a card it skipped rather than refused", async () => {
    const paused = task({ id: "HELD-BY-HUMAN", paused: true });
    const h = harness([paused]);

    const result = await runHoldReleaseSweep(h.store, { now });

    expect(result.held).toEqual([]);
    expect(h.markerPatches).toEqual([]);
    expect(h.history).toEqual([]);
  });
});

describe("every refusal the sweep can be given resolves to a gate", () => {
  /*
  Total, and stated as a literal list rather than derived, so the pair (this list, the union) fails loudly in
  both directions: a refusal added to `WipAdmissionRejection` and forgotten here trips the type annotation
  below, and a gate mapped for a refusal that no longer exists trips the runtime loop. Both halves are needed
  because an unmapped refusal is not a crash — `publishWipAdmissionHold` returns before writing anything, so
  a card that explains itself today would explain itself nothing at all tomorrow.
  */
  const REJECTIONS: Record<WipAdmissionRejection, true> = {
    "unplanned-for-execution": true,
    "plan-premise-stale": true,
    "plan-premise-invalid": true,
    "plan-premise-unavailable": true,
    "plan-premise-exhausted": true,
    "capacity-exhausted-or-no-slot": true,
    "source-changed": true,
  };

  it.each(Object.keys(REJECTIONS) as WipAdmissionRejection[])(
    "%s resolves to a gate in the closed vocabulary",
    (rejection) => {
      const code = wipAdmissionParkCodeForHeldReason(rejection);
      expect(code).toBeDefined();
      expect(isWipAdmissionStallCode(code)).toBe(true);
    },
  );

  it("resolves the plan-premise family onto its own gate and not onto the capacity label", () => {
    for (const rejection of ["plan-premise-stale", "plan-premise-invalid", "plan-premise-unavailable", "plan-premise-exhausted", "source-changed"] as const) {
      expect(wipAdmissionParkCodeForHeldReason(rejection)).toBe("plan-premise-unmet");
    }
    // The two mappings that are decisions rather than translations, pinned so a future edit cannot undo them.
    expect(wipAdmissionParkCodeForHeldReason("unplanned-for-execution")).toBe("awaiting-planning");
    expect(wipAdmissionParkCodeForHeldReason("capacity-exhausted-or-no-slot")).toBe("move-rejected-or-no-slot");
  });

  /*
  The premise gate is NOT an in-lane-remedy gate: a card whose premises refuse it has nothing left to run in
  its own column, so a dispatch deferral is the honest answer. The gate was deliberately kept out of
  `WIP_ADMISSION_GATES_WITH_IN_LANE_REMEDY`; this is the assertion that makes that visible, and the two
  listed gates stay the ONLY ones with an in-lane remedy.
  */
  it("defers graph entry for the premise gate while the two resting gates keep their remedy", () => {
    expect(wipAdmissionGateHasInLaneRemedy("plan-premise-unmet")).toBe(false);
    expect(wipAdmissionGateHasInLaneRemedy("awaiting-planning")).toBe(true);
    expect(wipAdmissionGateHasInLaneRemedy("awaiting-approval")).toBe(true);
  });

  /*
  The badge text is the whole point of RUFU-758: an operator must not be sent to a WIP limit that is not
  binding. Checked through `deriveTaskStallReason` under the ONE wire code the family shares, so the claim is
  about what a surface renders and not about an internal table. The episode is aged past the escalation floor
  on purpose - under it a park is ordinary scheduling and writes no badge, and a test that skipped the floor
  would pass while the real card carried the capacity sentence for an hour first.
  */
  it("renders a non-capacity sentence for a premise episode under the shared wire code", async () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const stalled = {
      id: "RUFU-758",
      column: "todo",
      status: undefined,
      paused: false,
      sourceMetadata: {
        wipAdmissionStall: {
          code: "plan-premise-unmet" satisfies TaskWipAdmissionStallCode,
          signature: "capacity|todo->in-progress",
          nodeId: "hold-release-sweep",
          fromColumn: "todo",
          toColumn: "in-progress",
          firstAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          lastAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          stallCount: 1,
        },
      },
    } as unknown as Task;

    const derived = await deriveTaskStallReason(stalled, { now });

    expect(derived?.code).toBe("wip-admission-throttled");
    expect(derived?.reason).toBe(WIP_ADMISSION_PLAN_PREMISE_STALL_REASON);
    for (const wrong of ["slot", "capacity", "move"]) {
      expect(derived?.reason.toLowerCase()).not.toContain(wrong);
    }
    // The capacity sentence is still what a capacity episode renders — the two are not interchangeable.
    expect(WIP_ADMISSION_MOVE_REFUSED_STALL_REASON.toLowerCase()).toContain("slot");
  });
});
