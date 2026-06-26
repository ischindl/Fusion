/**
 * LLM diff-review verification — an OPT-IN, default-off verification step that
 * has an AI review a task's diff for correctness/regressions, in addition to (or
 * instead of) running test/build commands.
 *
 * FNXC:Verification 2026-06-25-00:00:
 * This sits on the merge-critical verification gate (merger.runDeterministicVerification
 * and executor.runExecutorDeterministicVerification), so the contract is strict:
 * - Controlled by the project setting `verificationLlmReview` (default "off").
 *   - "off": never invoked. The gate path is byte-identical to pre-feature behavior.
 *   - "advisory": runs, logs findings to the task, but NEVER fails verification.
 *   - "blocking": a verdict of passed:false WITH a high-severity finding fails
 *     verification, exactly like a failed test/build command.
 * - Defensive by construction: ANY LLM/infra error (spawn failure, malformed
 *   output, timeout, abort) yields an "advisory unavailable" verdict that NEVER
 *   blocks a merge. We do not hard-block merges on an LLM outage.
 * - Reuses the existing reviewer/agent plumbing (createFnAgent + promptWithFallback
 *   from ./pi.js); no new direct AI SDK dependency.
 */
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import type { Settings, TaskStore } from "@fusion/core";
import { createFnAgent, promptWithFallback } from "./pi.js";
import { createLogger } from "./logger.js";

const execFile = promisify(execFileCb);
const llmReviewLog = createLogger("llm-review");

// ── Types ──────────────────────────────────────────────────────────────

export type LlmReviewMode = "off" | "advisory" | "blocking";
export type LlmReviewSeverity = "high" | "medium" | "low";

export interface LlmReviewFinding {
  severity: LlmReviewSeverity;
  /** File the finding applies to (best-effort; "(unknown)" when the model omits it). */
  file: string;
  summary: string;
}

export interface LlmReviewVerdict {
  /** The model's overall pass/fail judgement of the diff. */
  passed: boolean;
  findings: LlmReviewFinding[];
  summary: string;
  /**
   * True when the review could not be obtained at all (LLM/infra error, malformed
   * output). An advisory-unavailable verdict is non-blocking in EVERY mode — an
   * LLM outage must never hard-block a merge.
   */
  advisoryUnavailable: boolean;
}

export interface LlmReviewGateResult {
  mode: LlmReviewMode;
  /** True when the review actually ran (mode !== "off"). */
  ran: boolean;
  verdict: LlmReviewVerdict | null;
  /**
   * True only when the gate should FAIL verification: mode "blocking", a real
   * (not advisory-unavailable) verdict, passed === false, and at least one
   * high-severity finding.
   */
  blocked: boolean;
}

/** Injectable seam so tests can mock the agent without touching ./pi.js internals. */
export interface LlmReviewAgentDeps {
  createAgent: typeof createFnAgent;
  prompt: typeof promptWithFallback;
}

const DEFAULT_AGENT_DEPS: LlmReviewAgentDeps = {
  createAgent: createFnAgent,
  prompt: promptWithFallback,
};

// ── Mode resolution ────────────────────────────────────────────────────

/**
 * Resolve the effective LLM-review mode from project settings. Anything other
 * than the two opt-in values resolves to "off" so the feature stays default-off
 * and a stray/legacy value can never silently start blocking merges.
 */
export function resolveLlmReviewMode(settings: Pick<Settings, "verificationLlmReview"> | undefined | null): LlmReviewMode {
  const raw = settings?.verificationLlmReview;
  return raw === "advisory" || raw === "blocking" ? raw : "off";
}

// ── Prompt ─────────────────────────────────────────────────────────────

const LLM_REVIEW_SYSTEM_PROMPT = `You are a meticulous senior engineer performing a final pre-merge review of a code diff.

Your job: judge whether the diff is correct and free of regressions before it merges.
You are NOT rewriting the code. You are returning a structured verdict.

Return STRICT JSON with this EXACT shape and nothing else:
{
  "passed": true | false,
  "summary": "1-3 sentence overall judgement",
  "findings": [
    { "severity": "high" | "medium" | "low", "file": "path/to/file", "summary": "concise problem statement" }
  ]
}

Rules:
- Output valid JSON only. No markdown fences, no prose outside the JSON object.
- "passed": false ONLY when you found a concrete correctness/regression problem in the diff.
- Use severity "high" for bugs, regressions, broken contracts, or data-loss risks;
  "medium" for likely-incorrect behavior or missing edge cases; "low" for style/nits.
- A merge will be BLOCKED only when passed is false AND at least one finding is "high".
  Do not invent high-severity findings; reserve "high" for real, defensible problems.
- If the diff is correct, return passed: true with an empty findings array.
- Be specific: cite the file path for every finding.`;

function buildReviewPrompt(diff: string, context?: { taskId?: string; taskTitle?: string }): string {
  const header: string[] = ["Review the following diff for correctness and regressions."];
  if (context?.taskId) header.push(`Task: ${context.taskId}${context.taskTitle ? ` — ${context.taskTitle}` : ""}`);
  header.push("Respond with strict JSON matching the required schema.");
  return [header.join("\n"), "```diff", diff, "```"].join("\n\n");
}

// ── Parsing (defensive) ────────────────────────────────────────────────

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function normalizeSeverity(value: unknown): LlmReviewSeverity {
  const s = String(value ?? "").toLowerCase();
  if (s === "high" || s === "critical" || s === "blocker") return "high";
  if (s === "medium" || s === "moderate" || s === "warning") return "medium";
  return "low";
}

function normalizeFindings(value: unknown): LlmReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): LlmReviewFinding | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (!summary) return null;
      const file = typeof record.file === "string" && record.file.trim() ? record.file.trim() : "(unknown)";
      return { severity: normalizeSeverity(record.severity), file, summary: summary.slice(0, 500) };
    })
    .filter((finding): finding is LlmReviewFinding => finding !== null);
}

/**
 * Parse the model's raw text into a structured verdict. Throws on unrecoverable
 * malformed output so the caller routes it into the advisory-unavailable path.
 */
export function parseLlmReviewResponse(raw: string): LlmReviewVerdict {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    throw new Error("empty LLM review response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("LLM review response was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM review response was not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.passed !== "boolean") {
    throw new Error("LLM review response missing boolean 'passed'");
  }
  const findings = normalizeFindings(record.findings);
  const summary = typeof record.summary === "string" && record.summary.trim()
    ? record.summary.trim().slice(0, 1000)
    : (record.passed ? "Diff reviewed: no concerns." : "Diff reviewed: concerns found.");
  return { passed: record.passed, findings, summary, advisoryUnavailable: false };
}

// ── Gate decision ──────────────────────────────────────────────────────

/**
 * Decide whether a verdict should FAIL verification under a given mode. This is
 * the single source of truth for the blocking semantics and is exhaustively
 * unit-tested.
 */
export function evaluateLlmReviewGate(mode: LlmReviewMode, verdict: LlmReviewVerdict): { blocks: boolean; reason?: string } {
  // Advisory-unavailable never blocks, regardless of mode — an LLM outage must
  // not hard-block a merge.
  if (verdict.advisoryUnavailable) return { blocks: false };
  if (mode !== "blocking") return { blocks: false };
  const highSeverity = verdict.findings.filter((f) => f.severity === "high");
  if (!verdict.passed && highSeverity.length > 0) {
    return {
      blocks: true,
      reason: `LLM diff review failed with ${highSeverity.length} high-severity finding(s): ${highSeverity.map((f) => `${f.file}: ${f.summary}`).join("; ").slice(0, 600)}`,
    };
  }
  return { blocks: false };
}

// ── Diff capture ───────────────────────────────────────────────────────

/**
 * Capture the task's diff for review. Reuses git directly (`git diff <base>..HEAD`
 * when a base ref is known, else the last commit) so it works in both the merger
 * worktree and the executor task worktree. Never throws — returns "" on any git
 * failure so review degrades to advisory-unavailable rather than crashing the gate.
 */
export async function captureReviewDiff(
  rootDir: string,
  baseRef: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const range = baseRef && baseRef.trim() ? `${baseRef.trim()}..HEAD` : "HEAD~1..HEAD";
  try {
    const { stdout } = await execFile("git", ["diff", range], {
      cwd: rootDir,
      maxBuffer: 20 * 1024 * 1024,
      signal,
    });
    return stdout ?? "";
  } catch (error) {
    llmReviewLog.warn(`could not capture review diff (${range}) in ${rootDir}: ${String(error)}`);
    return "";
  }
}

// ── Core review ────────────────────────────────────────────────────────

export interface RunLlmReviewOptions {
  rootDir: string;
  diff: string;
  taskId?: string;
  taskTitle?: string;
  /** Model lane for the review agent. When undefined, createFnAgent resolves defaults. */
  modelProvider?: string;
  modelId?: string;
  signal?: AbortSignal;
  /** Test seam: inject mock createFnAgent/promptWithFallback. */
  deps?: LlmReviewAgentDeps;
}

/**
 * Run the LLM diff review and return a structured verdict. NEVER throws: any
 * LLM/infra failure is caught and returned as an advisory-unavailable verdict.
 */
export async function runLlmReviewVerification(options: RunLlmReviewOptions): Promise<LlmReviewVerdict> {
  const deps = options.deps ?? DEFAULT_AGENT_DEPS;

  // Empty diff → nothing to review. This is a clean pass, not an outage.
  if (!options.diff || !options.diff.trim()) {
    return { passed: true, findings: [], summary: "No diff to review.", advisoryUnavailable: false };
  }

  try {
    let responseText = "";
    const { session } = await deps.createAgent({
      cwd: options.rootDir,
      systemPrompt: LLM_REVIEW_SYSTEM_PROMPT,
      tools: "readonly",
      defaultProvider: options.modelProvider,
      defaultModelId: options.modelId,
      onText: (delta: string) => {
        responseText += delta;
      },
    });

    try {
      await deps.prompt(session, buildReviewPrompt(options.diff, { taskId: options.taskId, taskTitle: options.taskTitle }));
      const sessionError = session.state as { errorMessage?: string; error?: string } | undefined;
      const stateErr = sessionError?.errorMessage ?? sessionError?.error;
      if (stateErr) {
        throw new Error(stateErr);
      }
    } finally {
      try {
        session.dispose();
      } catch {
        // best-effort cleanup
      }
    }

    return parseLlmReviewResponse(responseText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    llmReviewLog.warn(`LLM review advisory unavailable for ${options.taskId ?? "task"}: ${message}`);
    return {
      passed: true,
      findings: [],
      summary: `LLM review advisory unavailable: ${message}`,
      advisoryUnavailable: true,
    };
  }
}

// ── Gate orchestration (used by merger/executor verification gates) ──────

export interface RunLlmReviewGateOptions {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  settings: Settings;
  /** Base ref for the diff range (e.g. the integration base or task.baseCommitSha). */
  baseRef?: string;
  taskTitle?: string;
  signal?: AbortSignal;
  /** Log label for store agent-log entries (e.g. "merger", "executor"). */
  agentLabel?: string;
  /** Test seam: inject mock agent deps. */
  deps?: LlmReviewAgentDeps;
  /** Test seam: override diff capture. */
  captureDiff?: (rootDir: string, baseRef: string | undefined, signal?: AbortSignal) => Promise<string>;
}

/**
 * Run the LLM-review verification step as part of a verification gate. Resolves
 * the mode from settings, runs the review when not "off", logs findings to the
 * task, and reports whether the gate should block. Returns `{ ran:false }` for
 * "off" so callers can treat the off-path as a no-op.
 *
 * This function NEVER throws on review failure — it returns `blocked` and lets
 * the caller decide how to surface a block (e.g. throw VerificationError).
 */
export async function runLlmReviewGate(options: RunLlmReviewGateOptions): Promise<LlmReviewGateResult> {
  const mode = resolveLlmReviewMode(options.settings);
  if (mode === "off") {
    return { mode, ran: false, verdict: null, blocked: false };
  }

  const label = options.agentLabel ?? "merger";
  await options.store.logEntry(options.taskId, `[verification] Running LLM diff review (${mode})`).catch(() => undefined);

  const capture = options.captureDiff ?? captureReviewDiff;
  const diff = await capture(options.rootDir, options.baseRef, options.signal);

  // Resolve the review model lane from the validator/reviewer lane when configured.
  // Falls back to createFnAgent's resolved defaults when the lane is unset.
  const hasValidatorLane = Boolean(options.settings.validatorProvider && options.settings.validatorModelId);
  const modelProvider = hasValidatorLane ? options.settings.validatorProvider : undefined;
  const modelId = hasValidatorLane ? options.settings.validatorModelId : undefined;

  const verdict = await runLlmReviewVerification({
    rootDir: options.rootDir,
    diff,
    taskId: options.taskId,
    taskTitle: options.taskTitle,
    modelProvider,
    modelId,
    signal: options.signal,
    deps: options.deps,
  });

  await logVerdict(options.store, options.taskId, mode, verdict, label);

  const { blocks, reason } = evaluateLlmReviewGate(mode, verdict);
  if (blocks && reason) {
    await options.store.logEntry(options.taskId, `[verification] LLM diff review BLOCKED merge: ${reason}`, "VerificationError").catch(() => undefined);
    await options.store.appendAgentLog(options.taskId, "LLM diff review failed", "tool_error", reason, label as never).catch(() => undefined);
  }

  return { mode, ran: true, verdict, blocked: blocks };
}

async function logVerdict(
  store: TaskStore,
  taskId: string,
  mode: LlmReviewMode,
  verdict: LlmReviewVerdict,
  label: string,
): Promise<void> {
  if (verdict.advisoryUnavailable) {
    await store.logEntry(taskId, `[verification] LLM diff review unavailable (non-blocking): ${verdict.summary}`).catch(() => undefined);
    await store.appendAgentLog(taskId, "LLM diff review unavailable", "text", verdict.summary, label as never).catch(() => undefined);
    return;
  }

  const findingLines = verdict.findings.length > 0
    ? verdict.findings.map((f) => `  • [${f.severity}] ${f.file}: ${f.summary}`).join("\n")
    : "  • (no findings)";
  const body = `[verification] LLM diff review (${mode}) — ${verdict.passed ? "passed" : "concerns found"}: ${verdict.summary}\n${findingLines}`;
  await store.logEntry(taskId, body).catch(() => undefined);
  await store.appendAgentLog(
    taskId,
    `LLM diff review ${verdict.passed ? "passed" : "found concerns"}`,
    verdict.passed ? "text" : "tool_result",
    findingLines,
    label as never,
  ).catch(() => undefined);
}
