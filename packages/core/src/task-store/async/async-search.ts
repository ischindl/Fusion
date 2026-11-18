/**
 * Async Drizzle task-search query-structure helpers (U14).
 *
 * FNXC:TaskStoreSearch 2026-06-24-10:30:
 * Async query-structure helpers for task full-text search. This module captures
 * the query predicates and token-sanitization logic that the FTS5 path in
 * store.ts used, expressed against the PostgreSQL `project.tasks` table via
 * Drizzle. The actual tsvector/GIN full-text search implementation is delivered
 * by the `fts-replacement` feature (separate milestone); this module provides
 * the LIKE-based fallback query structure and the shared predicate builders
 * (soft-delete filtering, historical-sentinel filtering, token sanitization) that
 * fts-replacement builds on top of.
 *
 * The search query structure preserves these invariants:
 *   - Soft-delete visibility: live search filters `deleted_at IS NULL`
 *     (VAL-DATA-005). Soft-deleted tasks never appear in search results.
 *   - Historical compatibility: when `includeArchived` is false, rows carrying
 *     the `archived` persistence sentinel are excluded.
 *   - Token sanitization: FTS5 operators are stripped so both code paths see
 *     the same token set. Empty/whitespace queries fall back to listTasks.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync search path (the gate depends on it).
 *   These helpers are the async target the fts-replacement feature and the
 *   PostgreSQL integration tests consume.
 */
import { and, asc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";

/**
 * The columns searched by the LIKE fallback. These are the same columns the
 * FTS5 external-content table indexed (`id`, `title`, `description`, `comments`).
 * The fts-replacement feature's tsvector generated column will index a
 * superset of these.
 */
const SEARCHABLE_TEXT_COLUMNS = ["id", "title", "description", "comments"] as const;

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:35:
 * Sanitize a raw user query into search tokens. Strips FTS5 operators
 * (`"{}:*^+()`) so both the FTS and LIKE code paths see the same token set.
 * Returns an empty array for empty/whitespace queries (the caller falls back
 * to listTasks in that case). Mirrors the sync `sanitizedTokens` logic.
 *
 * @param query The raw user query.
 * @returns The sanitized, non-empty tokens.
 */
export function sanitizeSearchTokens(query: string): string[] {
  const trimmed = query?.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/["{}:*^+()]/g, ""))
    .filter((token) => token.length > 0);
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:40:
 * Build the "live task" search predicate: `deleted_at IS NULL` (soft-delete
 * visibility, VAL-DATA-005) AND, when `includeArchived` is false,
 * `column != 'archived'`. This is the shared predicate every search path applies so
 * soft-deleted and historical-sentinel tasks never appear in ordinary results.
 *
 * @param includeArchived Whether migration/forensic results may include historical snapshots.
 * @returns The composed SQL predicate.
 */
export function liveSearchPredicate(
  includeArchived: boolean,
  projectId?: string,
  /*
  FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
  Search excludes historical persistence sentinels, not a workflow archive role. The optional set
  remains part of the low-level migration/forensic compatibility surface; omission means `archived`.
  */
  archivedColumns?: ReadonlySet<string>,
): SQL {
  // FNXC:MultiProjectIsolation 2026-07-10:
  // Fold the per-project partition key into the shared search predicate so BOTH
  // full-text (tsvector) and LIKE search paths are scoped to the bound project.
  // This is load-bearing for the CREATE-time near-duplicate check, which calls
  // scopedStore.searchTasks(): without it a task in project B is rejected as a
  // duplicate of a same-titled task in project A on the shared embedded-PG table.
  const projectScope = projectId ? eq(schema.project.tasks.projectId, projectId) : undefined;
  /* One exclusion per historical sentinel; ordinary production callers pass the fixed singleton. */
  const archivedExclusions = archivedColumns && archivedColumns.size > 0
    ? [...archivedColumns].map((lane) => ne(schema.project.tasks.column, lane))
    : [ne(schema.project.tasks.column, "archived")];
  const base = includeArchived
    ? ACTIVE_TASK_FILTER
    : and(ACTIVE_TASK_FILTER, ...archivedExclusions);
  return (projectScope ? and(base, projectScope) : base) as SQL;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:45:
 * Build a LIKE-based search predicate for a set of sanitized tokens. Each token
 * is matched (case-insensitive LIKE) against every searchable text column
 * (`id`, `title`, `description`, `comments`). Tokens are OR'd: a task matches
 * if ANY token matches ANY column. This mirrors the sync LIKE fallback.
 *
 * PostgreSQL note: the `comments` column is jsonb, so ILIKE does not work on it
 * directly. We cast it to text (`comments::text`) before the ILIKE so the
 * search covers the serialized comment content. The fts-replacement feature's
 * tsvector path will index a dedicated text-generated column instead.
 *
 * This is the query structure the fts-replacement feature's tsvector path will
 * REPLACE with a `tsvector @@ plainto_tsquery(...)` predicate. The predicate
 * builder is kept separate from the query execution so the fts-replacement
 * feature can swap just the text-matching predicate while reusing the
 * soft-delete/archived filtering.
 *
 * @param tokens The sanitized search tokens.
 * @returns The composed LIKE predicate, or `undefined` if tokens is empty.
 */
const SEARCHABLE_COLUMN_REFS: SQL[] = [
  sql`${schema.project.tasks.id}`,
  sql`${schema.project.tasks.title}`,
  sql`${schema.project.tasks.description}`,
  sql`${schema.project.tasks.comments}::text`,
];

function buildLiteralSubstringPredicate(query: string, columns: readonly SQL[] = SEARCHABLE_COLUMN_REFS): SQL | undefined {
  const literal = query.trim();
  if (!literal) return undefined;
  const pattern = `%${literal.replace(/[\\%_]/g, "\\$&")}%`;
  return or(...columns.map(
    (column) => sql`${column} ILIKE ${pattern} ESCAPE '\\'`,
  )) as SQL;
}

export function buildLikeSearchPredicate(tokens: readonly string[]): SQL | undefined {
  if (tokens.length === 0) return undefined;

  const perTokenClauses: SQL[] = tokens.map((token) => {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    const columnLikes = SEARCHABLE_COLUMN_REFS.map(
      (col) => sql`${col} ILIKE ${pattern} ESCAPE '\\'`,
    );
    return or(...columnLikes) as SQL;
  });

  return or(...perTokenClauses) as SQL;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:50:
 * Search tasks via a LIKE-based fallback query. This is the async equivalent
 * of the sync LIKE-fallback search path (used when FTS5 is unavailable). The
 * fts-replacement feature will add a tsvector-based variant that produces the
 * same row membership but ranked by relevance.
 *
 * Soft-deleted tasks are always excluded (VAL-DATA-005). Historical-sentinel rows
 * are excluded unless `includeArchived` is explicitly true.
 *
 * @param db The Drizzle instance.
 * @param query The raw user query.
 * @param options Search options (limit, offset, includeArchived).
 * @returns The matching task ids (the caller hydrates them into full Task
 *   objects). Returns the raw rows for the caller to deserialize.
 */
export async function searchTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; projectId?: string; archivedColumns?: ReadonlySet<string> },
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  const includeArchived = options?.includeArchived ?? false;
  const textPredicate = buildLikeSearchPredicate(tokens);
  if (!textPredicate) return [];

  const conditions = [textPredicate, liveSearchPredicate(includeArchived, options?.projectId, options?.archivedColumns)];

  const baseQuery = db
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions))
    .orderBy(asc(schema.project.tasks.createdAt));

  const rows = options?.limit && options.limit > 0
    ? await baseQuery.limit(options.limit).offset(options.offset ?? 0)
    : await baseQuery;
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:55:
 * Count tasks matching a LIKE-based search query. Companion to
 * `searchTasksLike` for pagination. Returns 0 for empty queries.
 */
export async function countSearchTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { includeArchived?: boolean; projectId?: string; archivedColumns?: ReadonlySet<string> },
): Promise<number> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return 0;

  const includeArchived = options?.includeArchived ?? false;
  const textPredicate = buildLikeSearchPredicate(tokens);
  if (!textPredicate) return 0;

  const conditions = [textPredicate, liveSearchPredicate(includeArchived, options?.projectId, options?.archivedColumns)];
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-11:00:
 * Archive search query structure. The archive database (`archive.archived_tasks`)
 * stores append-only historical task snapshots. This helper provides the
 * LIKE-based search predicate over the archive's denormalized text columns
 * (`title`, `description`). The fts-replacement feature will add a tsvector
 * variant for archive search parity (VAL-SEARCH-005).
 *
 * @param db The Drizzle instance.
 * @param query The raw user query.
 * @param limit The maximum number of results.
 * @returns The matching historical snapshot entries (parsed from task_json).
 */
export async function searchArchivedTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  limit: number,
  projectId?: string,
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  const columnRefs: SQL[] = [
    sql`${schema.archive.archivedTasks.title}`,
    sql`${schema.archive.archivedTasks.description}`,
  ];

  const perTokenClauses: SQL[] = tokens.map((token) => {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    const columnLikes = columnRefs.map(
      (col) => sql`${col} ILIKE ${pattern} ESCAPE '\\'`,
    );
    return or(...columnLikes) as SQL;
  });

  const textPredicate = or(...perTokenClauses) as SQL;

  // FNXC:MultiProjectIsolation 2026-07-12: scope archived search to the bound
  // project (shared cold-storage table; see async-archive-db.ts).
  const rows = await db
    .select()
    .from(schema.archive.archivedTasks)
    .where(and(
      textPredicate,
      projectId ? eq(schema.archive.archivedTasks.projectId, projectId) : undefined,
    ))
    .orderBy(asc(schema.archive.archivedTasks.archivedAt))
    .limit(limit);
  return rows as unknown as Record<string, unknown>[];
}

/**
 * The searchable text columns (re-exported for the fts-replacement feature to
 * reference when building the tsvector generated column).
 */
export { SEARCHABLE_TEXT_COLUMNS };

// ════════════════════════════════════════════════════════════════════
// tsvector / GIN full-text search (fts-replacement, U7)
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:00:
 * The text-search configuration used by the tsvector generated columns and the
 * plainto_tsquery search predicates. 'simple' is used (not a language-specific
 * config like 'english') because task text is code-like (task IDs, technical
 * terms, file paths) and FTS5 used simple tokenization. 'simple' performs no
 * stemming and applies no stopword list, preserving the same token boundary
 * behavior as FTS5 so search-result membership parity holds (VAL-SEARCH-001).
 *
 * This constant MUST match the configuration embedded in the search_vector
 * generated-column expressions in schema/project.ts and schema/archive.ts and
 * the migration baseline (0000_initial.sql). Changing it without updating all
 * four sites breaks search parity.
 */
export const FTS_TS_CONFIG = "simple";

/**
 * FNXC:TaskStoreSearch 2026-06-24-15:45:
 * Build a tsquery SQL fragment from the raw query using the 'simple' config.
 * Uses `to_tsquery` (NOT plainto_tsquery) with each sanitized token suffixed
 * `:*` for prefix matching and joined by ` | ` (OR), reproducing the FTS5
 * baseline semantics in store.ts (sanitizedTokens.map(t => `${t}*`).join(" OR ")).
 *
 * `plainto_tsquery` was INCORRECT: it ANDs tokens and does no prefix matching,
 * so "frob" failed to match "frobnicator" and multi-term queries lost OR
 * recall. The earlier comment claiming FTS5 used "space-joined tokens (implicit
 * AND)" was factually wrong -- FTS5 joined with " OR " (see store.ts MATCH).
 *
 * `websearch_to_tsquery` is also unsuitable: it lacks prefix matching.
 * `to_tsquery` with manually sanitized tokens + `:*` is the only function
 * that gives OR + prefix.
 *
 * @param query The raw user query (will be sanitized and tokenized).
 * @returns A `SQL` fragment binding the to_tsquery, or `undefined` if the
 *   query produces no valid tokens.
 */
/**
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
 * Build a tsquery from an already-decided lexeme list. This is the single implementation of the
 * `to_tsquery(FTS_TS_CONFIG, "lexeme:* | lexeme:*")` contract; `buildTsqueryFragment` reaches it after
 * planning a query, and the lanes that already hold a plan call it directly rather than replanning.
 *
 * The metacharacter strip is retained as defense in depth. Plan lexemes are runs of letters and digits, so it
 * is a no-op for every query the planner produces today; it stays because dropping it would mean the
 * injection guard depended on the caller never handing this function a raw token, and that is exactly the
 * coupling `searchArchivedTasksTsvector` used to have.
 */
function buildTsqueryFragmentFromLexemes(lexemes: readonly string[]): SQL | undefined {
  if (lexemes.length === 0) return undefined;

  // Strip to_tsquery metacharacters that survive tokenization (&|!:<>()'\) so
  // user input cannot inject tsquery operators.
  const safeTokens = lexemes
    .map((lexeme) => lexeme.replace(/[&|!:<>()'\\]/g, ""))
    .filter((lexeme) => lexeme.length > 0);
  if (safeTokens.length === 0) return undefined;

  // `simple` config, OR join, prefix match per token -- matches FTS5 baseline.
  const tsqueryExpr = safeTokens.map((t) => `${t}:*`).join(" | ");
  return sql`to_tsquery(${FTS_TS_CONFIG}, ${tsqueryExpr})`;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-15:45:
 * Build a tsquery SQL fragment from the raw query using the 'simple' config.
 * Uses `to_tsquery` (NOT plainto_tsquery) with each token suffixed
 * `:*` for prefix matching and joined by ` | ` (OR), reproducing the FTS5
 * baseline semantics in store.ts (sanitizedTokens.map(t => `${t}*`).join(" OR ")).
 *
 * `plainto_tsquery` was INCORRECT: it ANDs tokens and does no prefix matching,
 * so "frob" failed to match "frobnicator" and multi-term queries lost OR
 * recall. The earlier comment claiming FTS5 used "space-joined tokens (implicit
 * AND)" was factually wrong -- FTS5 joined with " OR " (see store.ts MATCH).
 *
 * `websearch_to_tsquery` is also unsuitable: it lacks prefix matching.
 * `to_tsquery` with manually sanitized tokens + `:*` is the only function
 * that gives OR + prefix.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
 * The OR/prefix contract above is unchanged; what changed is its INPUT. Lexemes now come from
 * `planTaskSearch`, so they are runs of letters and digits and no character that `to_tsquery` could read as
 * syntax reaches it from a query. That was not theoretical: measured on the test cluster,
 * `to_tsquery('simple', 'long-term:*')` returns `'long-term':* <-> 'long':* <-> 'term':*` - the hyphen became
 * the phrase-distance operator - and a raw `|` becomes a real OR the operator never asked for. For a
 * punctuation-free query the plan's lexemes are exactly its whitespace tokens, so the emitted SQL is what it
 * was before; the planner deduplicates a repeated word and `to_tsquery` normalises duplicate lexemes itself,
 * so the tsquery VALUE PostgreSQL builds is unchanged.
 *
 * @param query The raw user query (planned, then reduced to lexemes).
 * @returns A `SQL` fragment binding the to_tsquery, or `undefined` if the
 *   query produces no valid tokens.
 */
export function buildTsqueryFragment(query: string): SQL | undefined {
  return buildTsqueryFragmentFromLexemes(planTaskSearch(query).lexemes);
}

/**
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
 * The ONE search plan for a raw query: the lexical lexemes, the per-token literal arms, and whether the query
 * is literal-only. Every lane that has to answer "may this query be read lexically?" reads this plan, so the
 * decision exists in exactly one place.
 *
 * The plan decides punctuation on RAW whitespace tokens, NEVER on `sanitizeSearchTokens` output. That sanitizer
 * strips the operator-typed characters `"{}:*^+()` (`sanitizeSearchTokens`, above), so a sanitized basis
 * silently reclassifies `foo*` as the pure word `foo`: the card titled `foo` then re-enters through the lexical
 * arm AND through the now-unsuppressed cold-index LIKE fallback. That is the exact regression RUFU-312 landed
 * the fallback gate to prevent, and the exact assertion shipped at store-search.pg.test.ts:125. Sanitized
 * tokens remain the right source for LEXEMES; they are structurally the wrong source for the punctuation
 * verdict, because stripping is what erases the character the verdict is about.
 *
 * Measured on the provisioned test cluster, and the reason raw punctuated tokens never enter a tsquery:
 * `to_tsquery('simple', 'long-term:*')` returns `'long-term':* <-> 'long':* <-> 'term':*` — the hyphen is
 * consumed as the phrase-distance operator — and `to_tsquery('simple', 'long | term:*')` returns
 * `'long' | 'term':*`, a real OR the operator did not ask for. Lexemes are therefore built from letters and
 * digits only, so no character that `to_tsquery` could read as syntax can ever reach it from a query.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680) recall contract:
 * Before this plan, one regex over the WHOLE trimmed query made ANY punctuation discard the full-text branch,
 * so the mandatory pre-create duplicate scan — which its own prompt tells the agent to run with "file paths,
 * symptoms, and symbols", all of which contain punctuation — was answered from a single `%whole query%`
 * substring match and returned zero rows. The agent read that zero as "no duplicate exists" and filed a
 * duplicate card. Now a multi-token punctuated query contributes its word fragments as lexemes (so
 * `long-term` recalls cards carrying `long` and `term`) while each punctuated raw token keeps an exact literal
 * arm of its own. The exactness promise that motivated RUFU-312 survives intact and keeps its whole scope:
 * a SINGLE punctuated raw token (`.txt`, `%`, `_`, `foo*`, `RUFU-276`) is still answered literally and is never
 * broadened, because there the punctuation is the entire search term rather than one token among several.
 */
export interface TaskSearchPlan {
  /** Raw whitespace tokens of the trimmed query. Never sanitized output. */
  readonly rawTokens: readonly string[];
  /** Deduplicated lexical lexemes, letters and digits only, in first-seen order. */
  readonly lexemes: readonly string[];
  /**
   * Punctuated raw tokens that get a literal substring arm of their own, so a path or symbol typed inside a
   * multi-word query still has to appear verbatim. Empty whenever `literalOnly` is true, because there the
   * whole-query literal already is the answer.
   */
  readonly punctuatedTokenLiterals: readonly string[];
  /** Whether membership may only be answered by literal substring matching. */
  readonly literalOnly: boolean;
}

/** A raw token whose every character is a letter or a digit — a pure word, punctuation-free. */
const PURE_WORD_TOKEN_RE = /^[\p{L}\p{N}]+$/u;
/** Runs of letters and digits inside a punctuated token: `self-healing.ts` yields `self`, `healing`, `ts`. */
const WORD_FRAGMENT_RE = /[\p{L}\p{N}]+/gu;

export function planTaskSearch(query: string): TaskSearchPlan {
  const trimmed = query?.trim() ?? "";
  const rawTokens = trimmed ? trimmed.split(/\s+/).filter((token) => token.length > 0) : [];

  const lexemes: string[] = [];
  const punctuatedTokenLiterals: string[] = [];
  const seenLexemes = new Set<string>();
  const addLexeme = (candidate: string) => {
    if (!seenLexemes.has(candidate)) {
      seenLexemes.add(candidate);
      lexemes.push(candidate);
    }
  };

  for (const rawToken of rawTokens) {
    if (PURE_WORD_TOKEN_RE.test(rawToken)) {
      addLexeme(rawToken);
      continue;
    }
    // Punctuated raw token: it keeps its own literal arm, and its word fragments join the lexical arm.
    // A token with no alphanumerics at all (`%`, `_`) contributes no lexeme — that is what stops a
    // lexeme-less query from ever producing an empty tsquery that means "nothing is required".
    punctuatedTokenLiterals.push(rawToken);
    for (const fragment of rawToken.match(WORD_FRAGMENT_RE) ?? []) addLexeme(fragment);
  }

  const literalOnly =
    rawTokens.length === 0
    || lexemes.length === 0
    || (rawTokens.length === 1 && punctuatedTokenLiterals.length === 1);

  return literalOnly
    ? { rawTokens, lexemes, punctuatedTokenLiterals: [], literalOnly: true }
    : { rawTokens, lexemes, punctuatedTokenLiterals, literalOnly: false };
}

/**
 * FNXC:TaskStoreSearch 2026-11-01-19:24 (RUFU-312 step 6):
 * Whether a query must be answered as a LITERAL substring rather than as a lexical (tsvector) query.
 * Punctuation carries user intent — a task id, a file extension, a path — and tsvector tokenization erases it,
 * so a query whose intent IS the punctuated string may only match rows that literally contain what the
 * operator typed. This is the ONE predicate for that decision: `buildTaskSearchPredicate` (membership),
 * `buildArchiveSearchPredicate` (archive membership), `searchTasksTsvector` and `searchArchivedTasks` (whether
 * a rank order exists), and `searchTasksImpl` (whether the cold-index LIKE fallback may run) all read it,
 * because a fallback that tokenizes a literal query re-admits exactly the rows the literal rule exists to exclude.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680): the verdict now answers from `planTaskSearch`, so its
 * scope is stated honestly. It is literal-only for a query with no tokens, for one that yields no word lexeme
 * at all (`%`, `_`, `% _`), and for exactly ONE punctuated raw token (`.txt`, `%`, `foo*`, `RUFU-276`) — the
 * shape the 2026-11-01 rationale was written for. A MULTI-token punctuated query is NOT literal-only: its
 * punctuated tokens still each demand a verbatim match, but they no longer get to veto the lexical arm for the
 * words around them. The body changed; the name, the signature, and the five consumers did not.
 */
export function isLiteralOnlySearchQuery(query: string): boolean {
  return planTaskSearch(query).literalOnly;
}

/**
 * FNXC:TaskStoreSearch 2026-09-11-22:33:
 * Task membership always includes a case-insensitive literal substring match across ID, title, description, and comments. LIKE wildcards are escaped before binding.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680) - corrected scope of this note's second sentence, which
 * read "...while punctuation-bearing queries such as `.txt`, `%`, and `_` stay literal so tokenization cannot
 * admit rows that omit characters the user typed". That rationale is correct for its real scope, ONE punctuated
 * raw token, and inverted when applied to a whole multi-word query: there the literal arm stops protecting the
 * characters the operator typed and starts requiring the entire sentence verbatim. No card contains a whole
 * sentence verbatim, so the lane answered zero rows and every caller - above all the mandatory pre-create
 * duplicate scan - read that zero as "no duplicate exists" and filed a duplicate card.
 * Membership is now `or(GIN lexical arm, whole-query literal, one literal arm PER punctuated raw token)`. The
 * exactness promise keeps its full force per token: a path or a symbol still has to appear verbatim. It just no
 * longer vetoes the lexical recall of the words beside it. Punctuation-free and single-token queries compose
 * the identical arms and emit the identical SQL.
 */
export function buildTaskSearchPredicate(query: string): SQL | undefined {
  const literalPredicate = buildLiteralSubstringPredicate(query);
  if (!literalPredicate) return undefined;

  const plan = planTaskSearch(query);
  // A single punctuated raw token, or a query with no word lexeme at all, is answered by the literal arm
  // alone: the operator typed the whole search term, so tokenizing it would admit rows that omit characters
  // they insisted on seeing.
  if (plan.literalOnly) return literalPredicate;

  const arms: SQL[] = [];
  const tsquery = buildTsqueryFragmentFromLexemes(plan.lexemes);
  if (tsquery) arms.push(sql`${schema.project.tasks.searchVector} @@ ${tsquery}`);
  arms.push(literalPredicate);
  for (const tokenLiteral of plan.punctuatedTokenLiterals) {
    // Reuse the one LIKE-escaping implementation instead of re-escaping per lane.
    const arm = buildLiteralSubstringPredicate(tokenLiteral);
    if (arm) arms.push(arm);
  }
  return or(...arms) as SQL;
}

/**
 * FNXC:TaskSearchVectorScope 2026-11-01-20:30 (RUFU-312 step 6):
 * The archive mirror's searchable columns. Same four texts the live board searches, because an archived card
 * is the same card read from cold storage — `archive.archived_tasks.search_vector` narrowed to title +
 * description with its live twin, and this literal arm is what keeps id and comment text findable there.
 */
const ARCHIVE_SEARCHABLE_COLUMN_REFS: SQL[] = [
  sql`${schema.archive.archivedTasks.id}`,
  sql`${schema.archive.archivedTasks.title}`,
  sql`${schema.archive.archivedTasks.description}`,
  sql`${schema.archive.archivedTasks.comments}::text`,
];

/**
 * FNXC:TaskSearchVectorScope 2026-11-01-20:30 (RUFU-312 step 6):
 * Archived-card membership, built by the SAME rules as `buildTaskSearchPredicate`: lexical queries get the
 * GIN-backed OR/prefix arm plus the literal substring arm, and a literal-only query gets the literal arm alone.
 * One rule for both task tables is the point — an archived card that answers a different membership
 * question than a live one makes "where is my card?" depend on whether it was ever archived, and the archive
 * path's old shape (tsquery over a vector that also indexed the comment document, ILIKE only when the tsquery
 * came out empty) had exactly that divergence.
 *
 * FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
 * The live rule this mirrors now distinguishes ONE punctuated raw token from a multi-token punctuated query,
 * and this lane follows it arm for arm over its own column refs rather than keeping a private copy of the old
 * whole-query rule. Parity is the RUFU-312 invariant, so the recall fix has to land here in the same change it
 * lands live: a one-sided edit would make a card findable from the board only, and "where is my card?" would
 * once again depend on whether it had ever been archived.
 */
export function buildArchiveSearchPredicate(query: string): SQL | undefined {
  const literalPredicate = buildLiteralSubstringPredicate(query, ARCHIVE_SEARCHABLE_COLUMN_REFS);
  if (!literalPredicate) return undefined;

  const plan = planTaskSearch(query);
  if (plan.literalOnly) return literalPredicate;

  const arms: SQL[] = [];
  const tsquery = buildTsqueryFragmentFromLexemes(plan.lexemes);
  if (tsquery) arms.push(sql`${schema.archive.archivedTasks.searchVector} @@ ${tsquery}`);
  arms.push(literalPredicate);
  for (const tokenLiteral of plan.punctuatedTokenLiterals) {
    const arm = buildLiteralSubstringPredicate(tokenLiteral, ARCHIVE_SEARCHABLE_COLUMN_REFS);
    if (arm) arms.push(arm);
  }
  return or(...arms) as SQL;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:10:
 * Search tasks via the tsvector/GIN full-text index. This is the PostgreSQL
 * replacement for the SQLite FTS5 search path (VAL-SEARCH-001 search parity,
 * VAL-SEARCH-002/003/004 sync-on-write). The `search_vector @@ tsquery`
 * predicate uses the GIN index (idxTasksSearchVector) for fast ranked lookup.
 *
 * Soft-deleted tasks are always excluded (VAL-DATA-005) because the live-search
 * predicate filters `deleted_at IS NULL`. Historical-sentinel rows (`column = 'archived'`)
 * are excluded unless `includeArchived` is explicitly true.
 *
 * Results are ordered by `ts_rank` (relevance) descending, then by `created_at`
 * ascending for a stable tiebreak. This mirrors the FTS5 `ORDER BY rank` path.
 * Row membership (which tasks match) is what VAL-SEARCH-001 asserts; ordering
 * is explicitly excluded from the parity contract (see validation-contract.md
 * VAL-CUTOVER-003 "excluding search-result ordering").
 *
 * @param db The Drizzle instance or transaction handle.
 * @param query The raw user query.
 * @param options Search options (limit, offset, includeArchived).
 * @returns The matching task rows. Empty for empty/whitespace queries.
 */
export async function searchTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; projectId?: string; archivedColumns?: ReadonlySet<string> },
): Promise<Record<string, unknown>[]> {
  const searchPredicate = buildTaskSearchPredicate(query);
  if (!searchPredicate) return [];

  const includeArchived = options?.includeArchived ?? false;
  const conditions = [
    searchPredicate,
    liveSearchPredicate(includeArchived, options?.projectId, options?.archivedColumns),
  ];
  const tsquery = isLiteralOnlySearchQuery(query) ? undefined : buildTsqueryFragment(query);
  const rankOrder = tsquery
    ? sql`ts_rank(${schema.project.tasks.searchVector}, ${tsquery}) DESC`
    : sql`length(${schema.project.tasks.id}) * 0`;

  const baseQuery = db
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions))
    .orderBy(rankOrder, asc(schema.project.tasks.createdAt));

  const rows = options?.limit && options.limit > 0
    ? await baseQuery.limit(options.limit).offset(options.offset ?? 0)
    : await baseQuery;
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:15:
 * Count tasks matching a tsvector full-text search query. Companion to
 * `searchTasksTsvector` for pagination. Returns 0 for empty queries.
 */
export async function countSearchTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { includeArchived?: boolean; projectId?: string; archivedColumns?: ReadonlySet<string> },
): Promise<number> {
  const searchPredicate = buildTaskSearchPredicate(query);
  if (!searchPredicate) return 0;

  const includeArchived = options?.includeArchived ?? false;
  const conditions = [
    searchPredicate,
    liveSearchPredicate(includeArchived, options?.projectId, options?.archivedColumns),
  ];
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:20:
 * Search archived tasks via the tsvector/GIN full-text index on the archive
 * database (VAL-SEARCH-005 archive search parity). This is the PostgreSQL
 * replacement for the SQLite FTS5 archive search path. The
 * `search_vector @@ tsquery` predicate uses the GIN index
 * (idxArchivedTasksSearchVector).
 *
 * Results are ordered by `ts_rank` descending then `archived_at` ascending.
 * Row membership is what VAL-SEARCH-005 asserts.
 *
 * @param db The Drizzle instance or transaction handle.
 * @param query The raw user query.
 * @param limit The maximum number of results.
 * @returns The matching archived-task rows. Empty for empty/whitespace queries.
 */
export async function searchArchivedTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  limit: number,
  projectId?: string,
): Promise<Record<string, unknown>[]> {
  /*
  FNXC:TaskStoreSearch 2026-11-18-02:19 (RUFU-680):
  This lane used to reassemble its own query string - `sanitizeSearchTokens(query).join(" ")` - and hand the
  result to `buildTsqueryFragment`, which re-tokenized it. That double tokenization was the one place where a
  raw punctuated token reached `to_tsquery` with no plan in front of it: `long-term cleanup` arrived as
  `long-term:* | cleanup:*`, and a hyphen inside a tsquery is not inert text - measured, `to_tsquery('simple',
  'long-term:*')` returns `'long-term':* <-> 'long':* <-> 'term':*`, the phrase-distance operator. The lexemes
  now come from the same plan every other lane reads.

  Its membership shape is deliberately UNCHANGED: this helper is tsvector-only, with no literal arm. So a
  literal-only plan has nothing to ask the vector and answers empty, rather than being broadened into the
  fragments of a token whose whole point was that the operator typed it exactly.
  */
  const plan = planTaskSearch(query);
  if (plan.rawTokens.length === 0 || plan.literalOnly) return [];

  const tsquery = buildTsqueryFragmentFromLexemes(plan.lexemes);
  if (!tsquery) return [];

  // FNXC:MultiProjectIsolation 2026-07-12: scope archived search to the bound
  // project (shared cold-storage table; see async-archive-db.ts).
  const rows = await db
    .select()
    .from(schema.archive.archivedTasks)
    .where(and(
      sql`${schema.archive.archivedTasks.searchVector} @@ ${tsquery}`,
      projectId ? eq(schema.archive.archivedTasks.projectId, projectId) : undefined,
    ))
    .orderBy(
      sql`ts_rank(${schema.archive.archivedTasks.searchVector}, ${tsquery}) DESC`,
      asc(schema.archive.archivedTasks.archivedAt),
    )
    .limit(limit);
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:25:
 * Read the raw search_vector tsvector value for a task. Used by tests to
 * verify the value-aware partial-update optimization (VAL-SEARCH-006): a
 * mutation touching only non-text columns leaves search_vector unchanged.
 * Returns null if the task does not exist.
 *
 * This is a debug/assertion helper, not a hot-path query.
 *
 * @param db The Drizzle instance.
 * @param taskId The task id.
 * @returns The tsvector value as a string (PostgreSQL cast), or null.
 */
export async function readTaskSearchVector(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<string | null> {
  const rows = await db
    .select({ sv: sql<string | null>`${schema.project.tasks.searchVector}::text` })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId));
  return rows[0]?.sv ?? null;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:30:
 * REINDEX the tasks search_vector GIN index. Operators call this to rebuild
 * the full-text index after bloat, restoring correct search without data loss
 * (VAL-SEARCH-007). The generated column values are NOT affected — only the
 * index is rebuilt from the existing tsvector data. This replaces the FTS5
 * `rebuildFts5Index()` / `optimizeFts5()` self-healing paths.
 *
 * REINDEX is a DDL operation that takes an exclusive lock on the index; in
 * production it should run via `REINDEX INDEX CONCURRENTLY` to avoid blocking
 * writes. This helper uses the blocking form because it targets the
 * operator/maintenance path, not the hot path.
 *
 * @param db The Drizzle instance.
 * @param concurrently If true, use REINDEX INDEX CONCURRENTLY (non-blocking).
 */
export async function reindexTasksSearchVector(
  db: AsyncDataLayer["db"],
  concurrently = false,
): Promise<void> {
  // Schema-qualify the index name because the connection's search_path may not
  // include the project schema (the runtime connection is schema-less).
  const clause = concurrently
    ? sql`REINDEX INDEX CONCURRENTLY project."idxTasksSearchVector"`
    : sql`REINDEX INDEX project."idxTasksSearchVector"`;
  await db.execute(clause);
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:35:
 * REINDEX the archived_tasks search_vector GIN index. Companion to
 * `reindexTasksSearchVector` for the archive database.
 */
export async function reindexArchivedTasksSearchVector(
  db: AsyncDataLayer["db"],
  concurrently = false,
): Promise<void> {
  const clause = concurrently
    ? sql`REINDEX INDEX CONCURRENTLY archive."idxArchivedTasksSearchVector"`
    : sql`REINDEX INDEX archive."idxArchivedTasksSearchVector"`;
  await db.execute(clause);
}
