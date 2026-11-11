export type FileScopeClassificationReason =
  | "included-write-scope"
  | "invalid-entry"
  | "duplicate-entry"
  | "read-only-context"
  | "forbidden-or-non-goal"
  | "wrong-worktree-safeguard"
  | "route-or-action"
  | "fusion-metadata-evidence"
  | "generated-lock"
  | "conditional-changeset";

export interface FileScopeClassificationEntry {
  token: string;
  included: boolean;
  reason: FileScopeClassificationReason;
  line: string;
}

export interface FileScopeClassificationResult {
  entries: FileScopeClassificationEntry[];
  effectiveWriteScope: string[];
}

/*
FNXC:FileScopeClassification 2026-06-25-04:34:
Task File Scope is operator intent, not every path-like token in PROMPT.md. Keep this classifier conservative so read-only evidence, wrong-worktree safeguards, generated locks, route names, and conditional changesets do not create false write-scope leases or file-scope merge guards.

FNXC:FileScopeClassification 2026-07-21-12:00:
Root-level repo files with letter-leading extensions (global.json, Directory.Packages.props, MyApp.slnx, tsconfig.json, .env) are valid File Scope entries. Requiring a slash rejected them, which failed GitHub imports whose issue bodies declare those paths and dropped them from extractEffectiveWriteScopeFromPrompt. Still reject bare identifiers (main, todo) and version-like tokens (v1.2.3) via the letter-leading final-extension rule. Extensionless well-known roots (Makefile, Dockerfile) stay on the explicit allowlist.

FNXC:FileScopeClassification 2026-07-21-18:05:
Ignore `## File Scope` headings inside fenced code blocks. GitHub issue bodies (and other freeform descriptions) often embed repro snippets that contain that heading plus escaped backticks (e.g. \`global.json\`); treating those as real scope tokens made createTask throw InvalidFileScopeError on import and misclassified write scope.
*/
const KNOWN_FILE_SCOPE_ROOT_FILES = new Set([
  "makefile",
  "dockerfile",
  "justfile",
  "license",
  "readme",
  "changelog",
  "agents.md",
  "project.yml",
  "package.json",
  "pnpm-lock.yaml",
]);

/** Final segment ends with a letter-leading extension (.json, .props, .slnx, .env). */
const FILE_EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]*$/;

const INCLUDE_CONTEXT_RE = /\b(expected|touched|touch|modify|modified|write|writes|implementation|must update|artifacts?|files? changed|source paths?)\b/i;
const EXCLUDE_CONTEXT_RE = /\b(forbidden|non-goals?|out of scope|do not edit|do not modify|must not edit|must not modify|do not hand-edit|hand-edit|read-only|context to read|evidence only|metadata|wrong[- ]worktree|safeguards?)\b/i;
const GENERATED_CONTEXT_RE = /\b(generated|lockfiles?|locks?)\b/i;
const CONDITIONAL_CONTEXT_RE = /\b(conditional|only if|if .*changes|if .*changed|expected if|required only if|unless)\b/i;
const ROUTE_OR_ACTION_RE = /^(?:\/[A-Za-z0-9:_*?./-]+|fn_task_[A-Za-z0-9_]+|review|merge|retry|archive)$/i;

export function isValidFileScopeEntry(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("origin/")
    || lower.startsWith("upstream/")
    || lower.startsWith("refs/")
    || /^https?:\/\//i.test(trimmed)
    || /^git@/i.test(trimmed)
    || /^ssh:\/\//i.test(trimmed)
    || /^[a-z]+\/fn-\d+$/i.test(trimmed)
    || /^[a-f0-9]{7,}$/i.test(trimmed)
    || trimmed.includes("..")
    || trimmed.startsWith("/")
  ) {
    return false;
  }

  const segments = trimmed.split("/");
  const lastSegment = segments[segments.length - 1] ?? "";
  const hasDotInLastSegment = lastSegment.includes(".");

  if (KNOWN_FILE_SCOPE_ROOT_FILES.has(lastSegment.toLowerCase())) {
    return true;
  }

  if (trimmed.includes("**") || trimmed.endsWith("/*") || (lastSegment.includes("*") && hasDotInLastSegment)) {
    return true;
  }

  // Nested (`src/MyApp/Program.cs`) or root-level (`global.json`, `Directory.Packages.props`) files.
  if (hasDotInLastSegment && FILE_EXTENSION_RE.test(lastSegment)) {
    return true;
  }

  return false;
}

/*
FNXC:FileScopeClassification 2026-11-11-16:03 (RUFU-494):
One rule for the whole harvest: a File Scope line contributes AT MOST ONE candidate entry - the
backtick span that BEGINS the line's content, after optional indentation and an optional bullet
marker (`-`, `*`, `+`, or a numbered `1.` / `1)`). Every other backtick span on that line, and every
backtick span on a line whose first backtick does not open the content (`Note: returns \`rerouted\`
when held.`), is an ANNOTATION: commentary, never a scope entry.

Why: spec hygiene encourages annotated bullets, e.g.
`- \`packages/engine/src/merge/workspace-review-reroute.ts\` (returns an object literal with a
\`rerouted\` false branch)`. The previous whole-section scan harvested `rerouted` as a scope entry,
`isValidFileScopeEntry` refused it, and all three `InvalidFileScopeError` throw sites rejected a
valid spec - including `fn_task_prompt_write`, the only path the planner had to repair it (RUFU-490
lost one of three planning passes that way). This narrows the harvest only: an invalid LEADING
candidate (`origin/main`, `HEAD`, a bare `rerouted`) still classifies `invalid-entry` and still
refuses, so conservatism is preserved and acceptance is not widened one bit.

Exported because `sanitizeFileScopeInPromptContent` must apply the same rule to the same lines -
validation, classification, and sanitize may not hold three opinions about what a bullet declares.
*/
const LEADING_CANDIDATE_RE = /^\s*(?:[-*+]|\d+[.)])?\s*`([^`]+)`/;

/** The one candidate a File Scope line declares, or null when the line is prose/context/annotation. */
export function extractLeadingFileScopeCandidate(line: string): string | null {
  const token = LEADING_CANDIDATE_RE.exec(line)?.[1]?.trim();
  return token ? token : null;
}

/**
 * Walk a section body once, yielding each line with its candidate, and suppress candidates for
 * lines inside a fenced block (same "repro snippets are documentation, not data" intent that keeps
 * fenced `## File Scope` headings out of `locateFileScopeSection`, FNXC 2026-07-21-18:05).
 *
 * Exported for `sanitizeFileScopeInPromptContent`: sanitize must see the same line/candidate pairs
 * the validator saw, or the two disagree about which line a refusal belongs to and the sanitizer
 * deletes the wrong bullet.
 */
export function* iterateFileScopeSectionLines(section: string): Generator<{ line: string; candidate: string | null }> {
  let inFence = false;
  for (const line of section.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      yield { line, candidate: null };
      continue;
    }
    yield { line, candidate: inFence ? null : extractLeadingFileScopeCandidate(line) };
  }
}

export function extractFileScopeTokens(content: string): string[] {
  const section = extractFileScopeSection(content);
  if (!section) return [];
  const tokens: string[] = [];
  for (const { candidate } of iterateFileScopeSectionLines(section)) {
    if (candidate !== null) tokens.push(candidate);
  }
  return tokens;
}

export function extractEffectiveWriteScopeFromPrompt(content: string): string[] {
  return classifyFileScopeFromPrompt(content).effectiveWriteScope;
}

export function classifyFileScopeFromPrompt(content: string): FileScopeClassificationResult {
  /*
  FNXC:FileScopeClassification 2026-06-25-04:34:
  Context headings inside `## File Scope` change the meaning of backticked tokens. The state machine is line-oriented on purpose: execution specs often mix write targets with forbidden paths and evidence-only metadata in the same section.
  */
  const section = extractFileScopeSection(content);
  if (!section) return { entries: [], effectiveWriteScope: [] };

  const entries: FileScopeClassificationEntry[] = [];
  const effectiveWriteScope: string[] = [];
  const seen = new Set<string>();
  let context: "include" | "exclude" | "conditional" = "include";

  /*
  FNXC:FileScopeClassification 2026-11-11-16:03 (RUFU-494):
  The per-line harvest now goes through the same leading-candidate extractor that validation uses, so
  classification and validation cannot drift (FNXC 2026-07-21-19:00 contract) and an inline annotation
  can never surface as an `invalid-entry` or pollute `effectiveWriteScope`. The include/exclude/
  conditional state machine below is deliberately unchanged: it still reads every line, annotations
  included, because a line's prose is exactly what tells the classifier which context its ONE
  declared entry belongs to. Fenced lines keep their context effect but declare nothing.
  */
  for (const { line: rawLine, candidate } of iterateFileScopeSectionLines(section)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (INCLUDE_CONTEXT_RE.test(line) && !EXCLUDE_CONTEXT_RE.test(line) && !CONDITIONAL_CONTEXT_RE.test(line)) {
      context = "include";
    }
    if (EXCLUDE_CONTEXT_RE.test(line)) {
      context = "exclude";
    }
    if (CONDITIONAL_CONTEXT_RE.test(line)) {
      context = "conditional";
    }

    if (candidate === null) continue;
    const token = candidate;
    const reason = classifyToken(token, line, context);
    if (reason !== "included-write-scope") {
      entries.push({ token, included: false, reason, line });
      continue;
    }
    if (seen.has(token)) {
      entries.push({ token, included: false, reason: "duplicate-entry", line });
      continue;
    }
    seen.add(token);
    effectiveWriteScope.push(token);
    entries.push({ token, included: true, reason, line });
  }

  return { entries, effectiveWriteScope };
}

function classifyToken(
  token: string,
  line: string,
  context: "include" | "exclude" | "conditional",
): FileScopeClassificationReason {
  /*
  FNXC:FileScopeClassification 2026-06-25-04:34:
  Classification reasons must be stable enough for diagnostics while the include/exclude decision stays binary. Preserve specific exclusion reasons after validation so review/spec gates explain why a token was ignored instead of silently shrinking File Scope.
  */
  if (ROUTE_OR_ACTION_RE.test(token)) return "route-or-action";
  if (!isValidFileScopeEntry(token)) return "invalid-entry";

  const lowerToken = token.toLowerCase();
  const lowerLine = line.toLowerCase();
  if (lowerToken.startsWith(".fusion/") || lowerToken === ".fusion") return "fusion-metadata-evidence";
  if (/^packages\/[^/]+\/package\.resolved$/i.test(token) || /^packages\/\*\/package\.resolved$/i.test(token)) {
    return "generated-lock";
  }
  if (lowerToken.startsWith(".changeset/") && (context === "conditional" || CONDITIONAL_CONTEXT_RE.test(line))) {
    return "conditional-changeset";
  }
  if (context === "conditional") return "read-only-context";
  if (context === "exclude") {
    if (lowerLine.includes("wrong-worktree") || lowerLine.includes("wrong worktree") || lowerLine.includes("safeguard")) {
      return "wrong-worktree-safeguard";
    }
    if (lowerLine.includes("forbidden") || lowerLine.includes("non-goal") || lowerLine.includes("do not edit") || lowerLine.includes("do not modify")) {
      return "forbidden-or-non-goal";
    }
    return "read-only-context";
  }
  if (GENERATED_CONTEXT_RE.test(line) && lowerToken.endsWith("package.resolved")) return "generated-lock";
  return "included-write-scope";
}

/**
 * Locate the operator-declared `## File Scope` section, skipping fenced code blocks
 * so documentation/repro samples (GitHub issues, unit-test snippets) are not treated as scope.
 */
export function locateFileScopeSection(content: string): {
  headingStart: number;
  sectionStart: number;
  sectionEnd: number;
} | null {
  let inFence = false;
  let offset = 0;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineStart = offset;
    const nextOffset = offset + line.length + (i < lines.length - 1 ? 1 : 0);

    if (/^```/.test(line)) {
      inFence = !inFence;
      offset = nextOffset;
      continue;
    }

    if (!inFence && /^##\s+File\s+Scope\s*$/.test(line)) {
      const sectionStart = nextOffset;
      let sectionEnd = content.length;
      let scanOffset = sectionStart;
      let scanInFence = false;

      for (let j = i + 1; j < lines.length; j++) {
        const scanLine = lines[j] ?? "";
        const scanLineStart = scanOffset;
        scanOffset += scanLine.length + (j < lines.length - 1 ? 1 : 0);

        if (/^```/.test(scanLine)) {
          scanInFence = !scanInFence;
          continue;
        }
        if (!scanInFence && /^#{1,2}\s/.test(scanLine)) {
          sectionEnd = scanLineStart;
          break;
        }
      }

      return { headingStart: lineStart, sectionStart, sectionEnd };
    }

    offset = nextOffset;
  }

  return null;
}

function extractFileScopeSection(content: string): string | null {
  const located = locateFileScopeSection(content);
  if (!located) return null;
  return content.slice(located.sectionStart, located.sectionEnd);
}

/*
FNXC:FileScopeClassification 2026-11-11-16:03 (RUFU-494):
`extractBacktickedTokens` (a whole-text `/`([^`]+)`/g` scan) is DELETED here on purpose. It had zero
callers once validation, classification, and sanitize moved to `extractLeadingFileScopeCandidate`,
and a surviving caller-less wide scanner is exactly the seam someone re-widens from.
*/
