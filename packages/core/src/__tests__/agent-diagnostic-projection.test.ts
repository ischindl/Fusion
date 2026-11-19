import { describe, expect, it } from "vitest";

import {
  collectAgentAssignedCards as collectAgentAssignedCardsSource,
  formatAgentDiagnosticLines as formatAgentDiagnosticLinesSource,
} from "../agents/agent-diagnostic-projection.js";
import {
  collectAgentAssignedCards,
  formatAgentAssignedCardLines,
  formatAgentAssignedCardsCompact,
  formatAgentDiagnosticLines,
  formatAgentErrorRecoveryLine,
  formatProjectAttributionLine,
  loadAgentPendingApprovalCounts,
  truncateAgentDiagnosticText,
  withAgentPendingApprovalCounts,
} from "../index.js";
import {
  collectAgentAssignedCards as collectAgentAssignedCardsGate,
  formatAgentAssignedCardLines as formatAgentAssignedCardLinesGate,
  formatAgentAssignedCardsCompact as formatAgentAssignedCardsCompactGate,
  formatAgentDiagnosticLines as formatAgentDiagnosticLinesGate,
  formatAgentErrorRecoveryLine as formatAgentErrorRecoveryLineGate,
  formatProjectAttributionLine as formatProjectAttributionLineGate,
  loadAgentPendingApprovalCounts as loadAgentPendingApprovalCountsGate,
  truncateAgentDiagnosticText as truncateAgentDiagnosticTextGate,
  withAgentPendingApprovalCounts as withAgentPendingApprovalCountsGate,
} from "../index.gate.js";

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
Both-barrels pin for the Node-side projection (same rule RUFU-204 established for
`assertAgentLogTaskId`): the merge-gate lane resolves `@fusion/core` through the gate bundle, so a
symbol exported only from `index.ts` reaches the engine's `fn_list_agents` as `undefined` while every
ordinary run passes. Identity assertions also prove the engine tool and the CLI format one agent row
with one implementation rather than two wordings.
*/

describe("agent diagnostic projection is exposed from BOTH core barrels", () => {
  it("every new symbol is a function on both barrels and the same object on each", () => {
    for (const [name, gate, plain] of [
      ["formatAgentDiagnosticLines", formatAgentDiagnosticLinesGate, formatAgentDiagnosticLines],
      ["formatAgentErrorRecoveryLine", formatAgentErrorRecoveryLineGate, formatAgentErrorRecoveryLine],
      ["truncateAgentDiagnosticText", truncateAgentDiagnosticTextGate, truncateAgentDiagnosticText],
      ["loadAgentPendingApprovalCounts", loadAgentPendingApprovalCountsGate, loadAgentPendingApprovalCounts],
      ["withAgentPendingApprovalCounts", withAgentPendingApprovalCountsGate, withAgentPendingApprovalCounts],
      ["collectAgentAssignedCards", collectAgentAssignedCardsGate, collectAgentAssignedCards],
      ["formatAgentAssignedCardLines", formatAgentAssignedCardLinesGate, formatAgentAssignedCardLines],
      ["formatAgentAssignedCardsCompact", formatAgentAssignedCardsCompactGate, formatAgentAssignedCardsCompact],
      ["formatProjectAttributionLine", formatProjectAttributionLineGate, formatProjectAttributionLine],
    ] as const) {
      expect(typeof plain, name).toBe("function");
      expect(gate, name).toBe(plain);
    }
    expect(formatAgentDiagnosticLinesGate).toBe(formatAgentDiagnosticLinesSource);
    expect(collectAgentAssignedCardsGate).toBe(collectAgentAssignedCardsSource);
  });

  it("renders the three honest stall cases identically through the gate barrel", () => {
    expect(formatAgentDiagnosticLinesGate({ state: "paused", pauseReason: "error-unrecoverable" }, { compact: true }))
      .toEqual(["Pause Reason: error-unrecoverable — Paused with an unrecoverable error"]);
    expect(formatAgentDiagnosticLinesGate({ state: "paused", pauseReason: "error-retry-exhausted" }, { compact: true }))
      .toEqual(["Pause Reason: error-retry-exhausted — Automatic retries exhausted"]);
    // The blank-reason case must still print a line through the gate barrel — silently printing
    // nothing here is the exact defect RUFU-247 removes.
    expect(formatAgentDiagnosticLinesGate({ state: "paused" }, { compact: true }))
      .toEqual(["Pause Reason: unknown — no pause reason recorded (inspect agent logs/runlog)"]);
    expect(formatAgentDiagnosticLinesGate({ state: "active" }, { compact: true })).toEqual([]);
  });

  it("behaves through the gate barrel for the store-backed reads", async () => {
    expect(await loadAgentPendingApprovalCountsGate({ getAsyncLayer: () => null } as never, ["a"]))
      .toEqual(new Map([["a", 0]]));
    const enriched = await withAgentPendingApprovalCountsGate([{ id: "a" }], { getAsyncLayer: () => null } as never);
    expect(enriched[0]!.pendingApprovalCount).toBe(0);
    const inventory = await collectAgentAssignedCardsGate("agent-x", {
      store: {
        getTasksByAssignedAgent: async () => [],
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      } as never,
    });
    expect(inventory.cards).toEqual([]);
    expect(formatAgentAssignedCardsCompactGate(inventory)).toBeNull();
    expect(formatAgentAssignedCardLinesGate(inventory)).toEqual([]);
    expect(formatProjectAttributionLineGate({ projectId: "p-9", projectName: "N" })).toBe("Project: N (p-9)");
  });
});
