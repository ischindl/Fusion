import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
FNXC:MemoryInlineClamp 2026-11-21-06:49 (RUFU-824):
The clamp's server-side telemetry used to print `MAX_MEMORY_LENGTH` as the retained figure. Whole `## `
sections are kept and never split, so the retained render lands short of the budget whenever the
next-oldest section does not fit, and the log overstated what survived. These cases pin that the leading
figure is now the RETAINED count, that the budget is stated as its own number, and that the log and the
agent-visible notice report the SAME number for the same clamp. The logger is mocked with the project's
established pattern (`self-healing-overlap-release-wake.test.ts:26`) so the assertions read the emitted
sentence rather than scraping console output.
*/
const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { MAX_MEMORY_LENGTH, resolveAgentInstructions } from "../agents/agent-instructions.js";

const CLAMP_WARN =
  /(inline|workspace) memory kept the newest (\d+) of (\d+) chars within the (\d+)-char inline memory budget, omitted (\d+)\/(\d+) sections \((\d+) chars\)/;
const PROMPT_NOTICE =
  /_(?:Inline agent memory|Workspace memory): kept the newest (\d+) of (\d+) chars within the (\d+)-char inline memory budget/;

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-test",
    name: "test-agent",
    role: "executor",
    state: "idle",
    memory: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  } as never;
}

/** The production shape: many small appended `## ` sections, newest written last. */
function sectionedMemory(sectionCount: number): string {
  const filler = "filler ".repeat(40);
  let out = "# Agent Memory\n\n<!-- durable notes below -->\n\n";
  for (let i = 1; i <= sectionCount; i += 1) {
    const sentinel = i === sectionCount ? "NEWEST-SENTINEL" : `OLD-SENTINEL-${String(i).padStart(3, "0")}`;
    out += `## Lesson ${String(i).padStart(3, "0")}\n\n${sentinel} ${filler}\n`;
  }
  return out;
}

function clampWarns(scope: "inline" | "workspace"): string[] {
  return logger.warn.mock.calls
    .map((call) => String(call[0] ?? ""))
    .filter((text) => text.includes("newest-kept clamp") && text.includes(`${scope} memory kept the newest`));
}

describe("memory clamp telemetry reports the retained figure (RUFU-824)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-clamp-telemetry-"));
    logger.warn.mockClear();
    logger.log.mockClear();
    logger.debug.mockClear();
    logger.error.mockClear();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("warns the workspace clamp with the retained count, not the budget", async () => {
    const memory = sectionedMemory(220);
    expect(memory.length).toBeGreaterThan(MAX_MEMORY_LENGTH);
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"), memory, "utf-8");

    const result = await resolveAgentInstructions(makeAgent(), testDir);

    const warns = clampWarns("workspace");
    expect(warns).toHaveLength(1);
    const warn = warns[0]!.match(CLAMP_WARN);
    expect(warn).not.toBeNull();
    const [, scope, kept, total, budget, , , omittedChars] = warn!;
    expect(scope).toBe("workspace");

    // The headline number is what survived, and it is NOT the budget: whole sections are kept, so the
    // newest-suffix render stops short of MAX_MEMORY_LENGTH whenever the next-oldest section does not fit.
    expect(Number(budget)).toBe(MAX_MEMORY_LENGTH);
    expect(Number(kept)).toBeLessThan(MAX_MEMORY_LENGTH);
    expect(Number(kept)).not.toBe(Number(budget));
    expect(Number(kept)).toBe(Number(total) - Number(omittedChars));

    // The budget is still stated, as its own number, in the same sentence.
    expect(warns[0]).toContain(`within the ${MAX_MEMORY_LENGTH}-char inline memory budget`);

    // Parity: the log and the agent-visible notice cannot disagree about the same clamp.
    const notice = result.match(PROMPT_NOTICE);
    expect(notice).not.toBeNull();
    expect(Number(notice![1])).toBe(Number(kept));
    expect(Number(notice![2])).toBe(Number(total));
  });

  it("warns the inline agent.memory clamp with the retained count, not the budget", async () => {
    const memory = sectionedMemory(220);

    const result = await resolveAgentInstructions(makeAgent({ memory }), testDir);

    const warns = clampWarns("inline");
    expect(warns).toHaveLength(1);
    const warn = warns[0]!.match(CLAMP_WARN);
    expect(warn).not.toBeNull();
    const [, scope, kept, total, budget, , , omittedChars] = warn!;
    expect(scope).toBe("inline");
    expect(Number(budget)).toBe(MAX_MEMORY_LENGTH);
    expect(Number(kept)).toBeLessThan(MAX_MEMORY_LENGTH);
    expect(Number(kept)).not.toBe(Number(budget));
    expect(Number(kept)).toBe(Number(total) - Number(omittedChars));

    const notice = result.match(PROMPT_NOTICE);
    expect(notice).not.toBeNull();
    expect(Number(notice![1])).toBe(Number(kept));
  });

  it("reports both warn sites with their own retained figures when both inputs are oversized", async () => {
    const memory = sectionedMemory(220);
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"), memory, "utf-8");

    await resolveAgentInstructions(makeAgent({ memory }), testDir);

    expect(clampWarns("inline")).toHaveLength(1);
    expect(clampWarns("workspace")).toHaveLength(1);
  });

  it("stays silent on the clamp warn when nothing was omitted", async () => {
    const memory = sectionedMemory(4);
    expect(memory.length).toBeLessThan(MAX_MEMORY_LENGTH);
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"), memory, "utf-8");

    const result = await resolveAgentInstructions(makeAgent({ memory }), testDir);

    expect(clampWarns("workspace")).toHaveLength(0);
    expect(clampWarns("inline")).toHaveLength(0);
    expect(result).not.toContain("inline memory budget");
  });
});
