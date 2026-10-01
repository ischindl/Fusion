import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RUFU-279 ships three `memory:long-term-*` run-audit events. This contract test keeps the three
 * artifacts — the union in `run-audit.ts`, the prose in `docs/run-audit.md`, and the curated delivery
 * catalogue — from drifting apart, and pins the one place where this change deliberately does NOT
 * follow the curated-event convention.
 */

const EVENTS = [
  "memory:long-term-over-budget",
  "memory:long-term-consolidated",
  "memory:long-term-consolidation-failed",
] as const;

const read = (relative: string) => readFile(join(process.cwd(), ...relative.split("/")), "utf8");

describe("memory:long-term-* audit contract", () => {
  it("declares every event in the run-audit event union", async () => {
    const source = await read("src/util/run-audit.ts");
    for (const event of EVENTS) {
      expect(source, `${event} must be a declared DatabaseMutationType`).toContain(`"memory:`);
      expect(source).toContain(`"${event}"`);
    }
  });

  it("documents every event in docs/run-audit.md", async () => {
    const doc = await read("../../docs/run-audit.md");
    for (const event of EVENTS) {
      expect(doc, `${event} must be documented`).toContain(event);
    }
  });

  it("keeps the events out of the curated delivery-pipeline catalogue", async () => {
    /*
     * The curated catalogue in `src/run-audit/run-audit-catalogue.ts` is locked to a table in
     * `docs/run-audit.md` by `run-audit-catalogue.test.ts`. That catalogue describes the *delivery
     * pipeline* (what a human clicks through), while these rows are maintenance telemetry with no
     * delivery surface, so adding them there would demand a table row the other test then enforces.
     * Recording the exclusion is what stops a later reader from "finishing" the registration and
     * breaking the lock-step from the other side.
     */
    const catalogue = await read("src/run-audit/run-audit-catalogue.ts");
    for (const event of EVENTS) {
      expect(catalogue).not.toContain(event);
    }
  });

  it("emits through the bounded audit seam, never a direct store write", async () => {
    /*
     * FN-9175/FN-9177 make a direct `recordRunAuditEvent` call an engine anti-pattern, and the rule
     * matters extra here: the thing this telemetry observes is the only path that keeps durable memory
     * from growing without bound, so an absent, throwing, or hanging sink must not be able to stop it.
     * Asserted as a code construct (which seam the emitters may touch), not as prose in a comment.
     */
    const consolidation = await read("src/memory/long-term-consolidation.ts");
    const selfHealing = await read("src/self-healing.ts");
    for (const source of [consolidation, selfHealing]) {
      expect(source).not.toMatch(/\.recordRunAuditEvent\(/);
    }
    expect(selfHealing).toMatch(/audit: \(mutationType, payload\) => emitBoundedRunAudit\(this\.store,/);
    expect(selfHealing).toContain("runLongTermMemoryMaintenance");
  });
});
