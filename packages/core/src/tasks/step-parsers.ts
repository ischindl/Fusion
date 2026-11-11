/**
 * Step-parser registry (U12, KTD-12).
 *
 * Step parsing becomes a graph-native node (`parse-steps`): a registry resolves
 * a parser id to an implementation that reads an artifact's content and yields a
 * canonical step list. Built-ins:
 *   - `step-headings` — the extracted `parseStepsFromPrompt` logic (the
 *     `### Step N:` regex + `(depends: …)` annotation from U1), plus a bounded
 *     fallback for plain `### Heading` entries inside `## Steps`; legacy callers
 *     in `store.ts` delegate to this exact function.
 *   - `json-steps` — a structured `[{ name, depends? }]` JSON document for
 *     workflows that plan in JSON.
 *
 * The registry mirrors the trait-registry posture: built-ins are protected from
 * override, and plugins register under namespaced ids
 * (`plugin:<pluginId>:<parserId>`). This module is engine-free and must NOT
 * import `store.ts` (store imports the extracted parser from here).
 *
 * Parsers may throw on malformed input; callers (the engine's parse-steps
 * handler) map a throw to a routable `outcome:parse-error`.
 */

import type { TaskStep } from "../types.js";
import { maskGeneratedOriginalDescription } from "./original-description-region.js";

// ── Parser contract ──────────────────────────────────────────────────────────

/**
 * A parsed step as produced by a parser. `dependsOn` is always a 0-indexed
 * persisted document index. Prefix Markdown `(depends:)` tokens are authored heading
 * LABELS, translated to that index through the frame the plan numbered its headings in
 * (see `resolveStepHeadingLabelFrame`). Legacy title-suffix annotations use contiguous
 * authored heading labels too, but only for a fully ascending sequence.
 *
 * FNXC:WorkflowSteps 2026-06-29-17:55:
 * Parser output must preserve array presence: omitted `dependsOn` means legacy previous-step fallback, while explicit `dependsOn: []` means an independent parallel root.
 *
 * FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
 * The coordinate of a Markdown token used to be "1-based position in the parsed list", which is not
 * what authors write: a planner numbering headings from `### Step 0` writes the label it is looking
 * at, so every edge landed one step early and the immediately preceding step dropped out. Measured on
 * the live corpus (814 heading documents, 233 annotated), the label coordinate is the only one anyone
 * writes, so it is now authoritative and the position reading is gone.
 */
export interface ParsedStep {
  name: string;
  dependsOn?: number[];
}

/** The result of running a step parser over an artifact's content. */
export interface StepParseResult {
  steps: ParsedStep[];
}

/** A step parser. `parse` may throw on malformed input; the caller maps a throw
 *  to a routable parse-error outcome. */
export interface StepParser {
  id: string;
  parse(content: string): StepParseResult;
}

// ── Registration error ──────────────────────────────────────────────────────

/** Named reason codes for a rejected step-parser registration. */
export type StepParserRegistrationReason =
  | "duplicate-id"
  | "builtin-namespace-protected"
  | "invalid-id"
  | "invalid-definition";

export class StepParserRegistrationError extends Error {
  readonly reason: StepParserRegistrationReason;
  readonly parserId: string;
  constructor(reason: StepParserRegistrationReason, parserId: string, message: string) {
    super(message);
    this.name = "StepParserRegistrationError";
    this.reason = reason;
    this.parserId = parserId;
  }
}

// ── The registry ────────────────────────────────────────────────────────────

interface RegisteredParser {
  parser: StepParser;
  builtin: boolean;
}

/** Validate a plugin-namespaced parser id: `plugin:<pluginId>:<parserId>` with
 *  each segment a non-empty `[a-z0-9-]+` token. */
function isValidPluginParserId(id: string): boolean {
  const parts = id.split(":");
  if (parts.length !== 3) return false;
  if (parts[0] !== "plugin") return false;
  const seg = /^[a-z0-9-]+$/;
  return seg.test(parts[1]) && seg.test(parts[2]);
}

export class StepParserRegistry {
  private readonly parsers = new Map<string, RegisteredParser>();

  /** Register a parser. Built-in ids cannot be overridden by non-builtins; a
   *  non-builtin must use a `plugin:<pluginId>:<parserId>` id. */
  register(parser: StepParser, opts?: { builtin?: boolean }): void {
    const builtin = opts?.builtin ?? false;
    if (!parser || typeof parser.id !== "string" || parser.id === "") {
      throw new StepParserRegistrationError(
        "invalid-definition",
        String(parser?.id),
        "Step parser must have a non-empty string id",
      );
    }
    if (typeof parser.parse !== "function") {
      throw new StepParserRegistrationError(
        "invalid-definition",
        parser.id,
        `Step parser '${parser.id}' must have a parse() function`,
      );
    }

    // Existing-id checks first (built-in protection, then duplicate) so a
    // non-builtin trying to overwrite a built-in surfaces the protection reason
    // rather than the id-shape reason.
    const existing = this.parsers.get(parser.id);
    if (existing) {
      if (!builtin && existing.builtin) {
        throw new StepParserRegistrationError(
          "builtin-namespace-protected",
          parser.id,
          `Step parser id '${parser.id}' is a built-in parser and cannot be overridden by a non-builtin registration`,
        );
      }
      throw new StepParserRegistrationError(
        "duplicate-id",
        parser.id,
        `Step parser id '${parser.id}' is already registered`,
      );
    }

    if (!builtin && !isValidPluginParserId(parser.id)) {
      throw new StepParserRegistrationError(
        "invalid-id",
        parser.id,
        `Non-builtin step parser '${parser.id}' must use a namespaced id of the form 'plugin:<pluginId>:<parserId>'`,
      );
    }

    this.parsers.set(parser.id, { parser, builtin });
  }

  getParser(id: string): StepParser | undefined {
    return this.parsers.get(id)?.parser;
  }

  has(id: string): boolean {
    return this.parsers.has(id);
  }

  listParsers(): StepParser[] {
    return [...this.parsers.values()].map((r) => r.parser);
  }

  /** Remove a parser. Built-ins are never removed (callers should only pass
   *  plugin-namespaced ids — e.g. for plugin teardown). Returns true if a
   *  non-builtin parser was present and removed. */
  unregister(id: string): boolean {
    const existing = this.parsers.get(id);
    if (!existing || existing.builtin) return false;
    return this.parsers.delete(id);
  }
}

// ── Built-in: step-headings ───────────────────────────────────────────────────

/*
FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
The id of the parser that decides what a card's steps are. The read path (`parseStepsFromPrompt`),
the write path (`updateTask({ prompt })`), and the planning admission check must resolve THIS id, or
the board list and the durable document are reading two different rules and the divergence the reader
sees is the parser's, not the plan's.
*/
export const PROMPT_STEP_PARSER_ID = "step-headings";

/**
 * Parse `### Step N:` headings into the task step list (step-inversion U1).
 *
 * Backward compatibility is exact: an UNannotated heading parses byte-identically
 * to the legacy regex `^###\s+Step\s+\d+[^:]*:\s*(.+)$` (name = text after the
 * first colon, trimmed).
 *
 * FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
 * Prefix annotations `### Step N (depends: 1,2): Title` name the AUTHORED HEADING LABEL, so
 * `(depends: 4)` means "the heading that reads `### Step 4` in this same document". The parser reads
 * the numbering frame from the heading sequence and translates a label into the persisted 0-based
 * index; a token naming the step's own label denotes no prerequisite and collapses onto the preceding
 * step rather than refusing; numbering that cannot be read while a token needs it is a deterministic
 * `ambiguous-labels` refusal naming the annotated heading.
 * Legacy suffix annotations `### Step N: Title (depends: 0)` keep their own authored-label reading,
 * still restricted to a fully ascending sequence, and still refuse a self edge.
 * Both forms preserve an empty annotation as an explicit independent root and
 * validate every dependency before returning steps. Ambiguous or malformed input fails closed.
 */
export interface StepHeadingMatch {
  headingNumber: number;
  index: number;
  headingLineEnd: number;
  match: string;
}

/*
FNXC:WorkflowSteps 2026-09-05-22:06:
Every consumer deciding whether text is a step heading must use this matcher. A private stricter
matcher hid documented `(depends: …)` headings, causing false contiguity failures and empty step bodies.

FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
The scan runs over the document with the generated Original Description region MASKED, not over the
raw bytes. The verbatim operator-request body is quoted text: when it carries a previous generation
of the same plan, its `### Step N:` headings are evidence of what the operator once asked for, not
steps anyone may execute, and reading them produced exactly that — a card whose board list named
steps from the quoted generation. Masking (rather than stripping) keeps the byte length identical,
so every `index`/`headingLineEnd` handed back still addresses the caller's own content, which is
what the per-step session splitter and the review title extractor slice with. Unresolvable regions
stay unmasked on purpose: the conservative over-read beats silently losing authored steps, and the
integrity report is what surfaces the ambiguity.
*/
export function matchStepHeadings(content: string): StepHeadingMatch[] {
  const scanned = maskGeneratedOriginalDescription(content);
  const stepRegex = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
  const matches: StepHeadingMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = stepRegex.exec(scanned)) !== null) {
    const heading = /^###\s+Step\s+(\d+)/.exec(match[0]);
    if (!heading) continue;
    const index = match.index;
    const newline = scanned.indexOf("\n", index);
    matches.push({
      headingNumber: Number(heading[1]),
      index,
      headingLineEnd: newline === -1 ? scanned.length : newline,
      match: match[0],
    });
  }
  return matches;
}

export type StepDependencyCoordinate = "markdown-position" | "storage-index";
export type StepDependencyValidationReason = "malformed" | "zero" | "negative" | "duplicate" | "out-of-range" | "self-or-forward" | "cycle" | "ambiguous-labels";

/**
 * A stable, task-visible dependency refusal with the original bad token.
 *
 * FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
 * `frame` names which authored-heading frame a Markdown refusal was read in and `authoredLabels`
 * is the label sequence the document actually carries, so the message can tell an author which
 * numbering it read instead of only that the token was bad. Storage-index refusals carry neither,
 * because they are not about Markdown numbering at all.
 */
export class StepDependencyValidationError extends Error {
  readonly coordinate: StepDependencyCoordinate;
  readonly dependentPosition: number;
  readonly token: string | number;
  readonly reason: StepDependencyValidationReason;
  readonly stepCount: number;
  readonly frame?: StepHeadingLabelFrame["kind"];
  readonly authoredLabels?: number[];

  constructor(params: { coordinate: StepDependencyCoordinate; dependentPosition: number; token: string | number; reason: StepDependencyValidationReason; stepCount: number; frame?: StepHeadingLabelFrame["kind"]; authoredLabels?: number[] }) {
    const { coordinate, dependentPosition, token, reason, stepCount, frame, authoredLabels } = params;
    const displayed = coordinate === "markdown-position" ? token : Number(token) + 1;
    const prefix = `step ${dependentPosition} depends on`;
    const labelRange = authoredLabels && authoredLabels.length > 0
      ? `${Math.min(...authoredLabels)}-${Math.max(...authoredLabels)}`
      : undefined;
    const message = reason === "ambiguous-labels"
      ? `${prefix} unreadable heading numbering: annotated heading ${dependentPosition} carries \`(depends: ${token})\` but the authored step labels ${authoredLabels?.join(", ") ?? "(none)"} are neither contiguous from 0 nor from 1. Renumber contiguously from 0 or from 1, or remove the annotation.`
      : reason === "out-of-range" && labelRange
        ? `${prefix} out-of-range step ${displayed} (authored labels: ${labelRange})`
        : reason === "out-of-range"
          ? `${prefix} out-of-range step ${displayed} (valid positions: 1-${stepCount})`
          : `${prefix} invalid step ${displayed} (${reason})`;
    super(message);
    this.name = "StepDependencyValidationError";
    this.coordinate = coordinate;
    this.dependentPosition = dependentPosition;
    this.token = token;
    this.reason = reason;
    this.stepCount = stepCount;
    this.frame = frame;
    this.authoredLabels = authoredLabels;
  }
}

/** Validate persisted 0-based dependency edges without changing their coordinate system. */
export function validateStepDependencies(steps: readonly Pick<ParsedStep, "dependsOn">[]): void {
  const visit = (index: number, visiting: Set<number>, visited: Set<number>): void => {
    if (visiting.has(index)) {
      throw new StepDependencyValidationError({ coordinate: "storage-index", dependentPosition: index + 1, token: index, reason: "cycle", stepCount: steps.length });
    }
    if (visited.has(index)) return;
    visiting.add(index);
    const deps = steps[index]?.dependsOn;
    if (Array.isArray(deps)) {
      const seen = new Set<number>();
      for (const dependency of deps) {
        const base = { coordinate: "storage-index" as const, dependentPosition: index + 1, token: dependency, stepCount: steps.length };
        if (!Number.isInteger(dependency)) throw new StepDependencyValidationError({ ...base, reason: "malformed" });
        if (dependency < 0) throw new StepDependencyValidationError({ ...base, reason: "negative" });
        if (dependency >= steps.length) throw new StepDependencyValidationError({ ...base, reason: "out-of-range" });
        if (seen.has(dependency)) throw new StepDependencyValidationError({ ...base, reason: "duplicate" });
        /*
        FNXC:StepDependencyValidation 2026-10-01-02:31:
        Persisted and plugin parser edges use 0-based storage indexes, but each prerequisite must
        precede its dependent. Reject a future or self edge before DFS so foreach never schedules
        a step before an invalid prerequisite, even when the graph is not cyclic.
        */
        if (dependency >= index) throw new StepDependencyValidationError({ ...base, reason: "self-or-forward" });
        seen.add(dependency);
        if (visiting.has(dependency)) throw new StepDependencyValidationError({ ...base, reason: "cycle" });
        visit(dependency, visiting, visited);
      }
    }
    visiting.delete(index);
    visited.add(index);
  };
  const visited = new Set<number>();
  for (let index = 0; index < steps.length; index++) visit(index, new Set(), visited);
}

/*
FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
The one source a card's step list is derived from: line endings normalized, then the generated
Original Description region masked. `canonicalizePlan`, the plan-approval fingerprint, and this
function must look at the SAME document, otherwise the board's list and the plan the reviewer
approved are two different readings of one file — which is the RUFU-536 symptom (a card showing the
previous generation's step names while its durable document described the current one). Line-ending
normalization is safe here and nowhere else: this function returns names and dependency edges, never
offsets, while `matchStepHeadings` callers slice the caller's own bytes and may not be handed
offsets into a rewritten copy.
*/
function authoredStepSource(content: string): string {
  return maskGeneratedOriginalDescription(content.replace(/\r\n?/g, "\n"));
}

export function parseStepHeadings(content: string): TaskStep[] {
  const source = authoredStepSource(content);
  const annotatedRegex = /^###\s+Step\s+\d+\s*\(depends:\s*([^)]*)\)\s*:\s*([^\n]+)$/;
  const suffixRegex = /^###\s+Step\s+\d+\s*:\s*(.+?)\s+\(depends:\s*([^)]*)\)\s*$/;
  const matches = matchStepHeadings(source);
  /*
  FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
  A `(depends:)` token is a heading LABEL, so the document's numbering frame has to be read before any
  token is translated. `labelToIndex` does the translation; for the contiguous ascending sequences every
  planner writes it is identical to `label - frame.offset`, and for an unordered-but-contiguous sequence
  it still names the step the author pointed at. The suffix form keeps its stricter pre-existing gate:
  an exact ascending sequence from 0 or from 1 in DOCUMENT order, which is the frame plus ascending order,
  so a suffix annotation in a non-contiguous document is still refused exactly as before. The labels are
  read from RUFU-536's masked source, so a prior generation of the plan quoted inside the generated
  Original Description region contributes neither a frame entry nor a token target.
  */
  const frame = resolveStepHeadingLabelFrame(matches.map((entry) => entry.headingNumber));
  const authoredLabels = matches.map((entry) => entry.headingNumber).sort((a, b) => a - b);
  const labelToIndex = new Map<number, number>();
  matches.forEach((entry, index) => {
    if (!labelToIndex.has(entry.headingNumber)) labelToIndex.set(entry.headingNumber, index);
  });
  const unambiguousLegacyLabels = frame.kind !== "ambiguous"
    && matches.every((entry, index) => entry.headingNumber === index + frame.offset);
  const steps: TaskStep[] = [];
  const pendingDependencies: Array<{ position: number; raw: string; form: "prefix" | "suffix" } | undefined> = [];
  // The first prefix annotation that actually carries a token. An empty `(depends:)` states an
  // independent root and needs no coordinate, so it never forces the document's numbering to be readable.
  let tokenBearingAnnotation: { position: number; raw: string } | undefined;

  for (const entry of matches) {
    const annotated = annotatedRegex.exec(entry.match);
    const suffix = suffixRegex.exec(entry.match);
    const annotations = entry.match.split("(depends:").length - 1;
    if (annotations > 1 || (annotations > 0 && !annotated && !suffix)
      || (suffix && !unambiguousLegacyLabels)) {
      throw new StepDependencyValidationError({ coordinate: "markdown-position", dependentPosition: steps.length + 1, token: entry.match, reason: "malformed", stepCount: matches.length });
    }
    const name = annotated?.[2] ?? suffix?.[1] ?? /^###\s+Step\s+\d+[^:]*:\s*(.+)$/m.exec(entry.match)?.[1] ?? "";
    steps.push({ name: name.trim(), status: "pending" });
    if (annotated) {
      pendingDependencies.push({ position: steps.length, raw: annotated[1], form: "prefix" });
      if (!tokenBearingAnnotation && annotated[1].trim() !== "") tokenBearingAnnotation = { position: steps.length, raw: annotated[1].trim() };
    } else {
      pendingDependencies.push(suffix ? { position: steps.length, raw: suffix[2], form: "suffix" } : undefined);
    }
  }
  if (steps.length > 0) {
    if (tokenBearingAnnotation && frame.kind === "ambiguous") {
      throw new StepDependencyValidationError({
        coordinate: "markdown-position",
        dependentPosition: tokenBearingAnnotation.position,
        token: tokenBearingAnnotation.raw,
        reason: "ambiguous-labels",
        stepCount: steps.length,
        frame: "ambiguous",
        authoredLabels,
      });
    }
    for (const pending of pendingDependencies) {
      if (!pending) continue;
      const raw = pending.raw.trim();
      const ownIndex = pending.position - 1;
      if (raw === "") { steps[ownIndex]!.dependsOn = []; continue; }
      const seen = new Set<number>();
      const dependencies = new Set<number>();
      for (const token of raw.split(",").map((value) => value.trim())) {
        const base = { coordinate: "markdown-position" as const, dependentPosition: pending.position, token, stepCount: steps.length, frame: frame.kind, authoredLabels };
        if (!/^-?\d+$/.test(token)) throw new StepDependencyValidationError({ ...base, reason: "malformed" });
        const value = Number(token);
        if (value < 0) throw new StepDependencyValidationError({ ...base, reason: "negative" });
        // A token of 0 has no heading to name only in the legacy fully-1-based frame; in a document
        // numbered from 0 it is the canonical name for the Preflight step.
        if (value === 0 && frame.kind === "fully-1-based") throw new StepDependencyValidationError({ ...base, reason: "zero" });
        const dependency = labelToIndex.get(value);
        if (dependency === undefined) throw new StepDependencyValidationError({ ...base, reason: "out-of-range" });
        if (seen.has(value)) throw new StepDependencyValidationError({ ...base, reason: "duplicate" });
        seen.add(value);
        /*
        FNXC:StepDependencyValidation 2026-11-11-08:26 (RUFU-545):
        The prefix form's degenerate self token - `(depends: 8)` on `### Step 8` - denotes no
        prerequisite at all, it is the redundant-boilerplate shape a planner writes when it copies the
        step it is looking at. Refusing it would break real cards over a token carrying no information:
        measured on the live corpus it appears on 44 headings across 16 specs, including all eight
        annotated headings of RUFU-328. It therefore collapses onto the immediately preceding step and
        that edge is PERSISTED EXPLICITLY, never left absent, because merge-queue-ops.ts applies its
        completion guard for a non-graph writer only when `dependsOn` is an array - an absent value
        would delete the guard. At index 0 there is no predecessor, so the token contributes nothing.
        The suffix form keeps refusing its own label: that is its documented contract, unchanged here.
        */
        if (pending.form === "prefix" && dependency === ownIndex) {
          if (ownIndex > 0) dependencies.add(ownIndex - 1);
          continue;
        }
        if (dependency >= ownIndex) throw new StepDependencyValidationError({ ...base, reason: "self-or-forward" });
        dependencies.add(dependency);
      }
      steps[ownIndex]!.dependsOn = [...dependencies];
    }
    validateStepDependencies(steps);
    return steps;
  }

  const stepsSection = extractStepsSection(source);
  if (!stepsSection) return steps;
  const plainHeadingRegex = /^###\s+(?!Step\s+\d+\b)(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = plainHeadingRegex.exec(stepsSection)) !== null) {
    const name = match[1].trim();
    if (name) steps.push({ name, status: "pending" });
  }
  return steps;
}

/*
FNXC:WorkflowSteps 2026-06-30-00:54:
Default Coding parses PROMPT.md before step execution. FN-7260/FN-7271 specs used plain `### Preflight`
/ `### Implementation` headings under `## Steps`; the previous parser returned zero steps, so
fast-mode tasks reached merge with no implementation session. Accept plain third-level headings only
inside the Steps section, and only when no legacy `### Step N:` headings were found, so unrelated spec
sections do not become executable work.

FNXC:StepSingleSource 2026-11-11-07:05 (RUFU-536):
Receives the masked, line-ending-normalized source, so a `## Steps` heading quoted inside the
operator-request region cannot become the section boundary either. Without the mask this fallback
reads the quoted generation's plain headings whenever a fenced region precedes the real section.
*/
function extractStepsSection(content: string): string | undefined {
  const sectionMatch = /^##\s+Steps\s*$/gim.exec(content);
  if (!sectionMatch) return undefined;
  const start = sectionMatch.index + sectionMatch[0].length;
  const rest = content.slice(start);
  const nextSection = /^##\s+(?!#)/gm.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

/*
FNXC:StepDependencyValidation 2026-11-11-08:26:
RUFU-545 makes the authored heading LABEL the authoritative coordinate of a Markdown
`(depends:)` annotation, which requires the parser to know which frame a plan numbered its
headings in before it can translate a token. This is that single decision, and every consumer
of an authored-heading offset reads it from here: the Markdown annotation path (see
`parseStepHeadings`) and file-scope normalization (`normalizeAuthoredStepScopes` in
`packages/engine/src/execution/step-session-executor.ts`) must never hold two opinions about
the same heading sequence, or a step's dependency edge and its declared file scope can drift
onto different steps. An empty sequence is `ambiguous` on purpose - there is no frame to read
and no annotation to translate.
*/
export type StepHeadingLabelFrame =
  | { kind: "zero-based"; offset: 0 }
  | { kind: "fully-1-based"; offset: 1 }
  | { kind: "ambiguous"; sortedLabels: number[] };

/** Classify an authored `### Step N` label sequence. Exactly `0..n-1` is the canonical
 *  zero-based frame, exactly `1..n` is the legacy fully-1-based frame, and anything else
 *  (gaps, duplicates, wild labels, empty) cannot be read as a frame at all. */
export function resolveStepHeadingLabelFrame(headingNumbers: readonly number[]): StepHeadingLabelFrame {
  const sortedLabels = [...headingNumbers].sort((a, b) => a - b);
  const count = sortedLabels.length;
  if (count > 0 && sortedLabels.every((label, index) => label === index)) {
    return { kind: "zero-based", offset: 0 };
  }
  if (count > 0 && sortedLabels.every((label, index) => label === index + 1)) {
    return { kind: "fully-1-based", offset: 1 };
  }
  return { kind: "ambiguous", sortedLabels };
}

/*
FNXC:WorkflowStepControl 2026-09-04-01:38:
PROMPT.md is model-authored, but its heading numbers are execution indices. A fully 1-based run
previously produced a phantom step at steps.length, so only that unambiguous legacy sequence rebases.

FNXC:WorkflowSteps 2026-09-04-02:57:
Headings, file scopes, and dependency annotations must share one authored-heading offset rule so
canonical 0-based plans and preserved fully-1-based legacy plans cannot drift between packages.

FNXC:StepDependencyValidation 2026-11-11-08:26:
RUFU-545 keeps this export's public behaviour byte-identical (`1` only for an exact `1..n`
sequence, `0` otherwise, including an ambiguous sequence) and makes it a delegate over
`resolveStepHeadingLabelFrame`, so scope normalization and annotation translation cannot drift.
An ambiguous frame contributes offset 0 here exactly as it did before the extraction.
*/
export function resolveAuthoredStepHeadingOffset(headingNumbers: readonly number[]): 0 | 1 {
  return resolveStepHeadingLabelFrame(headingNumbers).kind === "fully-1-based" ? 1 : 0;
}

// ── Built-in: json-steps ──────────────────────────────────────────────────────

/**
 * Parse a JSON document: an array of `{ name: string, depends?: number[] }`.
 * `depends` values are 0-indexed document indices (deduped, sorted). Omitted
 * `depends` means implicit previous-step dependency; explicit
 * `depends: []` is preserved as no dependencies. Throws a descriptive error on
 * any malformed input (not JSON, not an array, missing/blank name, bad depends).
 */
export function parseJsonSteps(content: string): StepParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `json-steps: content is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(doc)) {
    throw new Error("json-steps: document must be a JSON array of step objects");
  }

  const steps: ParsedStep[] = [];
  doc.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`json-steps: step at index ${i} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        `json-steps: step at index ${i} must have a non-empty string 'name'`,
      );
    }

    const step: ParsedStep = { name: name.trim() };

    if (obj.depends !== undefined) {
      if (!Array.isArray(obj.depends)) {
        throw new Error(
          `json-steps: step at index ${i} 'depends' must be an array of 0-based document indices`,
        );
      }
      for (const raw of obj.depends) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
          throw new Error(
            `json-steps: step at index ${i} 'depends' must contain only 0-based document indices; got ${JSON.stringify(raw)}`,
          );
        }
      }
      step.dependsOn = [...obj.depends] as number[];
    }

    steps.push(step);
  });

  validateStepDependencies(steps);
  return { steps };
}

// ── Built-in parser definitions ───────────────────────────────────────────────

const BUILTIN_STEP_PARSERS: StepParser[] = [
  {
    id: PROMPT_STEP_PARSER_ID,
    parse(content: string): StepParseResult {
      // The headings parser yields TaskStep[]; map to the parser contract
      // (dropping the `status` field, which the caller re-applies).
      const steps = parseStepHeadings(content).map((s) => {
        const out: ParsedStep = { name: s.name };
        if (Array.isArray(s.dependsOn)) out.dependsOn = s.dependsOn;
        return out;
      });
      return { steps };
    },
  },
  {
    id: "json-steps",
    parse: parseJsonSteps,
  },
];

/** Register the built-in step parsers into the given registry (defaults to the
 *  shared registry). Idempotent via `has`. */
export function registerBuiltinStepParsers(
  registry: StepParserRegistry = getStepParserRegistry(),
): void {
  for (const parser of BUILTIN_STEP_PARSERS) {
    if (registry.has(parser.id)) continue;
    registry.register(parser, { builtin: true });
  }
}

// ── Module-level default registry ───────────────────────────────────────────

let defaultRegistry: StepParserRegistry | undefined;

export function getStepParserRegistry(): StepParserRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new StepParserRegistry();
    registerBuiltinStepParsers(defaultRegistry);
  }
  return defaultRegistry;
}

/** Test-only: reset the shared registry (so built-in registration can be
 *  re-exercised in isolation). */
export function __resetStepParserRegistryForTests(): void {
  defaultRegistry = undefined;
}

// ── Convenience pass-throughs to the default registry ────────────────────────

export function registerStepParser(parser: StepParser, opts?: { builtin?: boolean }): void {
  getStepParserRegistry().register(parser, opts);
}

export function getStepParser(id: string): StepParser | undefined {
  return getStepParserRegistry().getParser(id);
}

export function listStepParsers(): StepParser[] {
  return getStepParserRegistry().listParsers();
}

export function unregisterStepParser(id: string): boolean {
  return getStepParserRegistry().unregister(id);
}

// Register built-ins into the shared registry on import (idempotent via `has`).
registerBuiltinStepParsers();
