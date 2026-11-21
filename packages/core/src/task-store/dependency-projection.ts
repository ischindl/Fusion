/*
 * Pure decision that reads the `## Dependencies` section of a PROMPT.md and separates the task ids it
 * names into the ones the specification really waits for and the ones it explicitly denies.
 *
 * FNXC:DependencyProjection 2026-11-13-19:11 (RUFU-750):
 * Before this module the projection was one prose-blind regex (`/^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm`
 * in `task-artifacts-ops.ts`), so the machine shape `- **Task:** <ID>` carried BOTH meanings at once:
 * "this card waits for <ID>" and "this card merely mentions <ID>". Because every projected id that was
 * not already on the row was a NEW dependency edge, a bullet whose own prose denied the relationship
 * still wrote an edge, and the store treats a new edge as `hasNewDeps` -> lane move plus the history
 * line "Re-seeded for re-specification - new dependency added" (`task-update.ts`). A hand-edit that
 * removed the edge was restored by the next planning pass, so the card re-planned itself every pass
 * (measured on RUFU-747: passes 17:07:31->17:07:48 and 17:33:10->17:33:26 for two such bullets).
 *
 * The author contract this module enforces, and the one the planner prompts state:
 * a `- **Task:** <ID>` bullet inside `## Dependencies` means EXCLUSIVELY "this card waits for <ID>".
 * Any other reference is written as plain prose or lives outside the section. A bullet that denies the
 * relationship is a note, never an edge.
 *
 * Two closed phrase lists decide a bullet, and the default stays the pre-existing behaviour: NO hit
 * means `projected`, so an unfamiliar wording keeps its edge (fail-safe: a suppressed real edge
 * deadlocks a card behind work that has not landed, which is worse than the extra pass a false edge
 * costs). Denial requires an explicit clause from `NOT_DEPENDENCY_CLAUSES`, and it only decides a
 * bullet when no positive clause survives: "not blocking, but blocked by its landing" states a real
 * wait and MUST project, while "not blocked by it" states the opposite and MUST deny.
 *
 * The occurrence test is therefore negation-aware, NOT positional. Comparing clause positions would
 * read the first of those two sentences as a denial, because its denial comes first. Instead a positive
 * clause counts unless the text immediately before that specific occurrence ends in a negation cue
 * (`not`, `no`, `never`, `cannot`, or an `n't` contraction), tolerating intervening whitespace and
 * punctuation. `DEPENDENCY_CLAUSES` deliberately holds no bare `depend on` or `wait for`: those are
 * also the words the denying clauses are built from, so a positive list containing them would make
 * every denial also a positive and the decision undecidable.
 *
 * Deliberately fs-free and side-effect-free: this is the single source of truth for the decision, so
 * the store parser (`task-artifacts-ops.ts`) and the planning finalizer (`engine/src/triage.ts`) apply
 * one reading of the same text instead of keeping a second copy of the regex. It never rewrites
 * `PROMPT.md`: spec-lock canonicalizes the document textually (`planner/spec-lock.ts`), so the guard
 * decides only which ids reach the task row.
 */

/** The two halves of the `## Dependencies` projection, both deduped in document order. */
export interface DependencyProjection {
  /** Ids whose bullet expresses a real wait. These are the only ids that may become dependency edges. */
  projected: string[];
  /** Ids whose bullet explicitly denies the relationship. These must never create an edge. */
  negated: string[];
}

/**
 * Closed vocabulary of prose that says "do NOT treat this bullet as an edge". Lowercased, matched
 * against the marker-stripped bullet text, word-bounded. Extending it is a contract change: each entry
 * is a sentence form a planner can legitimately write while meaning "we wait".
 */
const NOT_DEPENDENCY_CLAUSES: readonly string[] = [
  "not a dependency",
  "not the dependency",
  "not a real dependency",
  "no dependency on",
  "not dependent on",
  "not depend on",
  "does not depend",
  "do not depend",
  "not a prerequisite",
  "not a blocker",
  "not blocking",
  "does not block",
  "do not block",
  "not blocked by",
  "never blocked by",
  "does not wait",
  "do not wait",
  "not waiting on",
  "not waiting for",
  "informational only",
  "for context only",
  "context only",
  "reference only",
];

/**
 * Closed vocabulary of prose that says "we really do wait". It wins over a denial wherever it sits, and
 * an occurrence disqualified by a directly preceding negation cue does not count. Bare `depend on` and
 * `wait for` are excluded on purpose (see the module comment): they are the tails of the denying
 * clauses, so including them would make every denial simultaneously positive.
 */
const DEPENDENCY_CLAUSES: readonly string[] = [
  "blocked by",
  "waiting on",
  "waits for",
  "prerequisite",
  "must land",
  "must complete",
];

/** A cue glued to the start of an occurrence's context negates THAT occurrence, not the bullet. */
const TRAILING_NEGATION_CUE = /(?:\b(?:not|no|never|cannot)|n't)$/;

/** `## Dependencies` heading and the next-heading slice rule, kept byte-identical to the old parser. */
const DEPENDENCY_HEADING = /^##\s+Dependencies\s*$/m;
const NEXT_SECTION = /\n##?\s/;

/** Bullet shapes. Only an unindented `- ` bullet naming a task id is a dependency candidate. */
const TASK_BULLET = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/;
const ANY_BULLET = /^[-*]\s/;
const SECTION_END_LINE = /^#{1,2}(\s|$)/;
const INDENTED_CONTINUATION = /^[ \t]+\S/;

/**
 * Normalize a bullet's prose for clause matching: typographic apostrophes become ASCII so an `n't`
 * contraction is still recognizable, markdown emphasis markers are stripped (`**not a dependency**`),
 * runs of whitespace including the joins between continuation lines collapse to one space.
 */
function normalizeClauseText(raw: string): string {
  return raw
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word matching, so `not a blocker` cannot fire inside a longer token. */
function isWordBounded(text: string, start: number, length: number): boolean {
  const before = start === 0 ? " " : text[start - 1]!;
  const after = start + length >= text.length ? " " : text[start + length]!;
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * True when the text before `index` ends in a negation cue, i.e. this specific occurrence is denied.
 * Whitespace and punctuation between the cue and the occurrence are tolerated ("not - blocked by").
 * This is per-occurrence on purpose: the cue decides the phrase it precedes, so an unrelated later
 * denial in the same bullet cannot reach back and disqualify an earlier positive clause.
 */
function isNegatedOccurrence(text: string, index: number): boolean {
  const prefix = text.slice(0, index).replace(/[\s\p{P}]+$/u, "");
  return TRAILING_NEGATION_CUE.test(prefix);
}

function containsClause(text: string, clause: string, skipNegatedOccurrences: boolean): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(clause, from);
    if (at === -1) return false;
    from = at + clause.length;
    if (!isWordBounded(text, at, clause.length)) continue;
    if (skipNegatedOccurrences && isNegatedOccurrence(text, at)) continue;
    return true;
  }
}

/**
 * One bullet's disposition. A surviving positive clause wins outright; otherwise an explicit denial
 * negates the bullet; with neither hit the bullet keeps the pre-existing behaviour and projects.
 */
function classifyDependencyBullet(prose: string): "projected" | "negated" {
  const text = normalizeClauseText(prose);
  if (!text) return "projected";
  for (const clause of DEPENDENCY_CLAUSES) {
    if (containsClause(text, clause, true)) return "projected";
  }
  for (const clause of NOT_DEPENDENCY_CLAUSES) {
    if (containsClause(text, clause, false)) return "negated";
  }
  return "projected";
}

interface DependencyBullet {
  id: string;
  prose: string;
}

/**
 * Slice `## Dependencies` exactly as the old parser did: the heading line, then up to the next `#`/`##`
 * heading. A `###` subheading does not end the section today and still does not, so an id under one is
 * still read. Returns null when the document has no such section.
 */
function sliceDependenciesSection(text: string): string | null {
  const headingMatch = text.match(DEPENDENCY_HEADING);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const rest = text.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = rest.search(NEXT_SECTION);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

/**
 * Walk the section into bullets, each carrying the text after its id plus its indented continuation
 * lines. Unindented prose after a bullet is NOT folded into it: it belongs to the section, not to that
 * one edge, and letting it deny the preceding bullet would suppress a real edge on unrelated prose.
 */
function collectDependencyBullets(section: string): DependencyBullet[] {
  const bullets: DependencyBullet[] = [];
  let open: DependencyBullet | null = null;
  for (const line of section.split("\n")) {
    const taskMatch = TASK_BULLET.exec(line);
    if (taskMatch) {
      open = { id: taskMatch[1]!, prose: line.slice(taskMatch.index + taskMatch[0].length) };
      bullets.push(open);
      continue;
    }
    if (SECTION_END_LINE.test(line)) {
      open = null;
      continue;
    }
    if (ANY_BULLET.test(line)) {
      // A non-task bullet (for example `- **None**`) ends the previous bullet's prose.
      open = null;
      continue;
    }
    if (line.trim() === "") continue;
    if (open && INDENTED_CONTINUATION.test(line)) {
      open.prose += ` ${line}`;
      continue;
    }
    open = null;
  }
  return bullets;
}

/**
 * Project the `## Dependencies` section of a PROMPT.md document.
 *
 * Both results keep document order and hold each id once. An id that appears in a positive bullet and
 * also in a denying bullet is `projected` only: the wait is the deliberate statement, and losing a real
 * edge is the failure mode this guard must not add.
 */
export function projectDependencyBindingsFromPromptText(text: string): DependencyProjection {
  const section = sliceDependenciesSection(text);
  if (section === null) return { projected: [], negated: [] };

  const order: string[] = [];
  const projectedIds = new Set<string>();
  const negatedIds = new Set<string>();
  for (const bullet of collectDependencyBullets(section)) {
    if (!projectedIds.has(bullet.id) && !negatedIds.has(bullet.id)) order.push(bullet.id);
    if (classifyDependencyBullet(bullet.prose) === "projected") projectedIds.add(bullet.id);
    else negatedIds.add(bullet.id);
  }

  return {
    projected: order.filter((id) => projectedIds.has(id)),
    negated: order.filter((id) => negatedIds.has(id) && !projectedIds.has(id)),
  };
}
