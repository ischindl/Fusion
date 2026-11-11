/**
 * Shared harness for the authoritative-PROMPT.md publication tests.
 *
 * A real `TaskStore` needs PostgreSQL (`updateTaskUnlockedImpl` reads project settings through the store, and
 * SQLite was removed), so these cases drive the REAL publication sequence with a minimal store double built the
 * same way `task-update-prompt-return.test.ts` builds its own: `taskDir` points at a fresh temp directory so
 * `PROMPT.md` I/O is genuinely on disk, `readTaskJson` returns the row, and every unlisted store method answers
 * with an async no-op. That exercises the whole `updates.prompt` branch — the integrity gate, the step
 * re-derivation, the durable write, and the read-back — with no database.
 *
 * RUFU-536 (2026-11-11): kept out of the two `.test.ts` files that consume it so the two halves of one
 * publication contract — byte equality and step re-derivation — stay readable independently while sharing one
 * fixture builder instead of each inventing its own.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateTaskUnlockedImpl } from "../task-update.js";
import type { TaskStore } from "../../store.js";
import type { Task } from "../../types.js";

export interface PromptWriteHarness {
  readonly task: Task;
  readonly taskDir: string;
  readonly promptPath: string;
  publish(prompt: string, extra?: Record<string, unknown>): Promise<unknown>;
  publishWithStepWrite(prompt: string, steps: unknown): Promise<unknown>;
  durablePrompt(): string;
  durableSteps(): NonNullable<Task["steps"]>;
  reDerivationLog(): string | undefined;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * A publishable baseline document: heading, one Mission, four steps, no duplicate. The generated Original
 * Description markers are present and resolvable, which is the shape a planned card's durable file carries.
 */
export const BASELINE_PROMPT = [
  "# Baseline spec",
  "",
  "## Original Description",
  "",
  "<!-- fusion-original-description:start -->",
  "Baseline body",
  "<!-- fusion-original-description:end -->",
  "",
  "## Mission",
  "",
  "Publish one generation of this document.",
  "",
  "## Steps",
  "",
  "### Step 0: Preflight",
  "Inspect the tree.",
  "### Step 1: Implement",
  "Change the code.",
  "### Step 2: Verify",
  "Run the checks.",
  "### Step 3: Deliver",
  "Hand it over.",
  "",
].join("\n");

export function stepNames(steps: readonly { name: string }[] | undefined): string[] {
  return (steps ?? []).map((step) => step.name);
}

export function createPromptWriteHarness(options: {
  baselinePrompt?: string;
  steps?: Task["steps"];
} = {}): PromptWriteHarness {
  const taskDir = mkdtempSync(join(tmpdir(), "rufu-536-prompt-write-"));
  const promptPath = join(taskDir, "PROMPT.md");
  const row = {
    id: "RUFU-536-T",
    column: "in-progress",
    title: "Baseline spec",
    description: "Baseline spec",
    prompt: options.baselinePrompt ?? BASELINE_PROMPT,
    steps: options.steps ?? [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
      { name: "Verify", status: "pending" },
      { name: "Deliver", status: "pending" },
    ],
    dependencies: [],
    log: [],
    status: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as unknown as Task;

  const store = {
    taskDir: () => taskDir,
    readTaskJson: async () => row,
    atomicWriteTaskJsonWithAudit: async () => undefined,
    atomicWriteTaskJson: async () => undefined,
    writeTaskJson: async () => undefined,
    getSettings: async () => ({}),
    getProjectSettings: async () => ({}),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    getWorkflowDefinition: async () => undefined,
    emit: () => undefined,
    isWatching: false,
  } as Record<string, unknown>;
  const proxied = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as unknown as TaskStore;

  const publish = (prompt: string, extra: Record<string, unknown> = {}) =>
    updateTaskUnlockedImpl(proxied, row.id, { prompt, ...extra } as never);

  return {
    task: row,
    taskDir,
    promptPath,
    publish: (prompt, extra) => publish(prompt, extra),
    publishWithStepWrite: (prompt, steps) => publish(prompt, { steps }),
    durablePrompt: () => readFileSync(promptPath, "utf-8"),
    durableSteps: () => row.steps ?? [],
    reDerivationLog: () =>
      [...(row.log ?? [])].reverse().find((entry) => String(entry.action).startsWith("Step list re-derived"))
        ?.action as string | undefined,
  };
}
