// FN-3548 / FN-3724 / FN-3751: keep agent-action-gate and permanent-agent-gating
// classifications sourced from one module to prevent two-path drift (see MEMORY.md drift note).
import type { AgentPermissionPolicyActionCategory, AgentPermissionPolicyDisposition } from "@fusion/core";

export const READONLY_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["read", "find", "grep", "ls"]);
export const FILE_WRITE_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * FNXC:ToolGovernance 2026-06-27-12:05:
 * Workflow edits, task status/custom-field updates, held-task promotion, and refinement creation are mutating heartbeat tools. Keep them in the shared task-agent bucket so action-gate and permanent-agent policy decisions cannot drift or fall through to silent exemption.
 */
const SHARED_TASK_AGENT_TOOLS = [
  "fn_task_add_dep",
  "fn_task_update",
  "fn_task_assign",
  "fn_spawn_agent",
  "fn_update_agent_config",
  "fn_agent_create",
  "fn_agent_delete",
  "fn_workflow_select",
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_delete",
  "fn_workflow_settings",
  "fn_task_promote",
  "fn_task_refine",
] as const;
const PROVISIONING_TOOLS = ["fn_agent_create", "fn_agent_delete"] as const;
/**
 * FNXC:AgentGating 2026-07-26-15:05:
 * FN-3953 keeps provisioning tools OUT of action-gate task_agent_mutation so the
 * dedicated agent_provisioning approval policy (resolveAgentProvisioningPolicy,
 * now live in production lanes) is the single authority — double approval rows
 * would otherwise be minted. With the action gate's unknown-tool fallback now
 * fail-closed, this deliberate exemption must be POSITIVE, not an accident of
 * the old exempt default.
 */
export const ACTION_GATE_PROVISIONING_POLICY_TOOLS: ReadonlySet<string> = new Set(PROVISIONING_TOOLS);

/**
 * FNXC:ToolGovernance 2026-06-27-12:00:
 * Newly exposed mutating heartbeat tools must be positively classified before agents receive them, otherwise the action gate's unrecognized-tool fallback silently allows them. Verification and the planning-only dependency installer execute engine-owned commands, so both gating paths use command_execution instead of a coordination exemption.
 */
export const COMMAND_EXECUTION_FN_TOOLS: ReadonlySet<string> = new Set([
  "fn_run_verification",
  // FNXC:TaskVerificationRequest 2026-07-30-00:00: queuing ultimately executes an executor-owned subprocess.
  "fn_task_request_verification",
  "fn_install_worktree_dependencies",
]);

/**
 * FNXC:ToolGovernance 2026-06-27-11:24:
 * FN-7126 classifies task creation/delegation/import as task_agent_mutation in the action gate because they mutate the board and must honor operator approval/block policy. In the permanent-agent gate, delegate/import tools remain recognized `none` coordination primitives while fn_task_create is governed separately as a board mutation.
 *
 * FNXC:ToolGovernance 2026-06-27-12:31:
 * FN-7132 requires every live board-creation tool to avoid read-only classification in all gate paths. Classify fn_task_create as task_agent_mutation for both action and permanent agents so locked-down policies can block task-row creation; keep delegate and GitHub import tools in the action-only bucket until their permanent-agent coordination semantics are intentionally revisited.
 *
 * FNXC:ToolGovernance 2026-06-27-16:51:
 * Identity reflection stays out of this action-gate mutation-only list because it is heartbeat-critical coordination, not a task-board mutation. Keep it in COORDINATION_EXEMPT_TOOLS and READONLY_FN_TOOLS so exported mutation sets do not contradict action-gate exemption semantics.
 */
/*
FNXC:MissionAdmission 2026-07-30-00:00:
FN-8307 treats autonomous implementation creation and delegation as one admission
class at the tool factory (requireMissionLineage + resolveApprovedMissionLineage).

FNXC:MissionAdmission 2026-07-22-13:07:
Gates no longer hard-block missing lineage so freeform chat/user-directed creates
remain policy-governed. Lineage enforcement for idle heartbeat patrol lives in
agent-tools.ts (requireMissionLineage), not a gate pre-check.
*/
const PERMANENT_AND_ACTION_TASK_AGENT_TOOLS = ["fn_task_create", "fn_delegate_task"] as const;
const ACTION_GATE_TASK_AGENT_ONLY_TOOLS = [
  ...PERMANENT_AND_ACTION_TASK_AGENT_TOOLS,
  "fn_delegate_task",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
] as const;
const ACTION_GATE_SHARED_TASK_AGENT_TOOLS = SHARED_TASK_AGENT_TOOLS.filter(
  (tool) => !(PROVISIONING_TOOLS as readonly string[]).includes(tool),
);
const PERMANENT_TASK_AGENT_ONLY_TOOLS = [
  "fn_task_pause",
  "fn_task_unpause",
  "fn_task_retry",
  "fn_task_duplicate",
  "fn_task_delete",
  // FNXC:AgentGating 2026-07-26-12:00: #2376 chat permission-parity exposes fn_task_merge; classify it so the action gate cannot fall through to exempt.
  "fn_task_merge",
  "fn_task_plan",
  "fn_mission_create",
  "fn_mission_delete",
  "fn_mission_update",
  "fn_mission_set_status",
  /*
   * FNXC:ToolGovernance 2026-08-11-03:58:
   * Mission blocked-badge repair overrides a durable stop signal, so its CLI/pi-extension
   * surface is hard-withheld from agent principals. Classify it here so both gate paths
   * never fall through as unrecognized and readonly workflow steps record an explicit denial.
   */
  "fn_mission_clear_blocked",
  "fn_mission_reconcile",
  "fn_mission_backfill_assertions",
  "fn_milestone_add",
  "fn_slice_add",
  "fn_feature_add",
  "fn_feature_delete",
  "fn_slice_delete",
  "fn_milestone_delete",
  "fn_slice_activate",
  "fn_feature_link_task",
  "fn_feature_unlink_task",
  "fn_feature_repoint_task",
  "fn_feature_update",
  "fn_feature_repair_validation",
  "fn_feature_set_status",
  "fn_milestone_update",
  /* FNXC:Ideation 2026-07-30-15:30: Persisted divergence/convergence writes require both action and permanent-agent policy recognition. */
  "fn_ideation_start",
  "fn_ideation_diverge",
  "fn_ideation_converge",
  "fn_agent_stop",
  "fn_agent_start",
] as const;

export const TASK_AGENT_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

// FN-3953: provisioning tools are gated by dedicated agent_provisioning policy;
// keep them out of action-gate task_agent_mutation to avoid double approval rows.
/*
FNXC:MissionToolGating 2026-07-30-10:31:
FN-8294 exposes Mission hierarchy mutations to triage alongside executor and
heartbeat. Every permanent-agent task mutation must also be action-gated;
otherwise Mission writes fall through the action gate's exempt default even
when their permanent-agent classification is restrictive.
*/
export const ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  ...ACTION_GATE_SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

export const PERMANENT_AGENT_TASK_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...PERMANENT_AND_ACTION_TASK_AGENT_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

/**
 * FNXC:ToolGovernance 2026-07-09-00:00:
 * FN-7728 gives `fn_task_bypass_review` (FN-7720's merge-gate override, CLI/pi-extension operator-tool-only — never on executor/reviewer/triage agent tool lists) its own `review_gate_bypass` classification, distinct from `task_agent_mutation`, so operators can govern "who may bypass a failed review gate" independently of ordinary task mutations and it can never fall through to the unrecognized-tool exempt fallback. Both evaluateAgentActionGate (agent-action-gate.ts) and the permanent-agent gate (permanent-agent-gating.ts) must consume this same set so the two gate paths cannot drift.
 */
export const REVIEW_GATE_BYPASS_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_bypass_review"]);

/**
 * FNXC:ToolGovernance 2026-07-09-08:30:
 * FN-7737 gives `fn_task_file_scope_add` (the File Scope additional-approval action — lets an executing agent extend its task's declared `## File Scope` beyond the initial spec at runtime) its own `file_scope` classification, distinct from `task_agent_mutation`/`file_write_delete`, so operators can independently allow/require-approval/block it. Preflight confirmed the tool was previously unclassified in both gate paths and fell through to the exempt/allow fallback; it is now positively recognized here so it can never silently bypass policy. Both evaluateAgentActionGate (agent-action-gate.ts) and the permanent-agent gate (permanent-agent-gating.ts) must consume this same set so the two gate paths cannot drift.
 */
export const FILE_SCOPE_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_file_scope_add"]);

export const FILE_WRITE_DELETE_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_attach"]);

export const NETWORK_API_TOOLS: ReadonlySet<string> = new Set([
  "fn_research_run",
  "fn_research_cancel",
  "fn_research_retry",
  "fn_web_fetch", // FN-4603: outbound HTTP fetch should be network-classified.
  "worktrunk_install", // FN-4624: binary auto-install downloads from GitHub.
]);

export const ACTION_GATE_NETWORK_API_TOOLS: ReadonlySet<string> = new Set([
  "fn_research_run",
  "fn_research_cancel",
  // FNXC:AgentGating 2026-07-26-15:15: fn_research_retry re-runs an outbound research call; it previously slipped through the action gate via the exempt fallback (silent-exemption defect). Parity with the permanent gate's network_api classification; still "allow" under the default preset.
  "fn_research_retry",
  "fn_web_fetch", // FN-4603: honor network_api approval policy for web fetches.
  "worktrunk_install", // FN-4624: gate binary auto-install under network_api policy.
]);

export const READONLY_FN_TOOLS: ReadonlySet<string> = new Set([
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_task_list",
  "fn_task_show",
  // FNXC:TaskVerificationRequest 2026-07-30-00:00: persisted status is an explicit read-only operation.
  "fn_task_verification_status",
  // FNXC:ToolGovernance 2026-06-27-14:16: Task search is a read-only duplicate-discovery tool; classify it positively so heartbeat/triage calls never rely on the unknown-tool exempt fallback.
  "fn_task_search",
  // FNXC:ToolGovernance 2026-06-27-00:00: `fn_task_get` is a deprecated recognition-only alias. It is no longer registered as a live tool, but historical/in-flight calls must still classify as read-only instead of falling through to unknown-tool handling.
  "fn_task_get",
  "fn_task_document_write",
  "fn_task_document_read",
  /*
  FNXC:TriagePromptPersistence 2026-07-21-18:02:
  fn_task_prompt_write is the only durable PROMPT.md create/repair path for triage, replan, and Plan Review. It must be positively recognized as coordination-class (not an unknown tool) so permanent-agent policies cannot require approval for the planned-spec write that unblocks the board.
  */
  "fn_task_prompt_write",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
  "fn_task_browse_gitlab_project_issues",
  "fn_task_browse_gitlab_group_issues",
  "fn_task_browse_gitlab_merge_requests",
  "fn_research_list",
  "fn_research_get",
  "fn_insight_list",
  "fn_insight_show",
  "fn_insight_run_list",
  "fn_insight_run_show",
  "fn_goal_list",
  "fn_goal_show",
  // FNXC:ToolGovernance 2026-06-29-23:36: Workflow and trait discovery tools are read-only authoring support. Positively classify list/get/trait vocabulary so newly exposed published and prompt-injectable lanes never rely on unknown-tool fallback.
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_validate",
  "fn_trait_list",
  "fn_mission_list",
  "fn_mission_show",
  "fn_ideation_list",
  "fn_ideation_show",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_skills_search",
  "fn_memory_search",
  "fn_memory_get",
  "fn_task_log",
  "fn_task_logs_read",
  "fn_task_done",
  "fn_heartbeat_done",
  "fn_memory_append",
  /**
   * FNXC:ToolGovernance 2026-06-28-00:00:
   * FN-7191 requires permanent agents to call fn_ask_question directly without an approval gate. The tool only posts a structured question to the user's inbox, so it has the same trust level as fn_send_message and must be positively recognized in both gate paths.
   */
  "fn_ask_question",
  "fn_send_message",
  "fn_read_messages",
  "fn_post_room_message",
  "fn_update_identity",
  "fn_reflect_on_performance",
  /*
  FNXC:ToolGovernance 2026-08-12-22:11:
  fn_agent_read_evaluations is a subtree-scoped read. Authorization is enforced by
  the extension tool's getChainOfCommand boundary, not by this action classifier.
  */
  "fn_read_evaluations",
  "fn_agent_read_evaluations",
]);

export const COORDINATION_EXEMPT_TOOLS = [
  "read",
  "find",
  "grep",
  "ls",
  "fn_task_log",
  "fn_task_logs_read",
  "fn_task_done",
  /* FNXC:ArtifactRegistry 2026-06-21-00:00: Artifact registration mutates persisted registry state, but it is a low-risk coordination action classified like fn_task_document_write so permanent agents can publish discoverable deliverables without broad mutation approval. */
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_task_document_write",
  "fn_task_document_read",
  /*
  FNXC:TriagePromptPersistence 2026-07-21-18:02:
  Unrecognized tools fail safe to require-approval in the permanent-agent gate. fn_task_prompt_write must stay coordination-exempt (same class as fn_task_document_write) so planning and Plan Review can persist PROMPT.md without an operator approval gate. It is intentionally not a task_agent_mutation — the writer is scoped to the current task's authoritative plan artifact via TaskStore.
  */
  "fn_task_prompt_write",
  /**
   * FNXC:ToolGovernance 2026-06-27-15:22:
   * Task list/show/search tools are read-only discovery tools. Put them on the action-gate exempt registry, not only READONLY_FN_TOOLS, because evaluateAgentActionGate recognizes coordination exemptions directly and otherwise unknown fn_task_* reads silently fall through to exempt allow.
   *
   * FNXC:ToolGovernance 2026-06-27-00:00:
   * `fn_task_get` is no longer registered as a live tool, but it remains here as a deprecated recognition-only alias so stray in-flight legacy calls classify as known read-only coordination instead of relying on the unknown-tool fallback.
   */
  "fn_task_list",
  "fn_task_show",
  "fn_task_verification_status",
  "fn_task_search",
  "fn_task_get",
  "fn_memory_search",
  "fn_memory_get",
  "fn_read_messages",
  "fn_heartbeat_done",
  "fn_goal_list",
  "fn_goal_show",
  // FNXC:MissionToolGating 2026-07-30-10:31: Mission reads are safe coordination, but must be registered here as well as READONLY_FN_TOOLS so the action gate recognizes rather than silently defaulting them.
  "fn_mission_list",
  "fn_mission_show",
  "fn_ideation_list",
  "fn_ideation_show",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_validate",
  "fn_trait_list",
  /**
   * FNXC:ToolGovernance 2026-06-28-00:00:
   * FN-7191 requires fn_ask_question to bypass permanent-agent approval gates like other user-messaging coordination tools; membership here makes the action gate classify it as exempt/allow even under locked-down policies.
   */
  "fn_ask_question",
  "fn_send_message",
  "fn_post_room_message",
  "fn_memory_append",
  "fn_read_evaluations",
  // FNXC:ToolGovernance 2026-08-12-22:11: The manager read is subtree-authorized in extension.ts; follow-up remains absent so it falls back to task_agent_mutation policy.
  "fn_agent_read_evaluations",
  "fn_update_identity",
  "fn_reflect_on_performance",
] as const;

export const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "am",
  "apply",
  "stash",
  "tag",
  "push",
  "reset",
  "rm",
  "mv",
  "clean",
]);

export const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse"]);

/*
FNXC:AgentGating 2026-09-06-23:35:
classifyGitCommand used a NON-global `String.match`, so it inspected only the FIRST
git invocation in a compound command and never looked at the rest. Any git write
became a read by putting a read in front of it, e.g.
`git status; git add . && git commit -m x` classified as `git status` and ran
ungated under a policy that gates git_write. Every git invocation is now classified
against its OWN slice of the command (so per-subcommand flag tests like `-b` cannot
be satisfied by a flag belonging to a different invocation), and any write wins.

The subcommand capture had to be narrowed from `[^\s]+` to `[^\s;&|]+` for that to mean
anything on the most natural way to write a chain. Greedy `[^\s]+` swallowed an ABUTTING
separator, so `git status; git add . && git commit -m x` captured the subcommand as
"status;" (matching neither the read nor the write set) AND consumed the `;` that the next
invocation needed as its own separator, hiding `git add` from the scan entirely. Excluding
the three separator characters ends the capture at the subcommand and leaves the separator
in place; every other capture, including global-flag forms like `git --no-pager log`, is
byte-identical to before.
*/
function classifyGitInvocation(command: string, sub: string): { write: boolean; operation: string } {
  if (!sub) return { write: false, operation: "git" };

  if (READONLY_GIT_SUBCOMMANDS.has(sub)) {
    if (sub === "rev-parse" && /--show-current\b/.test(command)) {
      return { write: false, operation: "git rev-parse --show-current" };
    }
    return { write: false, operation: `git ${sub}` };
  }

  if (sub === "branch") {
    const mutatingFlags = /\s-d\b|\s-D\b|\s-m\b|\s-M\b|\s-c\b|\s-C\b/.test(command);
    if (mutatingFlags) return { write: true, operation: "git branch" };
    const tail = command.replace(/^[\s\S]*?\bgit\s+branch\b/, "").trim();
    const hasPositionalArg = tail.length > 0 && !tail.startsWith("-");
    if (hasPositionalArg) return { write: true, operation: "git branch" };
    return { write: false, operation: /--show-current\b/.test(command) ? "git branch --show-current" : "git branch" };
  }

  if (sub === "switch") {
    const write = /\s-c\b/.test(command);
    return { write, operation: write ? "git switch -c" : "git switch" };
  }

  if (sub === "checkout") {
    const write = /\s-b\b/.test(command);
    return { write, operation: write ? "git checkout -b" : "git checkout" };
  }

  if (sub === "pull") {
    const write = /--rebase\b/.test(command);
    return { write, operation: write ? "git pull --rebase" : "git pull" };
  }

  if (sub === "restore") {
    const write = /--staged\b/.test(command);
    return { write, operation: write ? "git restore --staged" : "git restore" };
  }

  if (sub === "remote") {
    const write = /\s+add\b|\s+remove\b|\s+rename\b|\s+set-url\b/.test(command);
    return { write, operation: /\s-v\b/.test(command) ? "git remote -v" : "git remote" };
  }

  if (sub === "worktree") {
    if (/\s+add\b/.test(command)) return { write: true, operation: "git worktree add" };
    if (/\s+remove\b/.test(command)) return { write: true, operation: "git worktree remove" };
    return { write: false, operation: "git worktree" };
  }

  return { write: MUTATING_GIT_SUBCOMMANDS.has(sub), operation: `git ${sub}` };
}

export function classifyGitCommand(command: string): { write: boolean; operation: string } | null {
  const invocations = [...command.matchAll(/(?:^|&&|\|\||;|\||\n)\s*git\s+([^\s;&|]+)/g)];
  if (invocations.length === 0) return null;

  let firstRead: { write: boolean; operation: string } | null = null;
  for (const [index, match] of invocations.entries()) {
    const start = match.index ?? 0;
    const end = invocations[index + 1]?.index ?? command.length;
    const classification = classifyGitInvocation(command.slice(start, end), match[1]?.trim() ?? "");
    if (classification.write) return classification;
    firstRead ??= classification;
  }
  return firstRead;
}

export function isGitWriteCommand(command: string): boolean {
  return classifyGitCommand(command)?.write ?? false;
}

/*
FNXC:AgentGating 2026-09-06-23:35:
A `bash` call could only ever classify as git_write or command_execution, so a shell
redirection was invisible to the file_write_delete category: with command_execution
"allow" and file_write_delete "require-approval", an agent wrote a repository file
with ZERO approval requests. This is a best-effort detector, NOT a sandbox. It cannot
see through `eval`, an interpreter running a script file, or a command that writes as
a side effect, and it never claims to. It exists so that allowing shell does not
SILENTLY void a stricter file-write rule, and evaluateAgentActionGate applies it in one
direction only: it can make a bash call MORE gated, never less. Real containment is the
sandbox backend's job, not a command-string classifier's.
*/

/** Commands whose ordinary purpose is to create, modify, or remove filesystem entries. */
const SHELL_FILE_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "tee", "rm", "rmdir", "unlink", "shred", "mv", "cp", "install", "ln",
  "mkdir", "touch", "truncate", "dd", "chmod", "chown", "chgrp", "rsync", "patch",
]);

/**
 * Wrappers that run another command; unwrap them rather than classify the wrapper.
 * The detach wrapper that this repository's process-supervision guard bans by name in engine
 * source is deliberately absent: a suppression is not worth one more wrapper name in a detector
 * that already documents itself as best effort.
 */
const SHELL_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set([
  "sudo", "doas", "env", "timeout", "command", "exec", "nice", "ionice", "stdbuf", "time", "xargs",
]);

/** Interpreters that run code supplied inline, which a command-string classifier cannot read. */
const SHELL_INLINE_CODE_INTERPRETERS: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "python", "python3", "perl", "ruby", "node", "deno", "php",
]);

/** Editors with an in-place flag, which rewrite their input file. */
const SHELL_IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl", "ruby"]);

/**
 * In-place flag: the short-flag cluster forms `-i`, `-i.bak`, `-ni`, plus long `--in-place`.
 * Deliberately not `-{1,2}[A-Za-z]*i`, which also matched `--expression` (letters then an `i`).
 */
const IN_PLACE_FLAG = /^(?:--in-place|-[A-Za-z]*i)/;

/** Redirect targets that discard output instead of writing a file. */
const SHELL_DISCARD_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

/** Strips quoted spans so a redirect or separator inside a string literal is not read as shell syntax. */
function stripQuotedSpans(command: string): string {
  return command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}

function redirectsToFile(command: string): boolean {
  // Drop file-descriptor duplications and closes (2>&1, >&2, 2>&-); they create no file.
  const withoutFdDuplication = command.replace(/\d*>&\s*[\d-]+/g, " ");
  for (const match of withoutFdDuplication.matchAll(/(?<![-=<>])>{1,2}(?![=>])\s*([^\s;&|<>]*)/g)) {
    const target = match[1] ?? "";
    if (target && SHELL_DISCARD_TARGET.test(target)) continue;
    return true;
  }
  return false;
}

function baseName(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1);
}

export function detectsShellFileWrite(command: string): boolean {
  if (!command.trim()) return false;
  const stripped = stripQuotedSpans(command);
  if (redirectsToFile(stripped)) return true;

  for (const segment of stripped.split(/(?:&&|\|\||;|\||\n|&)/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let cursor = 0;
    // Skip leading environment assignments and pass-through wrappers with their own arguments.
    while (cursor < tokens.length) {
      const token = tokens[cursor] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        cursor += 1;
        continue;
      }
      if (SHELL_PASSTHROUGH_COMMANDS.has(baseName(token))) {
        cursor += 1;
        while (cursor < tokens.length) {
          const argument = tokens[cursor] ?? "";
          if (argument.startsWith("-") || /^\d+[smhd]?$/.test(argument)) {
            cursor += 1;
            continue;
          }
          break;
        }
        continue;
      }
      break;
    }

    const head = baseName(tokens[cursor] ?? "");
    if (!head) continue;
    if (SHELL_FILE_WRITE_COMMANDS.has(head)) return true;
    if (head === "eval") return true;

    const flags = tokens.slice(cursor + 1);
    if (SHELL_INLINE_CODE_INTERPRETERS.has(head) && flags.some((flag) => /^-{1,2}[ce]$/.test(flag))) return true;
    if (SHELL_IN_PLACE_EDITORS.has(head) && flags.some((flag) => IN_PLACE_FLAG.test(flag))) return true;
  }

  return false;
}


/*
FNXC:AgentGating 2026-09-07-12:31:
ONE shared escalation for BOTH gates, required by this module's two-path-drift rule at the top of
the file: agent-action-gate and permanent-agent-gating classify a `bash` call identically, so they
have to apply the file_write_delete escalation identically too. Fixing only one of them would
leave the bypass live on the other gate's path (durable-agent heartbeat and chat tool calls).

The escalation is COMPARATIVE and one-directional: it fires only where the operator set
file_write_delete STRICTER than the category the command reaches through the shell, so it can make
a bash call more gated and never less. A policy whose file_write_delete is no stricter is
completely unaffected, including the shipped `unrestricted` preset (every category "allow") and
any all-require-approval preset. A legacy policy row missing either rule also escalates nothing,
which is the previous behavior.
*/
const DISPOSITION_STRICTNESS: Record<AgentPermissionPolicyDisposition, number> = {
  allow: 0,
  "require-approval": 1,
  block: 2,
};

export function escalateShellCategoryForFileWrite(params: {
  command: string;
  shellCategory: AgentPermissionPolicyActionCategory;
  rules: Partial<Record<AgentPermissionPolicyActionCategory, AgentPermissionPolicyDisposition>> | undefined;
}): AgentPermissionPolicyActionCategory {
  const { command, shellCategory, rules } = params;
  if (shellCategory === "file_write_delete") return shellCategory;
  const fileRule = rules?.file_write_delete;
  const shellRule = rules?.[shellCategory];
  if (fileRule === undefined || shellRule === undefined) return shellCategory;
  if (DISPOSITION_STRICTNESS[fileRule] <= DISPOSITION_STRICTNESS[shellRule]) return shellCategory;
  return detectsShellFileWrite(command) ? "file_write_delete" : shellCategory;
}
