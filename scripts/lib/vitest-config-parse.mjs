/*
FNXC:TestQuarantine 2026-09-08-11:02 (RUFU-197):
These Vitest-config scanners used to live inline in `check-quarantine-ledger.mjs`. The engine
merge-gate policy test now needs the same string-aware reads, and it also needs to distinguish a
TEST-level `exclude:` array from a `coverage.exclude` array, which the literal-only scanner never had
to do. This module is the single owner of both reads so the quarantine lockstep guard and the
gate-policy guard cannot drift apart. Functions moved verbatim; their original requirements notes are
preserved below.
*/

/*
FNXC:QuarantineLockstep 2026-08-23-22:45:
STRING-AWARE. The previous regex stripper treated the `/**` inside a glob literal such as
"src/**\/*.slow.test.ts" or "node_modules/**" as the start of a block comment, so it deleted from
there to the next "*\/" — swallowing whole array literals and the entries after them. A concrete
quarantine exclude placed after any such glob was then invisible, and this guard reported
`missing-exclude` for a file that WAS excluded (observed 2026-08-23 quarantining
self-healing-pending-wedge-notification.test.ts). Scan character by character instead, tracking
string literals, so comment markers inside strings are left alone.
*/
export function stripComments(source) {
  let out = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      out += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      if (end === -1) break;
      index = end - 1;
      continue;
    }
    out += character;
  }
  return out;
}

export function extractBalancedArray(source, openingBracket) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openingBracket; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(openingBracket, index + 1);
    }
  }
  return null;
}

export function extractConcreteTestFiles(arrayText) {
  const files = [];
  const strings = /"((?:\\.|[^"\\])*)"/g;
  let stringMatch;
  while ((stringMatch = strings.exec(arrayText))) {
    const value = JSON.parse(`"${stringMatch[1]}"`);
    if (/\.test\.tsx?$/.test(value) && !/[*?{}]/.test(value)) files.push(value);
  }
  return files;
}

/*
FNXC:QuarantineLedgerConstArray 2026-08-23-00:27:
RUFU-157: the four package vitest configs (cli, core, dashboard, desktop) quarantine flaky files through the
documented const-array shape — `const quarantined<Package>Tests: string[] = [...]` — spread into `test.exclude`
through a filtered identifier (e.g. the CLI's `activeQuarantinedCliTests` requested-file filter), so the concrete
path appears in no inline `exclude:` literal and the literal-only scanner reported a false `missing-exclude`
for the RUFU-128 bin.test.ts quarantine. The concrete-exclude scan therefore also reads `const <name>: string[] = [...]`
declarations: a const-array entry satisfies `missing-exclude`, and a stale const-array entry surfaces as
`dangling-exclude` through the same existsSync direction.
Superset semantics with a documented masking trade-off: any concrete `.test.ts`/`.test.tsx` path in ANY typed
`string[]` const array of a config counts as an exclude, including a path that actually lives only in an unrelated
`string[]` array in that config. The trade-off is bounded by the concrete test-file filter (no `*?{}` glob
characters, path must end in `.test.ts`/`.test.tsx`) and is pinned by fixtures. Conservative scope: only
`const <name>: string[] = [` declarations are scanned — untyped const arrays, `let`/`var` declarations, and
`readonly string[]`/ReadonlyArray shapes are intentionally out of scope. Concrete paths are deduplicated across
inline `exclude:` literals and const-array declarations so a path double-covered (dashboard's `coverage.exclude`
no-op plus its const array) verifies exactly once.
*/
export function extractConcreteExcludes(source) {
  const commentFree = stripComments(source);
  const excludes = new Set();
  const collect = (array) => {
    for (const file of extractConcreteTestFiles(array)) excludes.add(file);
  };

  const excludePattern = /\bexclude\s*:/g;
  let match;
  while ((match = excludePattern.exec(commentFree))) {
    let index = match.index + match[0].length;
    while (/\s/.test(commentFree[index] ?? "")) index += 1;
    if (commentFree[index] !== "[") continue;
    const array = extractBalancedArray(commentFree, index);
    if (array == null) continue;
    collect(array);
    excludePattern.lastIndex = index + array.length;
  }

  const constArrayPattern = /\bconst\s+[A-Za-z_$][\w$]*\s*:\s*string\[\]\s*=\s*\[/g;
  while ((match = constArrayPattern.exec(commentFree))) {
    const openingBracket = match.index + match[0].length - 1;
    const array = extractBalancedArray(commentFree, openingBracket);
    if (array == null) {
      constArrayPattern.lastIndex = openingBracket + 1;
      continue;
    }
    collect(array);
    constArrayPattern.lastIndex = openingBracket + array.length;
  }
  return [...excludes];
}

/*
Returns the index AFTER the closing quote of the string starting at `start` (start points at the quote).
Escapes are honoured; an unterminated string consumes the remainder.
*/
function skipString(source, start) {
  const quote = source[start];
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  return source.length;
}

/*
Returns { key, parentKey, char, openIndex } for every `{`/`[`/`(` open: `key` is the object key that
introduced the container and `parentKey` is the key of the container enclosing it. Comment-free input is
required (callers strip first). Strings are skipped so glob/brace characters inside literals never affect
the walk.
*/
export function scanOpens(commentFree) {
  const stack = [];
  const opens = [];
  let pendingKey = null;
  let ident = "";
  for (let index = 0; index < commentFree.length; index += 1) {
    const character = commentFree[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(commentFree, index) - 1;
      ident = "";
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      ident += character;
      continue;
    }
    if (character === ":" && ident) {
      pendingKey = ident;
      ident = "";
      continue;
    }
    ident = "";
    if (character === "{" || character === "[" || character === "(") {
      const parentKey = stack.length ? stack[stack.length - 1].key : null;
      opens.push({ key: pendingKey, parentKey, char: character, openIndex: index });
      stack.push({ key: pendingKey, char: character });
      pendingKey = null;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      if (stack.length) stack.pop();
      pendingKey = null;
    }
  }
  return opens;
}

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
The old PG-canary guard grabbed the FIRST `exclude:` in the core config. After the 2026-09-06 ratchet the
core config has no TEST-level `exclude:` key at all — only `coverage.exclude` remains — so "first match"
silently read the coverage globs. A concrete canary path could later be hidden by an added test-level
`exclude:` placed AFTER `coverage:`, and the first-match reader would never see it. This scanner is
key-aware: it collects a concrete test file only when its `exclude:` array is the direct value of a `test`
key (top-level `test.exclude` or a per-project `test.exclude`), or when it lives in a typed
`const <name>: string[] = [...]` that the test-level `exclude:` references. `coverage.exclude` is never a
test-level exclude and cannot hide a canary, so it is excluded from this read by construction.
*/
export function extractTestExcludeEntries(configSource) {
  const commentFree = stripComments(configSource);
  const opens = scanOpens(commentFree);
  const excludes = new Set();
  const constArrays = collectTypedConstArrays(commentFree);

  for (const open of opens) {
    if (open.char !== "[" || open.key !== "exclude" || open.parentKey !== "test") continue;
    const arrayText = extractBalancedArray(commentFree, open.openIndex);
    if (arrayText == null) continue;
    for (const file of extractConcreteTestFiles(arrayText)) excludes.add(file);
    // A test-level exclude may reference typed const arrays instead of (or in addition to) literals.
    // Identifiers are matched against the array with its string literals removed, so a path that merely
    // spells a const's name can never pull that const's entries in.
    const referencedText = withoutStringLiterals(arrayText);
    for (const [name, files] of constArrays) {
      if (new RegExp(`\\b${name}\\b`).test(referencedText)) {
        for (const file of files) excludes.add(file);
      }
    }
  }
  return [...excludes];
}

/*
FNXC:MergeGatePolicy 2026-09-08-11:02 (RUFU-197):
engine-core membership is an explicit allow-list inside a Vitest `projects` entry. Read the named project's
own `include:` array (comment-free, so the FNXC prose naming retired files cannot be mistaken for entries)
and return its concrete test files. "First `include:` after the quoted project name" is well-defined: each
project object introduces its own `include:` before any sibling project, and the array's bracket is balanced,
so a later project's include can never bleed into this one.
*/
export function extractTestProjectInclude(configSource, projectName) {
  const commentFree = stripComments(configSource);
  const nameIndex = indexOfQuotedValue(commentFree, projectName);
  if (nameIndex === -1) return [];
  const rest = commentFree.slice(nameIndex);
  const includeMatch = /\binclude\s*:\s*\[/.exec(rest);
  if (!includeMatch) return [];
  const openingBracket = nameIndex + includeMatch.index + includeMatch[0].length - 1;
  const arrayText = extractBalancedArray(commentFree, openingBracket);
  if (arrayText == null) return [];
  return extractConcreteTestFiles(arrayText);
}

function collectTypedConstArrays(commentFree) {
  const arrays = new Map();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*string\[\]\s*=\s*\[/g;
  let match;
  while ((match = pattern.exec(commentFree))) {
    const name = match[1];
    const openingBracket = match.index + match[0].length - 1;
    const arrayText = extractBalancedArray(commentFree, openingBracket);
    if (arrayText == null) {
      pattern.lastIndex = openingBracket + 1;
      continue;
    }
    arrays.set(name, extractConcreteTestFiles(arrayText));
    pattern.lastIndex = openingBracket + arrayText.length;
  }
  return arrays;
}

function indexOfQuotedValue(source, value) {
  return source.indexOf(`"${value}"`);
}

/*
Returns the input with every string literal body blanked to whitespace (quotes kept so offsets survive).
Used so identifier-reference scans never match inside a path literal.
*/
function withoutStringLiterals(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      const end = skipString(text, index);
      out += character + " ".repeat(Math.max(0, end - index - 2)) + (end - index > 1 ? text[end - 1] : "");
      index = end - 1;
      continue;
    }
    out += character;
  }
  return out;
}
