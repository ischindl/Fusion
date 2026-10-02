/*
FNXC:TaskDiffStats 2026-10-02-12:24 (RUFU-479 follow-up):
The stats cache only pays for itself if it outlives the client poll period. It used to be 10 s against a
30 s poll, so every poll recomputed a git lane — 32% of the process's subprocess-spawn CPU at idle, with
`/api/health` answering in 1.3 s. Nothing failed when that drifted, so the pairing is pinned here.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTE = "register-session-diff-routes.ts";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../routes/${name}`, import.meta.url)), "utf8");
}

function firstNumber(pattern: RegExp, text: string, label: string): number {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${label} not found — the constant was renamed or removed`);
  return Number(match[1].replace(/_/g, ""));
}

describe("diff stats cache TTL vs client poll period", () => {
  const serverTtlMs = firstNumber(
    /const TASK_DIFF_STATS_CACHE_TTL_MS = ([\d_]+);/,
    source(ROUTE),
    "TASK_DIFF_STATS_CACHE_TTL_MS",
  );
  // TaskCard drives the board's stats lane: active columns poll, inactive ones do not.
  const clientPollMs = firstNumber(
    /pollIntervalMs: isActiveColumn \? ([\d_]+) : undefined/,
    readFileSync(fileURLToPath(new URL("../../app/components/TaskCard.tsx", import.meta.url)), "utf8"),
    "TaskCard pollIntervalMs",
  );

  it("keeps the server window strictly longer than one client poll", () => {
    expect(serverTtlMs).toBeGreaterThan(clientPollMs);
  });

  it("serves at least two polls from one computation", () => {
    expect(serverTtlMs / clientPollMs).toBeGreaterThanOrEqual(2);
  });
});
