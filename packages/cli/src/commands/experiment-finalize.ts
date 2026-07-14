import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskStore, createTaskStoreForBackend } from "@fusion/core";
import {
  defaultGitOps,
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeMergeBaseError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizePlanError,
  ExperimentFinalizeService,
  ExperimentFinalizeStateError,
  type FinalizePlanOverride,
} from "@fusion/engine";
import { resolveProject } from "../project-context.js";

interface ExperimentFinalizeOptions {
  sessionId: string;
  integrationBranch?: string;
  dryRun?: boolean;
  json?: boolean;
  summary?: string;
  planFile?: string;
  projectName?: string;
}

const EXIT_CODES = new Map<string, number>([
  ["state_error", 2],
  ["no_kept_runs", 3],
  ["plan_error", 4],
  ["merge_base_error", 5],
  ["cherry_pick_conflict", 6],
  ["branch_exists", 7],
]);

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printPlan(plan: Awaited<ReturnType<ExperimentFinalizeService["previewPlan"]>>): void {
  console.log(`Session: ${plan.sessionId}`);
  console.log(`Merge base: ${plan.mergeBaseCommit}`);
  for (const group of plan.groups) {
    console.log(`- ${group.title} -> ${group.suggestedBranchName} (${group.commits.length} commits)`);
  }
}

async function parsePlanOverride(path: string): Promise<FinalizePlanOverride> {
  const content = await readFile(resolve(path), "utf8");
  return JSON.parse(content) as FinalizePlanOverride;
}

function exitWithError(error: unknown): never {
  if (error instanceof ExperimentFinalizeCherryPickConflictError) {
    console.error(`Error: ${error.message}`);
    console.error(JSON.stringify({ groupId: error.groupId, commit: error.commit, stderr: error.stderr }));
    process.exit(6);
  }
  const code = (error as { code?: string })?.code;
  if (code && EXIT_CODES.has(code)) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CODES.get(code)!);
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export async function runExperimentFinalize(options: ExperimentFinalizeOptions): Promise<void> {
  try {
    const project = options.projectName ? await resolveProject(options.projectName) : undefined;
    const projectRoot = project?.projectPath ?? process.cwd();
    // FNXC:PostgresCutover 2026-07-04: boot the PostgreSQL backend via the startup
    // factory instead of a legacy SQLite TaskStore whose runtime was removed
    // (VAL-REMOVAL-005). Falls back to legacy only on FUSION_NO_EMBEDDED_PG=1.
    const boot = await createTaskStoreForBackend({ rootDir: projectRoot });
    const taskStore: TaskStore = boot ? boot.taskStore : new TaskStore(projectRoot);
    if (!boot) {
      await taskStore.init();
    }
    const sessionStore = taskStore.getExperimentSessionStore();
    const service = new ExperimentFinalizeService({
      store: sessionStore,
      git: defaultGitOps(projectRoot),
    });

    const planOverride = options.planFile ? await parsePlanOverride(options.planFile) : undefined;

    if (options.dryRun) {
      const plan = await service.previewPlan({
        sessionId: options.sessionId,
        integrationBranch: options.integrationBranch,
      });
      if (options.json) {
        printJson({ plan });
      } else {
        printPlan(plan);
      }
      return;
    }

    const result = await service.finalize({
      sessionId: options.sessionId,
      integrationBranch: options.integrationBranch,
      planOverride,
      summary: options.summary,
    });

    if (options.json) {
      printJson({ result });
      return;
    }

    console.log(`Finalized session ${result.sessionId}`);
    for (const branch of result.branches) {
      console.log(`- ${branch.name} (${branch.tipCommit})`);
    }
  } catch (error) {
    if (
      error instanceof ExperimentFinalizeStateError
      || error instanceof ExperimentFinalizeNoKeptRunsError
      || error instanceof ExperimentFinalizePlanError
      || error instanceof ExperimentFinalizeMergeBaseError
      || error instanceof ExperimentFinalizeBranchExistsError
      || error instanceof ExperimentFinalizeCherryPickConflictError
    ) {
      exitWithError(error);
    }
    exitWithError(error);
  }
}
