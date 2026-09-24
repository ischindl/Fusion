#!/usr/bin/env node
// Runtime: Node with native TS stripped (node scripts/*.mjs is the invocation contract for every
// gate validator). This module is imported by scripts/__tests__/check-retention-coverage.test.mjs,
// so it must stay importable without executing main().
/*
FNXC:RetentionCensus 2026-09-23-09:05 (RUFU-257):
Step 2 and Step 3 of RUFU-257 bounded caches that were *named* by a spec. Naming is not a control:
the leak (7 OOM crashes with no attribution) returns the moment someone adds the next module-scope
`const cache = new Map()` beside the ~110 that already exist, and no lint rule in this repository
notices a Map that simply never stops growing. This validator is the recurrence ratchet — the
structural gate that makes "unbounded module-scope collection in the dashboard server" a failing
build rather than a future incident.

The subject set is derived ONLY from declaration structure: a module-scope (column-0) `const/let/var`
whose initializer begins with `new Map`/`new Set` in any `.ts` file under
`packages/dashboard/src`, excluding `__tests__` directories and test files. Comments, prose, and TTL
literals are never scanned, because a check
that reads prose can be satisfied by editing prose. That also means the set cannot be quietly
narrowed by hand: the checked-in inventory is GENERATED from this scan (`--write`), so a PR that
deletes an inventory line re-generates it on the next run, and a new declaration with no
classification fails the gate.

Every declaration must land in exactly one of four honest classes, each with a mechanically checkable
premise (see CLASS_RULES below):
  census-registered  a `registerRetentionSource`/`registerBoundedWindowMap`/`registerBoundedRegistryMap`
                     call in the same file references the symbol — attribution AND a reclamation owner.
  bounded            a named count ceiling constant in the same file governs the collection.
  owner-deleted      a production deletion site for the symbol exists (an in-flight lease/lock/listener).
  config-keyed-registry
                     the key space is operator-owned configuration (one entry per project/workspace),
                     so cardinality is not traffic-shaped and entries are live singletons.
  fixed-key-set      a literal collection that is never mutated — a table, not a cache.

Rule (3) is the anti-laundering rule: a declaration with per-declaration expiry evidence (its own
write sites or value type carry `expiresAt`/`ttl`/`fetchedAt`/`mtime`/rate-limit-window vocabulary)
may NOT claim `fixed-key-set`, `owner-deleted`, or `config-keyed-registry`. Those three classes all
argue "nothing accumulates here", and an expiry-carrying value is the definition of something that
accumulates until somebody reclaims it. Such a declaration must be `census-registered` or `bounded`,
i.e. it must name a reclamation owner or a ceiling — which is exactly the property whose absence
caused the crashes.
*/

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Default scan root: the dashboard server, which is the process that OOM-crashed. */
const DEFAULT_SCAN_ROOT = join(REPO_ROOT, "packages", "dashboard", "src");

/*
FNXC:RetentionCensus 2026-09-23-18:30 (RUFU-257 Step 4):
The leak class is cross-package, so a root list that stops at the dashboard is a partial fix — but the
other three roots are NOT yet classified, and pretending otherwise is how a gate becomes theatre. This
list is therefore a *counted backlog*: on every green run the checker scans each pending root, prints how
many module-scope declarations it finds and how many of them still lack a classification, and names the
next package. It never fails on them, because failing here would mean inventing 74 justifications that
nobody has measured (the same laundering rule (3) exists to stop), and an unfalsifiable "pending" list is
caught by scripts/__tests__/check-retention-coverage.test.mjs, which asserts each pending root really
carries scannable declarations. Widening a root into the blocking set is the follow-up task's whole scope.
*/
const PENDING_SCAN_ROOTS = ["packages/engine/src", "packages/core/src", "packages/cli/src"];

/** Exported for the checker's own test, which asserts the backlog is real and not an empty list. */
export const PENDING_ROOTS = PENDING_SCAN_ROOTS;
/** Default inventory location (generated, checked in). */
const DEFAULT_INVENTORY = join(REPO_ROOT, "scripts", "lib", "retention-inventory.mjs");

/*
FNXC:RetentionCensus 2026-09-23-09:05 (RUFU-257):
Non-vacuity floors. A checker whose subject set can silently become empty is a checker that passes
forever, so these floors are the ratchet's own regression test: the day the scan or the scanner
breaks, the count breaks first. Measured at authoring: 110 declarations scanned, 30 census-registered,
56 expiry-bearing declarations.
*/
const MIN_SCANNED_DECLARATIONS = 60;
const MIN_CENSUS_REGISTERED = 15;

/** Class names as they appear in the generated inventory. */
export const CLASS_CENSUS_REGISTERED = "census-registered";
export const CLASS_BOUNDED = "bounded";
export const CLASS_OWNER_DELETED = "owner-deleted";
export const CLASS_CONFIG_KEYED = "config-keyed-registry";
export const CLASS_FIXED_KEY_SET = "fixed-key-set";
export const CLASS_UNCLASSIFIED = "unclassified";

/**
 * In-file classification markers. A marker is the ONLY way to claim a class the scanner cannot prove
 * from structure, and each one names the evidence the claim rests on. This mirrors the existing
 * `// nested-component-allowlist: <reason>` escape-hatch convention in this repository.
 */
const MARKERS = [
  { kind: "bounded", flag: "retention-bounded:", class: CLASS_BOUNDED },
  { kind: "owner-deleted", flag: "retention-owner-deleted:", class: CLASS_OWNER_DELETED },
  { kind: "config-keyed", flag: "retention-config-keyed:", class: CLASS_CONFIG_KEYED },
  { kind: "allowlist", flag: "retention-allowlist:", class: CLASS_FIXED_KEY_SET },
];

/*
Per-declaration expiry vocabulary. Deliberately narrow: `\bwindow\b` and `\bstale\b` are excluded
because they collide with `window`/`staleWhileRevalidate` prose, and a vocabulary that fires on
everything teaches people to widen rule (3) instead of honoring it. What stays here is the field
vocabulary every real expiry cache in this package actually writes (`expiresAt`, `ttlMs`,
`fetchedAt`, `mtimeMs`, `windowMs`, `clientIp`).
*/
const EXPIRY_VOCAB =
  /\b(expiresAt|expires_at|expiresIn|expires|expiry|expired|ttlMs|\bTTL\b|\bttl\b|ttl_|_ttl|fetchedAt|lastFetch|lastUsedAt|lastSeenAt|mtimeMs|mtime|modifiedAt|rateLimit|RateLimit|rate-limit|windowMs|windowStart|clientIp|requestIp|perIp|ipKey)\b/;

/*
Registration seams whose argument text referencing the symbol proves census coverage. The generic
argument of a call like `registerBoundedRegistryMap<string, Promise<void>>({…})` nests angle
brackets, so the type-argument span is matched as "anything without parentheses" rather than a
balanced `<…>` — a `[^>]*` pattern silently fails to match nested generics, and a seam the scanner
cannot see is an unregistered cache the ratchet never asks about.
*/
const REGISTRATION_SEAMS = /(registerRetentionSource|registerBoundedWindowMap|registerBoundedRegistryMap)\s*(?:<[^()]*>)?\s*\(/g;

/*
FNXC:RetentionCensus 2026-09-23-10:55 (RUFU-257):
Every proof this ratchet accepts (registration seams, `delete` sites, ceiling reads, mutation scans) is a
substring test, so running it against raw text lets prose satisfy a proof: a commented-out
`registerRetentionSource({ map: cache, … })`, a `// tokens.delete(x) runs here` note, or a prose mention of
a ceiling name would all make an unbounded cache read as bounded. This strip turns comments into blank
lines so the proofs see only code the compiler also sees, while the `// retention-*:` markers — which are
deliberately comments — stay visible to `markerFor`, which scans the raw source. Line count is preserved,
so a stripped file still addresses the original lines.

A trailing `//` comment is cut only when the prefix has balanced quotes and no `://`, so a URL or an
apostrophe inside a string literal cannot chop real code off the end of a line.
*/
export function codeWithoutComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) return "";
      const marker = line.indexOf("//");
      if (marker <= 0) return line;
      const prefix = line.slice(0, marker);
      const doubleQuotes = (prefix.match(/"/g) ?? []).length;
      const singleQuotes = (prefix.match(/'/g) ?? []).length;
      if (prefix.includes("://") || doubleQuotes % 2 === 1 || singleQuotes % 2 === 1) return line;
      return prefix;
    })
    .join("\n");
}

/** Module-scope declaration head: column-0 `const|let|var <name>`. */
const DECLARATION_HEAD = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/;

/**
 * Scan a directory tree for module-scope `new Map`/`new Set` declarations.
 *
 * Column-0 anchoring is what makes these *module scope*: an indented `new Map()` lives inside a
 * function or a class body and dies with its instance, which is the whole point of the WeakMap
 * rewrite in `workflow-ir-resolver.ts`. Multi-line type annotations are handled by reading the
 * statement, not the line, so `const x: Map<\n Foo,\n Bar\n> = new Map()` cannot hide from the set.
 *
 * @param {{ root: string, pathPrefix?: string, listFiles?: (dir: string) => string[] }} options
 * @returns {Array<{file: string, line: number, name: string, kind: "Map"|"Set", source: string}>}
 */
export function scanModuleScopeCollections({ root, pathPrefix = "", listFiles }) {
  const files = (listFiles ?? listTypeScriptFiles)(root);
  const declarations = [];
  for (const filePath of files.sort()) {
    const source = readFileSync(filePath, "utf8");
    // Discovery reads code, not prose, so a `const cache = new Map()` inside a doc block is neither a
    // declaration nor a finding. Line numbers survive the strip, so `line` still addresses the raw file.
    for (const declaration of scanSource(codeWithoutComments(source))) {
      const scoped = relative(root, filePath).split(/[\\/]/g).join("/");
      declarations.push({ ...declaration, file: [pathPrefix, scoped].filter(Boolean).join("/"), source });
    }
  }
  return declarations;
}

/**
 * Scan one source string for module-scope declarations. Exported so tests can exercise the scanner
 * without touching the repo; pass comment-stripped code (see `codeWithoutComments`).
 */
export function scanSource(source) {
  const lines = source.split("\n");
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    const head = DECLARATION_HEAD.exec(lines[index]);
    if (!head) continue;
    // Read the whole statement so a multi-line type annotation cannot hide the initializer.
    const statement = statementFrom(lines, index);
    const initializer = initializerAfter(statement.text, head[1]);
    const kind = /^\s*new\s+(Map|Set)\b/.exec(initializer)?.[1];
    if (!kind) continue;
    found.push({ line: index + 1, name: head[1], kind, statement: statement.text });
  }
  return found;
}

/** Collect a statement's text from its head line until bracket depth closes and the line terminates. */
function statementFrom(lines, start) {
  let depth = 0;
  const collected = [];
  const limit = Math.min(lines.length, start + 12);
  for (let index = start; index < limit; index++) {
    const line = lines[index];
    collected.push(line);
    for (const character of line) {
      if (character === "(" || character === "{" || character === "[") depth++;
      else if (character === ")" || character === "}" || character === "]") depth--;
    }
    const terminated = /;\s*$/.test(line) || /[)\]}]\s*$/.test(line) || /^[A-Za-z_$][\w$]*\s*=\s*new\s+(Map|Set)\b/.test(line);
    if (depth <= 0 && index > start - 1 && terminated) break;
  }
  return { text: collected.join("\n"), end: collected.length - 1 };
}

/** The text following the first top-level `=` after `name`, used to test what the initializer is. */
function initializerAfter(statementText, name) {
  const nameAt = statementText.indexOf(name);
  if (nameAt < 0) return "";
  let depth = 0;
  for (let index = nameAt + name.length; index < statementText.length; index++) {
    const character = statementText[index];
    if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth--;
    else if (character === "=" && depth === 0 && statementText[index + 1] !== "=" && statementText[index - 1] !== "=") {
      return statementText.slice(index + 1);
    }
  }
  return "";
}

/** Balanced-parentheses payload of the first call expression at or after `from`. */
function callArguments(text, from) {
  const open = text.indexOf("(", from);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/** Every registration call's argument text in a file, with the census `id` it declares. */
function registrationsIn(source) {
  const registrations = [];
  REGISTRATION_SEAMS.lastIndex = 0;
  let match;
  while ((match = REGISTRATION_SEAMS.exec(source))) {
    const args = callArguments(source, match.index + match[0].length - 1);
    // A registration body is bounded by its own balanced parentheses; a 12k-char payload is a bug,
    // not a cache, and the balance scan already proved the argument closes.
    // Either quote style is accepted: the census ids are the same strings either way, and refusing a
    // correctly-spelled single-quoted id would only mean an unregistered cache reads as unclassified.
    const id = /\bid:\s*["']([^"']+)["']/.exec(args)?.[1] ?? null;
    const ceilingConstant = /\bceilingConstant:\s*["']([^"']+)["']/.exec(args)?.[1] ?? null;
    registrations.push({ id, ceilingConstant, args, seam: match[1] });
  }
  return registrations;
}

/**
 * Does a registration reference this declaration? Accepted forms are all things the compiler also
 * treats as a use of the binding: `map: <name>` (the window/registry helpers), `<name>.field` (a
 * probe reading it), `of|in <name>` (a probe iterating it), and the symbol passed as an argument.
 * A bare identifier mention that is none of those is NOT accepted, so a mention in a comment or a
 * doc string inside the registration body cannot launder an unregistered cache.
 */
function registrationFor(registrations, name) {
  const structural = new RegExp(
    `(?:\\bmap:\\s*${name}\\b|\\b${name}\\s*[.(\\[]|\\b(?:of|in)\\s+${name}\\b|[(_,]\\s*${name}\\s*[,)])`,
  );
  return registrations.find((registration) => structural.test(registration.args)) ?? null;
}

/** Mutation site probe: `name.set(`, `name.add(`, `name.delete(`, `name.clear(`. */
function mutationSites(source, name, methods) {
  return new RegExp(`\\b${name}\\s*\\.\\s*(${methods})\\s*\\(`).test(source);
}

/**
 * Per-declaration expiry evidence — the input to rule (3).
 *
 * Evidence is limited to what the compiler can also see: a write site or read of the symbol that
 * sits on the same line as expiry vocabulary, or a value type declared in the same file whose body
 * carries an expiry field. File-level vocabulary is deliberately NOT evidence: `file-service.ts`
 * mentions `mtime` for unrelated stat bookkeeping, and a file-level rule would force its static
 * `MARKDOWN_SCAN_EXCLUDED_DIRS` table into a cache classification it does not deserve — a check
 * that cries wolf gets widened until it means nothing.
 */
export function expiryEvidence({ source, name, kind, statement }) {
  const lines = source.split("\n");
  const reasons = [];
  const mentions = new RegExp(`\\b${name}\\b`);
  for (const line of lines) {
    if (mentions.test(line) && EXPIRY_VOCAB.test(line)) {
      const field = EXPIRY_VOCAB.exec(line)[1];
      reasons.push(`${name} appears on the same line as expiry field \`${field}\``);
    }
  }
  const declaration = statement ?? source;
  if (promiseWrappedTypeArguments(kind).test(declaration)) return reasons;
  // Value-type indirection: `new Map<string, CacheEntry>()` where CacheEntry carries `expiresAt`.
  const typeArguments = new RegExp(`new\\s+${kind}\\s*<([^>]*)>`).exec(declaration);
  for (const typeName of (typeArguments?.[1] ?? "").split(/[,<]/).map((part) => part.trim())) {
    if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) continue;
    const body = typeBody(source, typeName);
    if (body && EXPIRY_VOCAB.test(body)) {
      reasons.push(`value type \`${typeName}\` declares an expiry field`);
    }
  }
  return [...new Set(reasons)];
}

/*
FNXC:RetentionCensus 2026-09-23-09:40 (RUFU-257):
An in-flight lease map (`Map<string, Promise<CacheEntry>>`) does not accumulate cached payloads —
its entries die when the operation settles, and `owner-deleted` is only accepted when a real
`delete` site for the symbol exists in the file. So a `Promise<T>` value type never transfers `T`'s
expiry vocabulary to the map: the promise describes an operation in flight, while the expiry field
on `T` describes the payload that map will never hold. Direct-line evidence is unchanged, so a real
traffic cache cannot escape rule (3) through this seam.
*/
function promiseWrappedTypeArguments(kind) {
  return new RegExp(`new\\s+${kind}\\s*<[^>]*\\bPromise\\s*<`, "");
}

/** Body of a same-file `interface X {…}` / `type X = {…}` declaration. */
function typeBody(source, typeName) {
  const pattern = new RegExp(`(?:interface|type)\\s+${typeName}\\b[^{]*\\{`);
  const match = pattern.exec(source);
  if (!match) return null;
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(match.index + match[0].length, index);
    }
  }
  return null;
}

/**
 * A literal-only collection initializer: every entry is a literal or a module-literal constant.
 *
 * An EMPTY initializer (`new Set<string>()`) deliberately reports `literal: false`. Empty means
 * "built at runtime", which is the opposite of a table: treating it as a fixed-key table would let
 * the ratchet's most dangerous shape — a fresh traffic-keyed set that gains entries through a helper
 * (`warnOnce(set, key, …)`) rather than a visible `NAME.add(` — classify itself as exempt.
 */
function literalCollectionArgument(initializer) {
  const at = initializer.search(/\bnew\s+(Map|Set)\b/);
  if (at < 0) return null;
  const args = callArguments(initializer, at);
  if (args.trim() === "") return { entries: 0, literal: false };
  if (/[`$][{]|=>|\.\.\.|\bnew\s|[[A-Za-z_$][\w$]*\s*\(/.test(args)) return { entries: 0, literal: false };
  const entries = args.split(",").filter((part) => part.trim() !== "").length;
  return { entries, literal: true };
}

/**
 * True when the symbol is handed to a function as a plain argument. Such a collection can be mutated
 * through that parameter, which no `NAME.add(` scan can see, so its exemption must be a written
 * justification rather than an inference.
 */
function passedAsArgument(source, name) {
  return new RegExp(`[(,]\\s*${name}\\s*[,)]`).test(source);
}

/** Marker search window: the declaration line plus the 6 lines above it. */
function markerFor(lines, lineIndex, statementText) {
  const candidates = [...lines.slice(Math.max(0, lineIndex - 6), lineIndex + 1), ...trailingComments(statementText)];
  for (const candidate of candidates) {
    const comment = /\/\/\s*(retention-[a-z-]+:)(.*)$/.exec(candidate.trim());
    if (!comment) continue;
    const marker = MARKERS.find((entry) => entry.flag === comment[1]);
    if (!marker) continue;
    return { kind: marker.kind, class: marker.class, argument: comment[2].trim(), flag: marker.flag };
  }
  return null;
}

/** Trailing `//` comments inside a multi-line statement, so a marker may sit on the closing line. */
function trailingComments(statementText) {
  return statementText.split("\n").filter((line) => line.includes("//"));
}

/**
 * Classify one declaration. Returns the inventory entry; `classification === "unclassified"` is a
 * finding, never a silent pass, and `reasons` explains what the author must supply.
 */
export function classifyDeclaration({ file, line, name, kind, source }) {
  const rawLines = source.split("\n");
  const rawStatement = statementTextAt(source, line);
  /*
  FNXC:RetentionCensus 2026-09-23-10:55 (RUFU-257):
  Structural proofs are substring tests, so they run against comment-stripped code: a commented-out
  `registerRetentionSource({ map: cache })`, a `// tokens.delete(x)` note, or a prose mention of a ceiling
  name beside the marker must not satisfy a premise. Comment stripping keeps line count, so `line` and
  `statement` stay aligned with the raw file; markers are read from the raw lines because they are
  comments on purpose.
  */
  const code = codeWithoutComments(source);
  const registrations = registrationsIn(code);
  const registration = registrationFor(registrations, name);
  const statement = statementTextAt(code, line);
  const marker = markerFor(rawLines, line - 1, rawStatement);
  const expiry = expiryEvidence({ source: code, name, kind, statement });

  const entry = {
    file,
    line,
    name,
    kind,
    classification: CLASS_UNCLASSIFIED,
    sources: [],
    ceilingConstant: null,
    justification: null,
    expiryEvidence: expiry,
    reasons: [],
  };

  if (marker && !marker.argument) {
    entry.reasons.push(`marker ${marker.flag} carries no justification (rule 5)`);
    return entry;
  }

  if (registration) {
    entry.classification = CLASS_CENSUS_REGISTERED;
    entry.sources = [registration.id].filter(Boolean);
    entry.ceilingConstant = registration.ceilingConstant;
    entry.justification = `${registration.seam}(${registration.id ?? "?"}) references \`${name}\``;
    return entry;
  }

  if (marker) {
    if (marker.class === CLASS_BOUNDED) {
      const ceiling = marker.argument;
      if (!new RegExp(`\\b(?:const|let|var)\\s+${ceiling}\\b\\s*(?::[^=]*)?=\\s*\\d`).test(code)) {
        entry.reasons.push(`retention-bounded names \`${ceiling}\` but no numeric constant of that name is declared in ${file}`);
        return entry;
      }
      if (!new RegExp(`${ceiling}\\b(?!\\s*(?::[^=]*)?=\\s*\\d)`).test(code)) {
        entry.reasons.push(`ceiling constant \`${ceiling}\` is declared but never read in ${file}`);
        return entry;
      }
      entry.classification = CLASS_BOUNDED;
      entry.ceilingConstant = ceiling;
      entry.justification = `count ceiling \`${ceiling}\` declared in ${file}`;
      return entry;
    }
    if (marker.class === CLASS_OWNER_DELETED) {
      if (!mutationSites(code, name, "delete")) {
        entry.reasons.push("retention-owner-deleted claims a deletion owner but the file has no `delete` site for this symbol");
        return entry;
      }
      entry.classification = CLASS_OWNER_DELETED;
      entry.justification = marker.argument;
      return entry;
    }
    entry.classification = marker.class;
    entry.justification = marker.argument;
    return entry;
  }

  const literal = literalCollectionArgument(initializerAfter(statement, name) ?? "");
  if (literal?.literal && literal.entries > 0 && !passedAsArgument(code, name) && !mutationSites(code, name, "add|set|delete|clear")) {
    entry.classification = CLASS_FIXED_KEY_SET;
    entry.justification = `literal ${kind} initializer with ${literal.entries} fixed entries and no mutation site in ${file}`;
    return entry;
  }

  entry.reasons.push(
    `no classification: register it in the retention census, bound it with a named ceiling, or add a` +
      ` \`// retention-owner-deleted: …\` / \`// retention-config-keyed: …\` / \`// retention-allowlist: …\` marker`,
  );
  return entry;
}

/** Re-read a statement's text from the original source by 1-based head line. */
function statementTextAt(source, line) {
  const lines = source.split("\n");
  return statementFrom(lines, line - 1).text;
}

/** Classify every scanned declaration in one pass. */
export function classifyDeclarations(declarations) {
  return declarations.map((declaration) => classifyDeclaration(declaration));
}

/**
 * The rules that make the inventory a control instead of a snapshot.
 *
 * @param {{ entries: any[], scannedCount: number }} input
 * @returns {string[]} human-readable violations (empty when the ratchet holds)
 */
export function evaluateEntries({ entries, scannedCount }) {
  const violations = [];

  for (const entry of entries.filter((candidate) => candidate.classification === CLASS_UNCLASSIFIED)) {
    violations.push(`${entry.file}:${entry.line} ${entry.name}: ${entry.reasons.join("; ")}`);
  }

  // Rule (3): expiry evidence bars every "nothing accumulates here" class.
  for (const entry of entries) {
    if (entry.expiryEvidence?.length && entry.classification !== CLASS_CENSUS_REGISTERED && entry.classification !== CLASS_BOUNDED) {
      violations.push(
        `${entry.file}:${entry.line} ${entry.name}: classified ${entry.classification} but ${entry.expiryEvidence[0]} (rule 3: an` +
          ` expiry-carrying cache must be census-registered or bounded, never a table/registry claim)`,
      );
    }
  }

  // Rule (4): a census-registered entry must still resolve to a registration in the file.
  for (const entry of entries.filter((candidate) => candidate.classification === CLASS_CENSUS_REGISTERED)) {
    if (!entry.sources.length) {
      violations.push(`${entry.file}:${entry.line} ${entry.name}: census-registered with no \`id:\` in its registration`);
    }
  }
  const registeredNames = new Set(entries.filter((entry) => entry.classification === CLASS_CENSUS_REGISTERED).map((entry) => `${entry.file}#${entry.name}`));
  for (const id of entries.filter((entry) => entry.classification === CLASS_CENSUS_REGISTERED).flatMap((entry) => entry.sources)) {
    const owners = entries.filter((entry) => entry.sources?.includes(id));
    if (owners.length > 1 && owners.some((owner) => owner.file !== owners[0].file)) {
      violations.push(`census source id "${id}" is claimed by ${owners.length} declarations in different files`);
    }
  }
  if (registeredNames.size === 0) violations.push("no census-registered declarations: the census has no coverage to ratchet");

  // Rule (6): non-vacuity floors.
  if (scannedCount < MIN_SCANNED_DECLARATIONS) {
    violations.push(
      `subject set collapsed: ${scannedCount} module-scope Map/Set declarations scanned, floor is ${MIN_SCANNED_DECLARATIONS}` +
        ` — a scanner or scan root that stopped matching declarations is a silent off switch`,
    );
  }
  if (registeredNames.size < MIN_CENSUS_REGISTERED) {
    violations.push(
      `census coverage floor: ${registeredNames.size} census-registered declarations, floor is ${MIN_CENSUS_REGISTERED}` +
        ` — RUFU-257 established attribution; a drop means registrations were removed, not that the code got cleaner`,
    );
  }
  const rule3Subjects = entries.filter((entry) => entry.expiryEvidence?.length);
  if (rule3Subjects.length === 0) {
    violations.push("rule (3) subject set is empty: no declaration carries expiry evidence, so the anti-laundering rule proves nothing");
  }

  return [...new Set(violations)];
}

/** Compare a freshly derived scan against the checked-in inventory (rule 1). */
export function diffInventory({ entries, inventory }) {
  const violations = [];
  const keyOf = (entry) => `${entry.file}#${entry.name}`;
  const expected = new Map(inventory.map((entry) => [keyOf(entry), entry]));
  const actual = new Map(entries.map((entry) => [keyOf(entry), entry]));

  for (const [key, entry] of actual) {
    const recorded = expected.get(key);
    if (!recorded) {
      violations.push(`${entry.file}:${entry.line} ${entry.name}: not in the inventory — run \`node scripts/check-retention-coverage.mjs --write\``);
      continue;
    }
    if (recorded.classification !== entry.classification) {
      violations.push(`${entry.file} ${entry.name}: inventory says ${recorded.classification}, the code now says ${entry.classification} — re-run --write`);
    } else if (JSON.stringify(recorded.sources ?? []) !== JSON.stringify(entry.sources ?? [])) {
      violations.push(`${entry.file} ${entry.name}: census source ids changed (${recorded.sources} -> ${entry.sources}) — re-run --write`);
    } else if ((recorded.ceilingConstant ?? null) !== (entry.ceilingConstant ?? null)) {
      violations.push(`${entry.file} ${entry.name}: ceiling constant changed (${recorded.ceilingConstant} -> ${entry.ceilingConstant}) — re-run --write`);
    } else if (recorded.justification !== entry.justification) {
      violations.push(`${entry.file} ${entry.name}: justification changed — re-run --write`);
    }
  }
  for (const [key, recorded] of expected) {
    if (!actual.has(key)) {
      violations.push(`${recorded.file} ${recorded.name}: inventory entry has no matching declaration — re-run --write (a retired cache` +
        ` must be removed from the inventory, never left as a claim about code that no longer exists)`);
    }
  }
  return violations;
}

/** Render the generated inventory module. */
export function renderInventory(entries, { scanRootLabel }) {
  const rows = entries
    .map((entry) => ({
      file: entry.file,
      name: entry.name,
      kind: entry.kind,
      classification: entry.classification,
      sources: entry.sources ?? [],
      ceilingConstant: entry.ceilingConstant ?? null,
      justification: entry.justification ?? null,
      expiryEvidence: entry.expiryEvidence ?? [],
    }))
    .sort((left, right) => `${left.file}#${left.name}`.localeCompare(`${right.file}#${right.name}`));

  return `// GENERATED FILE — do not edit by hand.
// Regenerate: node scripts/check-retention-coverage.mjs --write
// Check:      node scripts/check-retention-coverage.mjs
/*
FNXC:RetentionCensus 2026-09-23-09:05 (RUFU-257):
The subject set of the retention-coverage ratchet, derived from source structure by
scripts/check-retention-coverage.mjs: every module-scope \`new Map\`/\`new Set\` in ${scanRootLabel}.
One entry per declaration, keyed by file + declaration name, classified census-registered / bounded /
owner-deleted / config-keyed-registry / fixed-key-set. This file is diff-reviewable on purpose: the
classification of a new module-scope cache must appear in a PR diff, and it cannot be narrowed by
hand because \`--write\` regenerates it from the scan.
*/

export const RETENTION_INVENTORY_SCHEMA = 1;

/** Declarations whose classification the scanner could not derive. Always empty in a green tree. */
export const RETENTION_INVENTORY = ${JSON.stringify(rows, null, 2)};

export default RETENTION_INVENTORY;
`;
}

export function readInventory(inventoryPath) {
  if (!existsSync(inventoryPath)) return null;
  // The inventory is an ES module so TypeScript-free Node and vitest can both import it; reading it
  // through import() keeps the parser honest instead of re-implementing JS here.
  return import(pathToFileURL(resolve(inventoryPath)).href).then((module) => module.RETENTION_INVENTORY);
}

export function listTypeScriptFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        found.push(path);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/**
 * @param {{ argv?: string[], scanRoot?: string, inventoryPath?: string }} options
 * @returns {Promise<number>} process exit code
 */
export async function main({ argv = process.argv.slice(2), scanRoot, inventoryPath } = {}) {
  const write = argv.includes("--write");
  const root = scanRoot ?? process.env.FUSION_RETENTION_SCAN_ROOT ?? DEFAULT_SCAN_ROOT;
  const inventory = inventoryPath ?? process.env.FUSION_RETENTION_INVENTORY_PATH ?? DEFAULT_INVENTORY;

  const declarations = scanModuleScopeCollections({ root, pathPrefix: relative(REPO_ROOT, root) || "" });
  const entries = classifyDeclarations(declarations);
  const violations = evaluateEntries({ entries, scannedCount: declarations.length });

  if (write) {
    const relativeRoot = relative(REPO_ROOT, root) || "packages/dashboard/src";
    writeFileSync(inventory, renderInventory(entries, { scanRootLabel: relativeRoot }), "utf8");
    const unclassified = entries.filter((entry) => entry.classification === CLASS_UNCLASSIFIED).length;
    console.log(
      `retention inventory written: ${entries.length} declarations` +
        ` (${entries.filter((entry) => entry.classification === CLASS_CENSUS_REGISTERED).length} census-registered,` +
        ` ${unclassified} unclassified) -> ${relative(REPO_ROOT, inventory)}`,
    );
    for (const violation of violations) console.error(`  ${violation}`);
    return unclassified > 0 ? 1 : 0;
  }

  const recorded = await readInventory(inventory);
  if (!recorded) {
    console.error(`retention inventory missing at ${relative(REPO_ROOT, inventory)} — run \`node scripts/check-retention-coverage.mjs --write\``);
    return 1;
  }
  violations.push(...diffInventory({ entries, inventory: recorded }));

  if (violations.length > 0) {
    console.error(
      `\nRUFU-257 retention coverage ratchet: ${violations.length} violation(s) across ${declarations.length} module-scope Map/Set declarations.\n` +
        `Every module-scope collection must name how it stops growing: register it with\n` +
        `registerRetentionSource/registerBoundedWindowMap/registerBoundedRegistryMap, bound it with a named\n` +
        `ceiling constant, or state its cardinality owner with a \`// retention-*:\` marker.\n`,
    );
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      `\nAfter fixing the code, refresh the generated inventory:\n  node scripts/check-retention-coverage.mjs --write`,
    );
    return 1;
  }

  const censusCount = entries.filter((entry) => entry.classification === CLASS_CENSUS_REGISTERED).length;
  console.log(
    `retention coverage OK: ${entries.length} module-scope Map/Set declarations classified` +
      ` (${censusCount} census-registered, ${entries.filter((entry) => entry.classification === CLASS_BOUNDED).length} bounded,` +
      ` ${entries.filter((entry) => entry.expiryEvidence?.length).length} carrying expiry evidence)`,
  );
  for (const pendingRoot of PENDING_SCAN_ROOTS) {
    const pending = classifyDeclarations(
      scanModuleScopeCollections({ root: join(REPO_ROOT, pendingRoot), pathPrefix: pendingRoot }),
    );
    const unclassified = pending.filter((entry) => entry.classification === CLASS_UNCLASSIFIED).length;
    console.log(
      `  pending root ${pendingRoot}: ${pending.length} module-scope declarations, ${unclassified} still unclassified` +
        ` (not yet gated — RUFU-257 classified the crashing process first)`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
