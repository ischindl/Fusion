import { AWAITING_APPROVAL_PAUSE_REASON, remediationDeclaredFiles, remediationWaveCount, type Task, type TaskStore } from "@fusion/core";
import { deriveRemediationSteps } from "./derive-remediation-steps.js";
import type { RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";

export type AppendReviewRemediationStepsDeps = {
  store: TaskStore;
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined>;
  sendTaskBackForFix: (...args: any[]) => Promise<void>;
};

/**
 * FNXC:ReviewGatedRemediation 2026-08-23-05:14:
 * A review-gated rejection appends named provenance work before it can bounce. This deliberately
 * refuses a blind return to implementation: no candidate, out-of-scope evidence, duplicate-only
 * work, or the fourth wave is a human hold rather than an empty executor dispatch.
 */
/*
FNXC:VerificationRemediation 2026-08-26-06:31:
`worktreePath` lets a caller that already HOLDS the live checkout hand it in instead of falling back
to `task.worktree`. The executor's deterministic-verification gate is such a caller, and the fallback
is not safe for it: `performWorkflowRerunBounce` persists whatever path it receives back onto
`task.worktree`, so an empty fallback WIPES the pointer — the card renders "Unassigned" and
self-healing can no longer reclaim the worktree as idle. Graph-driven callers (the Code Review
remediation node) have no such path in hand and keep the task-record fallback.
*/
export async function appendReviewRemediationSteps(
  deps: AppendReviewRemediationStepsDeps,
  task: Task,
  info: RequestPreMergeOptionalStepFixInfo,
  options: { worktreePath?: string } = {},
): Promise<boolean> {
  const gate = info.nodeId === "verification" ? "Verification" : info.nodeId === "code-review" ? "Code Review" : undefined;
  if (!gate) return false;
  const wave = remediationWaveCount(task.steps ?? []) + 1;
  if (wave > 3) return park(deps.store, task.id, "review-remediation-wave-exhausted");
  const prompt = await deps.readTaskArtifact(task.id, "PROMPT.md");
  const derived = deriveRemediationSteps({
    gate,
    gateStepId: info.nodeId!,
    wave,
    findings: info.findings,
    verificationOutput: info.feedback,
    verificationCommandLabel: gate === "Verification" ? info.stepName : undefined,
    prompt,
    changedFiles: task.modifiedFiles,
  });
  if (derived.reason === "upstream-out-of-scope") {
    await deps.store.logEntry(task.id, "Review remediation is out of scope — awaiting human action", derived.outOfScope.map((item) => item.filePath).filter(Boolean).join(", "));
    return park(deps.store, task.id, "review-remediation-upstream-out-of-scope");
  }
  if (derived.steps.length === 0) return park(deps.store, task.id, "review-remediation-no-actionable-findings");
  const appended = await deps.store.appendRemediationSteps(task.id, derived.steps, { wave });
  const live = await deps.store.getTask(task.id);
  if (appended.appendedCount === 0 || !live.steps.some((step) => step.status === "pending")) {
    return park(deps.store, task.id, "review-remediation-no-pending-work");
  }
  await widenPromptFileScope(deps.store, task.id, prompt, remediationDeclaredFiles(appended.appended));
  await deps.sendTaskBackForFix(
    live,
    options.worktreePath?.trim() || live.worktree || "",
    info.feedback,
    info.stepName,
    `Review gate ${gate} requested named remediation`,
    true,
    false,
    undefined,
    info.findings,
    undefined,
    "none",
  );
  return true;
}

async function park(store: TaskStore, taskId: string, reason: string): Promise<false> {
  await store.updateTask(taskId, {
    status: "awaiting-approval",
    paused: true,
    pausedReason: AWAITING_APPROVAL_PAUSE_REASON,
    awaitingApprovalReason: "code-review-non-convergence",
  });
  await store.logEntry(taskId, "Review remediation requires human action", reason);
  return false;
}

/**
 * FNXC:ReviewGatedRemediation 2026-08-23-05:23:
 * A remediation accepted from the branch diff may be outside the original prompt scope. Persist its
 * declared files before the bounce so the executor and scope-aware squash merge see the same contract.
 */
async function widenPromptFileScope(store: TaskStore, taskId: string, prompt: string | undefined, files: readonly string[]): Promise<void> {
  const additions = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (additions.length === 0 || !prompt) return;
  const heading = /^##\s+File Scope\s*$/m.exec(prompt);
  if (!heading || heading.index === undefined) return;
  const sectionStart = heading.index + heading[0].length;
  const rest = prompt.slice(sectionStart);
  const nextHeading = rest.search(/^##\s/m);
  const sectionEnd = nextHeading === -1 ? prompt.length : sectionStart + nextHeading;
  const section = prompt.slice(sectionStart, sectionEnd);
  const existing = new Set((section.match(/`([^`]+)`/g) ?? []).map((entry) => entry.slice(1, -1)));
  const missing = additions.filter((file) => !existing.has(file));
  if (missing.length === 0) return;
  const trimmed = section.replace(/\s+$/, "");
  const insertion = missing.map((file) => `- \`${file}\``).join("\n");
  const replacement = trimmed.length === 0 ? `\n\n${insertion}\n` : `${trimmed}\n${insertion}\n`;
  await store.updateTask(taskId, { prompt: prompt.slice(0, sectionStart) + replacement + prompt.slice(sectionEnd) });
}
