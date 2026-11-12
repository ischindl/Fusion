import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TaskStore } from "@fusion/core";
/*
FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
Value imports (not `type`) so the writeback can measure prompt size and recognise the store's shrink
refusal. The engine mocks `@fusion/core`; classification uses the exported duck-typed predicate
(`isPromptShrinkRejectedError`) so it survives that boundary, mirroring `isDuplicatedPromptSectionError`.
*/
import { isMaterialPromptShrink, promptByteLength, isPromptShrinkRejectedError } from "@fusion/core";

/*
FNXC:PlanArtifactPersistence 2026-09-01-14:49:
Fresh planning runs at the project root under a boundary that permits generic writes only inside `.fusion/`,
so normal plans publish directly to the authoritative task artifact. This worktree-recovery path remains for
replan cards that already retained an execution checkout or legacy attempts interrupted before FN-282.
Recovered content still passes through `store.updateTask({ prompt })`, and the authoritative plan is mirrored
under the `plan` task-document key so filesystem and project-database durability remain aligned.
*/

/** Relative, cwd-anchored path handed to the planning agent for a task's spec. */
export function relativePromptPath(taskId: string): string {
  return `.fusion/tasks/${taskId}/PROMPT.md`;
}

/** The `task_documents` key used to mirror the authoritative plan into the project DB. */
export const PLAN_DOCUMENT_KEY = "plan";

export interface PlanWritebackLogger {
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ReconcileWorktreePlanArtifactOptions {
  store: TaskStore;
  taskId: string;
  /** Project root checkout — the authoritative `.fusion/` location. */
  rootDir: string;
  /** cwd the planning session ran in. Equal to `rootDir` when planning did not get a worktree. */
  planningCwd: string;
  logger?: PlanWritebackLogger;
  /**
   * Optional caller-owned authoritative writer. Triage uses this to serialize a recovered
   * worktree artifact with its reset-generation fence before it can recreate PROMPT.md.
   */
  writeAuthoritativePrompt?: (content: string) => Promise<boolean>;
  /** Optional caller-owned plan-document writer subject to the same publication fence. */
  mirrorAuthoritativePlan?: (content: string, author?: string) => Promise<boolean>;
}

export type PlanWritebackOutcome =
  /** Planning ran in the project root; there is no separate copy to reconcile. */
  | "not-worktree"
  /** No spec file inside the worktree — the planner used the durable writer, as instructed. */
  | "no-worktree-artifact"
  /** Worktree copy is empty/whitespace; nothing worth rescuing. */
  | "worktree-artifact-empty"
  /** Worktree copy matches the authoritative root copy already. */
  | "already-authoritative"
  /** Worktree copy was copied back into the project `.fusion/` folder. */
  | "recovered"
  /**
   * FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534): the worktree copy is a material shrink of the
   * authoritative root copy. The root file is left untouched and the LARGER root content is returned so
   * triage classifies it as size loss (`recovery-shrunk`), NOT a heading-shape problem and NOT `recovery-failed`
   * (which would offer a doomed retry that only reproduces the truncation).
   */
  | "recovery-shrunk"
  /** A worktree copy existed but persisting it failed; the root copy is untouched. */
  | "recovery-failed"
  /** A reset fenced this planning attempt before its worktree copy could be published. */
  | "recovery-fenced";

export interface ReconcileWorktreePlanArtifactResult {
  outcome: PlanWritebackOutcome;
  /** Authoritative plan content after reconciliation, when one could be resolved. */
  content?: string;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * FNXC:PlanArtifactPersistence 2026-07-26-03:55:
 * Copy a worktree-local PROMPT.md back into the main project `.fusion/` folder.
 *
 * Only rescues a STRANDED plan: when the root copy already matches, or the worktree holds nothing, this
 * is a no-op. The root copy is never overwritten with an empty or whitespace-only worktree file, so a
 * planner that used `fn_task_prompt_write` correctly cannot have its spec clobbered by a stale stub the
 * worktree happened to inherit.
 *
 * Failure is non-fatal: triage's own deterministic validation still owns the "no usable spec" verdict, and
 * a failed rescue must not convert a recoverable planning pass into a hard error.
 */
export async function reconcileWorktreePlanArtifact(
  options: ReconcileWorktreePlanArtifactOptions,
): Promise<ReconcileWorktreePlanArtifactResult> {
  const { store, taskId, rootDir, planningCwd, logger } = options;
  const relPath = relativePromptPath(taskId);

  const rootContent = await readIfPresent(join(rootDir, relPath));
  if (planningCwd === rootDir) {
    return { outcome: "not-worktree", content: rootContent ?? undefined };
  }

  const worktreeContent = await readIfPresent(join(planningCwd, relPath));
  if (worktreeContent === null) {
    return { outcome: "no-worktree-artifact", content: rootContent ?? undefined };
  }
  if (worktreeContent.trim().length === 0) {
    return { outcome: "worktree-artifact-empty", content: rootContent ?? undefined };
  }
  if (rootContent === worktreeContent) {
    return { outcome: "already-authoritative", content: rootContent };
  }

  /*
  FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
  Eager shrink detection BEFORE any root mutation or authoritative restore. The worktree is a disposable
  checkout, so its (possibly truncated) copy must never be allowed to overwrite a larger accepted spec.
  If the non-empty root copy is materially larger than the worktree copy, keep the root bytes and report
  `recovery-shrunk` — the LARGER root content is what downstream reads recover, and triage names the durable
  revision instead of blaming operator heading shape.
  */
  if (rootContent !== null && rootContent.trim().length > 0) {
    const rootBytes = promptByteLength(rootContent);
    const worktreeBytes = promptByteLength(worktreeContent);
    if (isMaterialPromptShrink(rootBytes, worktreeBytes)) {
      logger?.warn?.(
        `${taskId}: worktree-local PROMPT.md (${worktreeBytes} B) is a material shrink of the accepted root spec (${rootBytes} B); keeping the authoritative root copy`,
      );
      return { outcome: "recovery-shrunk", content: rootContent };
    }
  }

  try {
    // The single validated persistence path: File Scope validation + root PROMPT.md write + task.json sync.
    const persisted = options.writeAuthoritativePrompt
      ? await options.writeAuthoritativePrompt(worktreeContent)
      : (await store.updateTask(taskId, { prompt: worktreeContent }), true);
    if (!persisted) return { outcome: "recovery-fenced", content: rootContent ?? undefined };
    logger?.log?.(
      `${taskId}: recovered a worktree-local PROMPT.md into the project .fusion folder (${planningCwd})`,
    );
    return { outcome: "recovered", content: worktreeContent };
  } catch (error) {
    /*
    FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
    A store-level shrink refusal (the writeback writer runs `updateTask({ prompt })` which consults the
    guard, including the eager path above) must NOT be reported as `recovery-failed`. `recovery-failed`
    reads as "retry the rescue", but retrying only reproduces the truncation. Classify the refusal as
    `recovery-shrunk` and return the untouched root content as the recovery source.
    */
    if (isPromptShrinkRejectedError(error)) {
      logger?.warn?.(
        `${taskId}: authoritative writeback refused a material shrink of the accepted spec; keeping the root copy as the recovery source`,
      );
      return { outcome: "recovery-shrunk", content: rootContent ?? undefined };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(
      `${taskId}: failed to copy the worktree-local PROMPT.md back into the project .fusion folder: ${message}`,
    );
    return { outcome: "recovery-failed", content: rootContent ?? undefined };
  }
}

/**
 * FNXC:PlanArtifactPersistence 2026-07-26-03:55:
 * Mirror the authoritative plan into the project database under the `plan` task document.
 *
 * `project.tasks` carries no `prompt` column, so without this the spec exists only as a file in the
 * project checkout. The `plan` document is already the draft surface triage falls back to when PROMPT.md
 * is absent, so mirroring here makes that recovery path DB-backed instead of filesystem-only.
 *
 * Best-effort by design: a mirror failure must never fail the planning pass that just produced a good spec.
 * Re-mirroring identical content is skipped so repeated prompt writes do not churn document revisions.
 */
export async function mirrorPlanToProjectDb(
  store: TaskStore,
  taskId: string,
  content: string,
  options: { author?: string; logger?: PlanWritebackLogger } = {},
): Promise<boolean> {
  if (content.trim().length === 0) return false;
  if (typeof store.upsertTaskDocument !== "function") return false;

  try {
    if (typeof store.getTaskDocument === "function") {
      const existing = await store.getTaskDocument(taskId, PLAN_DOCUMENT_KEY);
      if (typeof existing?.content === "string" && existing.content === content) return false;
    }
    await store.upsertTaskDocument(taskId, {
      key: PLAN_DOCUMENT_KEY,
      content,
      author: options.author ?? "agent",
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.warn?.(`${taskId}: failed to mirror the plan into the project database: ${message}`);
    return false;
  }
}

/**
 * FNXC:PlanArtifactPersistence 2026-07-26-03:55:
 * Combined post-planning durability pass: rescue a worktree-stranded spec into the project `.fusion/`
 * folder, then mirror whatever is authoritative afterwards into the project database. Callers run this
 * BEFORE reading the finalized spec so the read observes the recovered content.
 */
export async function persistPlanArtifact(
  options: ReconcileWorktreePlanArtifactOptions & { author?: string },
): Promise<ReconcileWorktreePlanArtifactResult & { mirrored: boolean }> {
  const result = await reconcileWorktreePlanArtifact(options);
  if (result.outcome === "recovery-fenced") return { ...result, mirrored: false };
  const mirrored = result.content
    ? options.mirrorAuthoritativePlan
      ? await options.mirrorAuthoritativePlan(result.content, options.author)
      : await mirrorPlanToProjectDb(options.store, options.taskId, result.content, {
        author: options.author,
        logger: options.logger,
      })
    : false;
  return { ...result, mirrored };
}
