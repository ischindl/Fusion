/**
 * FNXC:CodeOrganization 2026-08-03-18:40:
 * runExecutorDeterministicVerification peeled from TaskExecutor (U4).
 * Runs configured testCommand + buildCommand in the task worktree.
 *
 * FNXC:EngineDiagnostics 2026-07-26-09:33:
 * Green path verification start/pass is expected work — debug so failures stay prominent.
 */
import type { Settings, Task, TaskStore } from "@fusion/core";
import {
  runVerificationCommand,
  type VerificationResult,
} from "../execution/verification-utils.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { assessLaneLegs, laneLegRecordedPath } from "../worktree/lane-legs.js";
import { recordLaneLegRefusal, type LaneLegRefusalNotice } from "../worktree/lane-leg-refusal.js";

export type DeterministicVerificationDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

/*
FNXC:LaneLegGate 2026-11-11-23:00 (RUFU-425, W1):
The gate's measurement is only evidence about the repository the command actually ran in. A workspace
member directory that is empty, absent, or not its own repository makes `git` answer from the FOLDER
THAT CONTAINS IT, so a test command "run in the leg" reports on the project around the lane and its
exit code certifies a repository the card never delivered to. That is how a sibling board produced a
complete card with every criterion green and no commit on any ref (five occurrences measured).

So the legs are identified BEFORE the command runs, and a leg that is not its own repository is a
named refusal rather than a data point. The refusal is the ABSENCE of a measurement, which is why it
carries its own field instead of masquerading as a failed command: a caller that saw `allPassed:
false` would dispatch a fix agent to repair a test that never executed.

Two shapes here are load-bearing for other tests and must not drift:
- the no-command path still returns exactly `{ allPassed: true, notRun: true }` with no added keys, and
- a task with no workspace entries performs ZERO extra work, because most cards have no legs at all.
*/
export type DeterministicVerificationResult = VerificationResult & {
  /** Set when a workspace leg made measurement impossible. No command was executed. */
  laneLegRefusal?: LaneLegRefusalNotice;
};

export async function runExecutorDeterministicVerification(
  deps: DeterministicVerificationDeps,
  task: Task,
  worktreePath: string,
  settings: Settings,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<DeterministicVerificationResult> {
  const testCommand = settings.testCommand?.trim();
  const buildCommand = settings.buildCommand?.trim();

  if (!testCommand && !buildCommand) {
    executorLog.debug(`${task.id}: no test/build commands configured — skipping verification`);
    return { allPassed: true, notRun: true };
  }

  const legs = await assessLaneLegs(task);
  if (legs.refused) {
    const notice: LaneLegRefusalNotice = {
      code: legs.code,
      repository: legs.repository,
      path: laneLegRecordedPath(task, legs.repository),
      legs: legs.legs,
    };
    executorLog.log(`${task.id}: [verification] lane-leg gate refused (${legs.code}) at ${notice.repository} — no command executed`);
    // One History line and one audit row, written here so every consumer of this primitive reports
    // the refusal identically instead of each inventing its own sentence.
    await recordLaneLegRefusal(deps.store, task.id, notice, "deterministic-verification", deps.getRunContextFor(task.id));
    return { allPassed: false, laneLegRefusal: notice };
  }

  const parts: string[] = [];
  if (testCommand) parts.push(`test: ${testCommand}`);
  if (buildCommand) parts.push(`build: ${buildCommand}`);
  // FNXC:EngineDiagnostics 2026-07-26-09:33: green path verification start/pass is expected work — debug so failures stay prominent.
  executorLog.debug(`${task.id}: [verification] running deterministic verification (${parts.join(", ")})`);
  await deps.store.logEntry(
    task.id,
    `[verification] Running deterministic verification (${parts.join(", ")})`,
    undefined,
    deps.getRunContextFor(task.id),
  );

  const result: VerificationResult = { allPassed: true };

  // Run test command first if configured
  if (testCommand) {
    const testResult = await runVerificationCommand(
      deps.store, worktreePath, task.id, testCommand, "test", undefined, executorLog, "executor", extraEnv, settings.verificationCommandTimeoutMs,
    );
    result.testResult = testResult;

    if (!testResult.success) {
      result.allPassed = false;
      result.failedCommand = "testCommand";
      executorLog.log(`${task.id}: [verification] test failed (exit ${testResult.exitCode})`);
      return result;
    }
  }

  // Run build command second if configured
  if (buildCommand) {
    const buildResult = await runVerificationCommand(
      deps.store, worktreePath, task.id, buildCommand, "build", undefined, executorLog, "executor", extraEnv, settings.verificationCommandTimeoutMs,
    );
    result.buildResult = buildResult;

    if (!buildResult.success) {
      result.allPassed = false;
      result.failedCommand = "buildCommand";
      executorLog.log(`${task.id}: [verification] build failed (exit ${buildResult.exitCode})`);
      return result;
    }
  }

  executorLog.debug(`${task.id}: [verification] passed`);
  await deps.store.logEntry(
    task.id,
    `[verification] Deterministic verification passed`,
    undefined,
    deps.getRunContextFor(task.id),
  );
  return result;
}
