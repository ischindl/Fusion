/*
FNXC:PlanningLaneWorktreeIdentity 2026-11-18-18:05 (RUFU-893):
This file is the ONLY suite that exercises `decidePlanningLaneWorktree`, by design: the rule has no I/O,
so a table over its inputs covers it completely, and the sweep-level suite
(`__tests__/reliability-interactions/worktree-metadata-planning-lane-identity.test.ts`) asserts wiring —
which probes ran, which event fired, which fields were written — never this table again.

The contract the table pins, in the order the rule reads it:
1. `unknown` never becomes `absent`. A probe that could not be asked must refuse, and it must refuse with
   `probe-unknown`, because RUFU-548 measured exactly this collapse stranding 16 cards and RUFU-803 then
   mislabelled the survivors as landed.
2. `clear` happens on PROOF only — the ref is absent, or a present ref's tip is contained in the
   integration branch — and each clear names its own basis so a log can never claim a git verdict that
   was not asked.
3. A live registered worktree is `keep`, not a refusal and not a clear: the pointer's premise is alive.
4. Every refusal code is reachable from a named input combination, and the authority vetoes outrank the
   git verdicts, so a held card cannot be talked into a clear by an absent ref.
5. The action union has exactly three members. There is no delete: this rule can null three task fields
   or touch nothing, and the only removal owner in this area stays
   `worktree-acquisition.recreateMissingTaskWorktree`, which rebuilds rather than removes.
*/
import { describe, expect, it } from "vitest";
import {
  decidePlanningLaneWorktree,
  type PlanningLanePointerObservations,
} from "../planning-lane-worktree-identity.js";

/** A card an honest `clear` is available for: planning lane, no ref, no registration, nothing on disk. */
function obs(overrides: Partial<PlanningLanePointerObservations> = {}): PlanningLanePointerObservations {
  return {
    laneClass: "planning",
    refPresence: "absent",
    registration: "absent",
    containment: "not-applicable",
    persistedPathPresent: false,
    persistedPathIsManaged: true,
    heldOrLive: false,
    workspaceCard: false,
    operatorSuppliedBranch: false,
    ...overrides,
  };
}

describe("decidePlanningLaneWorktree", () => {
  describe("clear requires a proof git actually gave", () => {
    it("clears when no ref exists in any namespace", () => {
      expect(decidePlanningLaneWorktree(obs())).toEqual({ action: "clear", basis: "git-ref-absent" });
    });

    it("clears when the present ref's tip is contained in the integration branch", () => {
      expect(
        decidePlanningLaneWorktree(obs({ refPresence: "present", containment: "contained" })),
      ).toEqual({ action: "clear", basis: "git-ref-contained" });
    });

    it("never clears a present ref on the directory evidence alone", () => {
      // The pre-change sweep cleared on exactly this shape: the persisted path is gone and nothing is
      // registered. With a divergent ref that clear deletes the board's only link to the commits.
      expect(
        decidePlanningLaneWorktree(obs({
          refPresence: "present",
          containment: "divergent",
          persistedPathPresent: false,
          persistedPathIsManaged: false,
        })),
      ).toEqual({ action: "refuse", code: "ref-divergent" });
    });
  });

  describe("unknown is never absence", () => {
    it("refuses an unreadable ref probe instead of reading it as no commits", () => {
      expect(decidePlanningLaneWorktree(obs({ refPresence: "unknown" })))
        .toEqual({ action: "refuse", code: "probe-unknown" });
    });

    it("refuses an unreadable registration read instead of reading it as not registered", () => {
      // `describeRegisteredWorktrees` swallows its own failure into an empty inventory, which is why the
      // sweep must hand this rule `unknown` and not an empty map.
      expect(decidePlanningLaneWorktree(obs({ registration: "unknown" })))
        .toEqual({ action: "refuse", code: "probe-unknown" });
    });

    it("refuses a present ref whose containment probe never answered", () => {
      expect(decidePlanningLaneWorktree(obs({ refPresence: "present", containment: "unknown" })))
        .toEqual({ action: "refuse", code: "probe-unknown" });
    });

    it("treats a carried not-applicable containment beside a present ref as unasked, never as contained", () => {
      expect(decidePlanningLaneWorktree(obs({ refPresence: "present", containment: "not-applicable" })))
        .toEqual({ action: "refuse", code: "probe-unknown" });
    });

    it("refuses when both probes are unreadable, on the ref read alone", () => {
      expect(decidePlanningLaneWorktree(obs({ refPresence: "unknown", registration: "unknown" })))
        .toEqual({ action: "refuse", code: "probe-unknown" });
    });
  });

  describe("a live checkout is kept, not cleared and not refused", () => {
    it("keeps when a registered worktree names this branch, even with the persisted path gone", () => {
      const decision = decidePlanningLaneWorktree(obs({
        refPresence: "present",
        registration: "registered",
        containment: "divergent",
      }));
      expect(decision.action).toBe("keep");
      expect(decision.code).toBeUndefined();
      expect(decision.basis).toBeUndefined();
    });

    it("keeps ahead of an absent ref, because the registration outranks the ref read", () => {
      // The pre-change sweep cleared this shape (ref absent, nothing at the path). With a live checkout
      // on the branch the clear would drop the pointer to a working directory that still exists in git.
      expect(decidePlanningLaneWorktree(obs({ registration: "registered" }))).toEqual({ action: "keep" });
    });
  });

  describe("each refusal code is reachable from a named input", () => {
    it("refuses an unrecognised lane rather than guessing its owner", () => {
      expect(decidePlanningLaneWorktree(obs({ laneClass: "unrecognised" })))
        .toEqual({ action: "refuse", code: "lane-vocabulary-unreadable" });
    });

    it("refuses a present directory that is not the managed per-id path", () => {
      expect(decidePlanningLaneWorktree(obs({ persistedPathPresent: true, persistedPathIsManaged: false })))
        .toEqual({ action: "refuse", code: "unmanaged-path-present" });
    });

    it("clears a stale managed per-id path that is simply gone", () => {
      expect(decidePlanningLaneWorktree(obs({ persistedPathPresent: false, persistedPathIsManaged: true })))
        .toEqual({ action: "clear", basis: "git-ref-absent" });
    });

    it("refuses a workspace card, whose pointers live in member repositories", () => {
      expect(decidePlanningLaneWorktree(obs({ workspaceCard: true })))
        .toEqual({ action: "refuse", code: "workspace-card" });
    });

    it("refuses an operator-supplied branch this sweep never acquired", () => {
      expect(decidePlanningLaneWorktree(obs({ operatorSuppliedBranch: true })))
        .toEqual({ action: "refuse", code: "operator-branch" });
    });

    it("refuses a held or live card", () => {
      expect(decidePlanningLaneWorktree(obs({ heldOrLive: true })))
        .toEqual({ action: "refuse", code: "held-or-live" });
    });
  });

  describe("authority vetoes outrank the git verdict", () => {
    it("a user pause outranks an absent ref", () => {
      expect(decidePlanningLaneWorktree(obs({ heldOrLive: true, refPresence: "absent" })))
        .toEqual({ action: "refuse", code: "held-or-live" });
    });

    it("a workspace card outranks a divergent ref verdict", () => {
      expect(
        decidePlanningLaneWorktree(obs({ workspaceCard: true, refPresence: "present", containment: "divergent" })),
      ).toEqual({ action: "refuse", code: "workspace-card" });
    });

    it("an operator-supplied branch outranks an unmanaged present path", () => {
      expect(
        decidePlanningLaneWorktree(obs({
          operatorSuppliedBranch: true,
          persistedPathPresent: true,
          persistedPathIsManaged: false,
        })),
      ).toEqual({ action: "refuse", code: "operator-branch" });
    });

    it("an unrecognised lane outranks a probe refusal, so no probe is spent on a lane with no owner", () => {
      expect(decidePlanningLaneWorktree(obs({ laneClass: "unrecognised", refPresence: "unknown" })))
        .toEqual({ action: "refuse", code: "lane-vocabulary-unreadable" });
    });

    it("the live-checkout keep outranks the unmanaged-path refusal", () => {
      expect(
        decidePlanningLaneWorktree(obs({
          registration: "registered",
          persistedPathPresent: true,
          persistedPathIsManaged: false,
        })),
      ).toEqual({ action: "keep" });
    });
  });

  describe("the completion fan-out is a different authority and stays ungated", () => {
    it("clears a named card without consulting the probes", () => {
      // A squash-merged tip stays a non-ancestor of the integration branch forever, so applying the
      // containment gate here would refuse honest completions.
      expect(
        decidePlanningLaneWorktree(obs({
          laneClass: "completion-fanout-named",
          refPresence: "present",
          containment: "divergent",
          heldOrLive: true,
          workspaceCard: true,
        })),
      ).toEqual({ action: "clear", basis: "completion-fanout-named" });
    });
  });

  describe("the action vocabulary stays closed and carries no delete", () => {
    it("returns one of exactly three actions for a wide sweep of inputs", () => {
      const actions = new Set<string>();
      for (const laneClass of ["planning", "completion-fanout-named", "unrecognised"] as const) {
        for (const refPresence of ["present", "absent", "unknown"] as const) {
          for (const registration of ["registered", "absent", "unknown"] as const) {
            for (const containment of ["contained", "divergent", "unknown", "not-applicable"] as const) {
              for (const persistedPathPresent of [false, true]) {
                for (const persistedPathIsManaged of [false, true]) {
                  const decision = decidePlanningLaneWorktree(obs({
                    laneClass, refPresence, registration, containment, persistedPathPresent, persistedPathIsManaged,
                  }));
                  actions.add(decision.action);
                  expect(["clear", "keep", "refuse"]).toContain(decision.action);
                }
              }
            }
          }
        }
      }
      expect([...actions].sort()).toEqual(["clear", "keep", "refuse"]);
    });

    it("every clear carries a basis and every refusal carries a code, on the same sweep", () => {
      for (const laneClass of ["planning", "completion-fanout-named", "unrecognised"] as const) {
        for (const refPresence of ["present", "absent", "unknown"] as const) {
          for (const registration of ["registered", "absent", "unknown"] as const) {
            for (const containment of ["contained", "divergent", "unknown", "not-applicable"] as const) {
              const decision = decidePlanningLaneWorktree(obs({ laneClass, refPresence, registration, containment }));
              if (decision.action === "clear") expect(decision.basis).toBeTruthy();
              if (decision.action === "refuse") expect(decision.code).toBeTruthy();
              if (decision.action === "keep") {
                expect(decision.code).toBeUndefined();
                expect(decision.basis).toBeUndefined();
              }
            }
          }
        }
      }
    });
  });
});
