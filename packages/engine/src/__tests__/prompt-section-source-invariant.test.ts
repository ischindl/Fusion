/**
 * RUFU-597 — the section-source invariant.
 *
 * A named prompt section is composed of exactly one declared source. Whatever a consumer uses to
 * find a section's extent — a model reading flattened prompt text, or `compactPromptMemory`'s
 * regex in `pi.ts` (span = heading body to the next `#`/`##` heading or END-OF-STRING) — must never
 * capture bytes that belong to a different artifact. The incident that motivated this file:
 * agent-3ac88b82's 2026-10-07 wake showed another card's (RUFU-474) description text at the END of
 * the `## Agent Memory` section while that agent's MEMORY.md contained none of it. The 2026-10-07
 * composition (pre-RUFU-267) could not produce that shape, but the CURRENT request-tail composition
 * could whenever a slot block lacks its own heading (the executor column-agent persona and the
 * step-session identity line both rendered headingless). These tests pin the sentinel methodology
 * across every prompt-composing surface so the bleed class stays closed.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  buildRequestVolatileContext,
  appendRequestVolatileContext,
  withSectionHeading,
  SESSION_CONTEXT_HEADING,
} from "../execution/prompt-layers.js";
import { __testOnlyPromptCompaction } from "../pi.js";
import { workflowStepTaskIdentityLine } from "../execution/step-session-executor.js";
import { resolveAgentInstructionParts } from "../agents/agent-instructions.js";
import { buildIdlePreflightRequest } from "../heartbeat-idle-preflight.js";
import type { Agent } from "@fusion/core";

/* Distinct sentinels, one per artifact, so containment is unambiguous. */
const CARD_SENTINEL = "msg-d259a92b card-description tail sentinel";
const MEMORY_FILE_SENTINEL = "memory-file-77b1 sentinel body line";
const MEMORY_INLINE_SENTINEL = "memory-inline-4f02 sentinel body line";
const PERSONA_SENTINEL = "persona-9c31 column-agent soul body";

/**
 * The span rule every consumer applies, mirrored from `compactPromptMemory`'s pattern in pi.ts:
 * the body of `## <heading>` runs to the next line opening `# ` or `## ` or to end-of-string.
 * This is deliberately a mirror, not an import — if pi's boundary rule ever moves, the mirror
 * test fails and the two definitions are forced to re-agree in the same change.
 */
function sectionSpan(text: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n([\\s\\S]*?)(?=\\n#{1,2} [^#]|$)`);
  return pattern.exec(text)?.[1] ?? "";
}

describe("composition seam enforces section boundaries (RUFU-597)", () => {
  it("gives a headingless tail block the slot's declared heading instead of letting it fall into the previous section", () => {
    const ctx = buildRequestVolatileContext({
      memorySection: `## Agent Memory\n\n- ${MEMORY_FILE_SENTINEL}`,
      identitySection: PERSONA_SENTINEL,
    });

    // The persona opens its own section instead of sitting positionally inside the memory span.
    expect(ctx).toContain(`## Identity\n\n${PERSONA_SENTINEL}`);
    expect(sectionSpan(ctx, "Agent Memory")).not.toContain(PERSONA_SENTINEL);
    expect(sectionSpan(ctx, "Identity")).toContain(PERSONA_SENTINEL);
  });

  it("leaves compliant blocks byte-for-byte untouched", () => {
    const headed = "## Agent Memory\n\n- keep tests green";
    expect(withSectionHeading(headed, "## Agent Memory")).toBe(headed);
    const ctx = buildRequestVolatileContext({ memorySection: headed });
    expect(ctx).toBe(`${SESSION_CONTEXT_HEADING}\n\n${headed}`);
  });

  it("keeps the tail's own session-context section from swallowing the first block", () => {
    const ctx = buildRequestVolatileContext({ goalContext: "## Active Goals\n\n- ship RUFU-597" });
    expect(ctx.startsWith(SESSION_CONTEXT_HEADING)).toBe(true);
    expect(sectionSpan(ctx, "Active Goals")).toContain("ship RUFU-597");
  });

  it("normalizes each piece of a multi-piece slot so a trailing headingless piece cannot hide inside a headed sibling", () => {
    const ctx = buildRequestVolatileContext({
      policySections: ["## First Policy\n\nfirst", "trailing headingless policy"] as never,
    });
    expect(ctx).toContain("## Session Policy\n\ntrailing headingless policy");
  });

  it("accepts a level-1 opener as a section boundary and nests a ###-only block under the slot heading", () => {
    expect(withSectionHeading("# Real H1 boundary", "## Fallback")).toBe("# Real H1 boundary");
    const nested = withSectionHeading("### Sub only", "## Identity");
    expect(nested).toBe("## Identity\n\n### Sub only");
  });
});

describe("wake-prompt shapes: foreign card text never lands inside the memory span", () => {
  it("heartbeat execution prompt: card description stays in the Task description region, memory stays in its span", () => {
    // Mirror the heartbeat wake shape: headingless card region, then the composed volatile tail.
    const executionPrompt = [
      'Heartbeat execution for agent "Audit Executor" (ID: agent-3ac88b82)',
      "## Wake Delta",
      "- wake reason: assignment",
      "Task description:",
      `${CARD_SENTINEL}`,
    ].join("\n");
    const tail = buildRequestVolatileContext({
      memorySection: `## Agent Memory\n\n- ${MEMORY_FILE_SENTINEL}`,
    });
    const full = appendRequestVolatileContext(executionPrompt, tail);

    expect(full).toContain(CARD_SENTINEL);
    expect(sectionSpan(full, "Agent Memory")).toContain(MEMORY_FILE_SENTINEL);
    expect(sectionSpan(full, "Agent Memory")).not.toContain(CARD_SENTINEL);
  });

  it("executor tail: the headingless column-agent persona renders under ## Identity, never inside ## Agent Memory", () => {
    // The live current-code producer pair: persona bytes (agent-binding-pure buildAgentPersona)
    // arrive headingless; the seam must give them their own section.
    const ctx = buildRequestVolatileContext({
      memorySection: `## Agent Memory\n\n- ${MEMORY_FILE_SENTINEL}`,
      identitySection: PERSONA_SENTINEL,
      performanceFeedback: `## Performance Feedback\n\n- rating note`,
    });

    expect(sectionSpan(ctx, "Agent Memory")).not.toContain(PERSONA_SENTINEL);
    expect(sectionSpan(ctx, "Identity")).toContain(PERSONA_SENTINEL);
    expect(sectionSpan(ctx, "Performance Feedback")).toContain("rating note");
  });

  it("step-session tail: the per-card identity line never falls inside ## Agent Memory", () => {
    const ctx = buildRequestVolatileContext({
      identitySection: workflowStepTaskIdentityLine("FN-5970"),
      memorySection: `## Agent Memory\n\n- ${MEMORY_FILE_SENTINEL}`,
    });

    expect(sectionSpan(ctx, "Agent Memory")).not.toContain("FN-5970");
    expect(sectionSpan(ctx, "Identity")).toContain("You are executing steps for task FN-5970.");
  });

  it("idle pre-flight request routes its candidate ids through the seam with their own heading", () => {
    const request = buildIdlePreflightRequest(["FN-10", "FN-2"]);
    expect(request).toContain("## Request Context");
    expect(request).toContain("FN-10");
    expect(buildIdlePreflightRequest(["FN-10", "FN-2"])).toBe(request);
  });
});

describe("compactPromptMemory never re-labels foreign text as memory", () => {
  const oversizedMemoryBody = `- ${MEMORY_FILE_SENTINEL}\n${"- filler memory line\n".repeat(1200)}`;

  it("compacts a composed prompt without pulling the persona block into the memory span", () => {
    const ctx = buildRequestVolatileContext({
      memorySection: `## Agent Memory\n\n${oversizedMemoryBody}`,
      identitySection: `- ${PERSONA_SENTINEL}`,
    });
    const full = appendRequestVolatileContext("Do the step.", ctx);

    const compacted = __testOnlyPromptCompaction.compactPromptMemory(full);
    expect(compacted).not.toBeNull();

    const span = sectionSpan(compacted!, "Agent Memory");
    expect(span.length).toBeLessThanOrEqual(8_000 + 2_000);
    expect(span).toContain(MEMORY_FILE_SENTINEL);
    expect(span).not.toContain(PERSONA_SENTINEL);
    // The persona survives under its own heading.
    expect(compacted!).toContain(`## Identity\n\n- ${PERSONA_SENTINEL}`);
  });

  it("documents the relabel hazard the seam prevents: a hand-bypassed span DOES swallow headingless bullets", () => {
    // Negative control: composing AROUND the seam (hand-joined string) reproduces the old bleed —
    // compaction strips the real memory prose (not bullet-shaped) and re-emits the foreign BULLET
    // under the memory heading, relabelling it as memory. This shape is unreachable through
    // buildRequestVolatileContext/appendRequestVolatileContext, which is the invariant.
    const proseFiller = "prose memory line with no bullet marker\n".repeat(300);
    const handJoined = `## Agent Memory\n\n- ${MEMORY_FILE_SENTINEL}\n${proseFiller}\n- ${PERSONA_SENTINEL}`;
    const compacted = __testOnlyPromptCompaction.compactPromptMemory(handJoined);
    expect(compacted).not.toBeNull();
    expect(sectionSpan(compacted!, "Agent Memory")).toContain(PERSONA_SENTINEL);
    expect(sectionSpan(compacted!, "Agent Memory")).not.toContain("prose memory line");
  });
});

describe("declared-source renderer keeps the declared source alone in the span", () => {
  it("inline agent.memory and MEMORY.md bodies are the declared source; card text added by the tail is outside", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-fn-rufu597-mem-"));
    try {
      const agentId = "agent-597test";
      mkdirSync(join(rootDir, ".fusion", "agent-memory", agentId), { recursive: true });
      writeFileSync(
        join(rootDir, ".fusion", "agent-memory", agentId, "MEMORY.md"),
        `- ${MEMORY_FILE_SENTINEL}\n`,
        "utf-8",
      );
      const agent = {
        id: agentId,
        name: "Memory Source Agent",
        memory: `inline note: ${MEMORY_INLINE_SENTINEL}`,
      } as unknown as Agent;

      const parts = await resolveAgentInstructionParts(agent, rootDir, undefined, "full");
      const memorySection = parts.memorySection;

      // Full mode inlines the declared sources — the agent's inline memory and the long-term
      // file body — under the section heading. (Incident-era rendering also inlined; the span is
      // owned by these sources alone. A file whose body opens its own `#`/`##` headings ends the
      // span there — still declared-source content, never a foreign artifact.)
      expect(sectionSpan(memorySection, "Agent Memory")).toContain(MEMORY_INLINE_SENTINEL);
      expect(sectionSpan(memorySection, "Agent Memory")).toContain(MEMORY_FILE_SENTINEL);

      // ...and composing the tail around it keeps foreign card text OUT of the span.
      const ctx = buildRequestVolatileContext({
        memorySection,
        identitySection: `## Identity\n\n${CARD_SENTINEL}`,
      });
      expect(sectionSpan(ctx, "Agent Memory")).not.toContain(CARD_SENTINEL);
      expect(sectionSpan(ctx, "Agent Memory")).toContain(MEMORY_INLINE_SENTINEL);
      expect(sectionSpan(ctx, "Identity")).toContain(CARD_SENTINEL);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("index mode still opens with the declared heading; off mode composes to an empty tail contribution", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-fn-rufu597-idx-"));
    try {
      const agentId = "agent-597idx";
      mkdirSync(join(rootDir, ".fusion", "agent-memory", agentId), { recursive: true });
      writeFileSync(join(rootDir, ".fusion", "agent-memory", agentId, "MEMORY.md"), "# MEMORY\n\n- x\n", "utf-8");
      const agent = { id: agentId, name: "Index Agent" } as unknown as Agent;

      const indexParts = await resolveAgentInstructionParts(agent, rootDir, undefined, "index");
      expect(indexParts.memorySection.startsWith("## Agent Memory")).toBe(true);
      expect(indexParts.memorySection).toContain("index mode");

      const offParts = await resolveAgentInstructionParts(agent, rootDir, undefined, "off");
      expect(offParts.memorySection).toBe("");
      expect(buildRequestVolatileContext({ memorySection: offParts.memorySection })).toBe("");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
