import { extractEffectiveWriteScopeFromPrompt, parsePlanPremises, type PlanPremise } from "@fusion/core";

/*
FNXC:PlanPremiseAuthoring 2026-11-18-06:36 (RUFU-727 Step 5):
An ABSENCE premise (`text-absent`, `file-absent`) states that something is NOT in the repository at the
card's evaluated commit. A card whose own File Scope promises to write that path will, if it succeeds,
create exactly the state its premise forbids — the premise is self-consuming, and no re-plan can fix it,
because the plan is right about the present and wrong about the future. RUFU-698 is the measured case: its
deliverable introduced the marker `rotated-deferred` in `hold-release.ts` while its premise declared that
literal absent, so landing the work necessarily falsified the gate that guards the work.

That shape is deterministically detectable at authoring time from the two sections alone: the premise's
`path` and the card's effective write scope. It was not detected, so it surfaced at the release door,
where the consequences are the expensive ones — the falsifier scan walks up to `FALSIFIER_SCAN` pickaxe
candidates per premise (measured 2026-11-18: 0.114 s for a rare literal in a hot file, 0.513 s for a common
literal in this repository's largest source file), and the verdict it produces,
`premise-invalidated-by-delivery`, is a card that finished its work and cannot be released while its own
delivery is attached. Refusing at Plan Review costs a string comparison.

FNXC:PlanValidation 2026-10-01 (boundary respected, RUFU-727):
`TriageProcessor.validateGeneratedPrompt` deliberately stays unchanged. That seam validates the PLAN
ARTIFACT's shape at generation time (sections present, premises parseable, external-integration evidence
cited) and its failure mode is a regenerated spec inside the planning session; it has no access to the
effective write-scope classification and no lifecycle authority. This rule is a CROSS-SECTION contradiction
between `## Plan Premises` and `## File Scope` whose remedy is a revision request, so it belongs in the
Plan Review node beside the other deterministic gate (`external-integration-evidence.ts`), which is what
reaches the graph's plan-replan loop and charges no reviewer call or review-revision budget.
*/

/** The premise kinds that forbid content rather than requiring it. */
/** The premise kinds that forbid content rather than requiring it: `file-absent`, or a `text-absent` literal. */
function isAbsenceKind(kind: PlanPremise["kind"]): kind is "text-absent" | "file-absent" {
  return kind === "text-absent" || kind === "file-absent";
}

export interface SelfConsumingPremiseFinding {
  /** The premise exactly as authored, serialised for the diagnostic. */
  readonly premise: string;
  readonly kind: "text-absent" | "file-absent";
  readonly path: string;
  /** Present only for a `text-absent` premise: the literal the card is forbidding. */
  readonly literal?: string;
  /** The declaration that makes this path a write target of the same card, as it reads in the spec. */
  readonly writeScopeEntry: string;
  /** True when the declaration is a `(new)` artifact line rather than a `## File Scope` entry. */
  readonly declaredAsNewArtifact?: boolean;
}

/** The prompt the shape gate reads. Shaped as one input object so a caller can pass the same
 *  `{ promptContent }` record it already builds for the sibling evidence gate. */
export interface SelfConsumingPremiseInput {
  promptContent: string;
}

/**
 * Cross-platform path boundary: canonicalize separators before any comparison, the same normalization
 * `packages/core/src/planner/spec-lock.ts` applies to the File Scope section
 * (`value.replace(/\\/g, "/")`) — "File Scope is a cross-platform boundary". A Windows-authored spec that
 * writes `src\openapi\x.ts` must not slip past a premise about `src/openapi/x.ts`.
 */
function canonicalPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Turn one write-scope declaration into a matcher over a premise path.
 *
 * Conservative in the direction that matters: a false positive refuses a plan that was fine, in a gate that
 * runs before any reviewer sees it. Three shapes match and nothing else does — an exact path, a `dir/`
 * prefix, and a `*` / `**` / `?` glob. Substring containment deliberately does not, so a declared
 * `src/App.tsx` cannot swallow a premise about `src/App.helpers.ts`.
 *
 * Entries arrive verbatim from `extractEffectiveWriteScopeFromPrompt`, the ONE write-scope authority: globs
 * come through as written and a bare `dir/` line is not a valid File Scope entry at all, so the prefix
 * branch is defence for a caller that passes one rather than a path this gate takes today.
 */
function writeScopeMatcher(entry: string): (path: string) => boolean {
  const normalized = canonicalPath(entry);
  if (normalized.length === 0) return () => false;
  if (!/[*?]/.test(normalized)) {
    return normalized.endsWith("/")
      ? (path) => path.startsWith(normalized)
      : (path) => path === normalized;
  }
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      const crossesSeparator = normalized[index + 1] === "*";
      while (normalized[index + 1] === "*") index += 1;
      pattern += crossesSeparator ? "[^/]*(?:/[^/]*)*" : "[^/]*";
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const anchored = new RegExp(`^${pattern}$`);
  return (path) => anchored.test(path);
}

/*
FNXC:PlanPremiseAuthoring 2026-11-18-06:36 (RUFU-727 Step 5):
A spec may also declare a path it creates by naming it a `(new)` artifact — "- `path` (new)" in an
`**Artifacts:**` list. That declaration is a promise to write the path just as loudly as a File Scope
entry is, and `extractEffectiveWriteScopeFromPrompt` does not read artifact lines, so the artifact form has
to be harvested here or a `file-absent` premise over a path the plan itself says it will create passes the
gate. Fenced blocks are skipped for the same reason the classifier skips them: a repro snippet is
documentation, not a declaration.
*/
const NEW_ARTIFACT_LINE = /^\s*[-*]\s*`?([A-Za-z0-9._@/-]+)`?\s*\(new\)\s*$/i;

function harvestDeclaredNewArtifacts(promptContent: string): string[] {
  const artifacts: string[] = [];
  let insideFence = false;
  for (const line of promptContent.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const match = NEW_ARTIFACT_LINE.exec(line);
    if (match?.[1]) artifacts.push(match[1]);
  }
  return artifacts;
}

/**
 * Find every absence premise whose path this same card promises to write, either in `## File Scope` or as a
 * `(new)` artifact.
 *
 * Returns no findings — and so refuses nothing — when the premise set cannot be parsed. This gate refuses
 * exactly one provably self-contradictory shape, and a spec it cannot read is not that shape: a malformed
 * `## Plan Premises` section is `plan-premise-invalid`'s subject at the release door, not a revision
 * request from here. An empty write scope is likewise no finding: a card that declares no write targets
 * cannot destroy its own premise, and an empty File Scope is a legal spec.
 *
 * A present premise (`text-present`, `file-exists`) on a self-edited path is never a finding — that is the
 * ordinary shape of "the file I rely on still carries this fact", and refusing it would refuse most plans.
 * `formatSelfConsumingPremiseDiagnostic` still names that fragile shape, because it is the sibling failure
 * this gate cannot detect deterministically.
 *
 * Every classifier exclusion (`read-only-context`, `fusion-metadata-evidence`, `generated-lock`,
 * `conditional-changeset`, fenced code) is inherited for free: the write scope comes from
 * `extractEffectiveWriteScopeFromPrompt`, the one authority that implements them.
 */
export function detectSelfConsumingPremises(input: SelfConsumingPremiseInput): SelfConsumingPremiseFinding[] {
  const parsed = parsePlanPremises(input.promptContent);
  if (!parsed.ok) return [];
  const declarations = [
    ...extractEffectiveWriteScopeFromPrompt(input.promptContent).map((entry) => ({ entry, newArtifact: false })),
    ...harvestDeclaredNewArtifacts(input.promptContent).map((entry) => ({ entry, newArtifact: true })),
  ];
  const matchers = declarations.map((declaration) => ({ ...declaration, matches: writeScopeMatcher(declaration.entry) }));
  const findings: SelfConsumingPremiseFinding[] = [];
  for (const premise of parsed.premises) {
    if (!isAbsenceKind(premise.kind)) continue;
    const premisePath = canonicalPath(premise.path);
    const hit = matchers.find(({ matches }) => matches(premisePath));
    if (!hit) continue;
    findings.push({
      premise: JSON.stringify(premise),
      kind: premise.kind,
      path: premise.path,
      ...(premise.kind === "text-absent" ? { literal: premise.literal } : {}),
      writeScopeEntry: hit.entry,
      ...(hit.newArtifact ? { declaredAsNewArtifact: true } : {}),
    });
  }
  return findings;
}

/**
 * The Plan Review diagnostic for a self-consuming premise.
 *
 * It names both contradicting sections, the rewrite that resolves the contradiction, and where a fact this
 * card intends to DELIVER belongs instead: an outcome the acceptance criteria assert, which states a goal
 * rather than an assumption the release door evaluates against the delivered commit. The last clause is load
 * bearing — without it the cheapest way to satisfy this gate is to delete the premise and lose the check.
 *
 * The closing paragraph exists for the shape this gate deliberately does NOT block. A `text-present`
 * literal quoted from source the card's own steps rewrite is legal (it can survive the edit) and is also how
 * RUFU-698's other two premises broke: the fact was true when written, the card refactored the file, and the
 * card finished its work into a `stale` refusal. A deterministic string comparison cannot tell the surviving
 * literal from the rewritten one, so the diagnostic tells the author instead of refusing.
 */
export function formatSelfConsumingPremiseDiagnostic(findings: readonly SelfConsumingPremiseFinding[]): string {
  const bullets = findings.map((finding) => {
    const forbids = finding.kind === "text-absent"
      ? `forbids the literal \`${finding.literal}\``
      : "forbids the path itself";
    const declaredWhere = finding.declaredAsNewArtifact
      ? `the plan lists \`${finding.writeScopeEntry}\` as a (new) artifact this card creates`
      : `\`## File Scope\` declares \`${finding.writeScopeEntry}\` as a path this card writes`;
    return `- ${finding.premise} ${forbids} at \`${finding.path}\`, while ${declaredWhere} — executing the plan as written creates the state the premise forbids.`;
  });
  return [
    "Plan Premises contain an assumption this card's own File Scope will destroy (a self-consuming premise).",
    ...bullets,
    "Fix it in the PLAN, one of these ways: drop the absence premise for a path this card edits; narrow the File Scope entry if the card does not actually write that path; or state the intended end state as an outcome the acceptance criteria assert (for example \"the marker no longer appears in X after the change\") instead of as a premise evaluated against the delivered commit.",
    "Related shape this gate cannot test for, which breaks the same way: a `text-present` literal quoted from source this card's own Steps rewrite is true only on the pre-work tree, and the card finishes its work into a `stale` refusal. Quote a fact that must STAY true after the edit, or move it into the acceptance criteria.",
  ].join("\n");
}
