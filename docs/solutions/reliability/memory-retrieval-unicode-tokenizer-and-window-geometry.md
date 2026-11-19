---
category: reliability
module: memory
tags: [memory, retrieval, tokenizer, unicode, i18n, snippets, qmd]
problem_type: correctness
applies_when: Changing how a memory query is tokenised, scored, windowed, or reported empty
---

# Memory retrieval shredded diacritic queries and returned overlapping windows (RUFU-1012)

## Symptom

An operator writing in Slovak got useless or misleading results from `fn_memory_search` on a
project whose memory was full of relevant prose:

- A query whose subject word was the point — `pamäte`, `operatívna`, `zlucovanie`, `systémové` —
  matched the **wrong** blocks, or returned `NONE` while the matching memory sat on disk.
- The snippets that did come back repeated themselves. The reported pair was
  `.fusion/memory/2026-09-03.md:97-108` next to `:105-116`: two windows, four shared lines,
  two of five slots.
- An empty answer was indistinguishable from an empty store, so the agent stopped searching.

None of it was a ranking bug. It was two independent deterministic defects plus a missing signal.

## Root cause

Three facts, each correct in isolation and wrong together:

1. **The tokenizer was ASCII-only.**
   `query.toLowerCase().split(/[^a-z0-9_-]+/i)` (agent lane, `packages/engine/src/agent-tools.ts`)
   and the same shape in `searchMemoryFiles` (`packages/core/src/memory/memory-backend.ts`) treat
   every accented letter as a separator, so one Slovak word becomes several Latin fragments plus
   nothing:

   | query | ASCII split (before) | Unicode split (after) |
   |---|---|---|
   | `zlucovanie dlhodobej pamäte` | `zlucovanie, dlhodobej, pam, te` | `zlucovanie, dlhodobej, pamäte` |
   | `pamätaj systémove pravidlo` | `pam, taj, syst, move, pravidlo` | `pamätaj, systémove, pravidlo` |
   | `Ktorá časť file scope je operatívna` | `ktor, as, file, scope, je, operat, vna` | `ktorá, časť, file, scope, je, operatívna` |
   | `Post-merge verification gate` | unchanged | unchanged |
   | `PG-gated test harness recipe` | unchanged | unchanged |

2. **Relevance was a substring test.** `normalized.includes(term)` over those fragments meant
   `syst` scored against the English word `system`, `te` against `route`, `delete`, `template`,
   `latest`. One point cleared the `score > 0` door, so a fragment worth nothing decided the result.

   The two together are why an English query was *not* affected: ASCII input survives the ASCII
   split, and English terms are rarely substrings of unrelated words. The defect was invisible to
   every test written in English, which is exactly why it shipped.

3. **The window geometry overlapped by construction.** The snippet walk ran
   `index += 8` while slicing 12 lines, so every adjacent pair shared four lines. Measured on a
   42-line file before the fix: windows starting at 1, 9, 17, 25, 33, 41, pairwise overlapping,
   plus a 2-line tail window. The same arithmetic sat in **both** packages, independently.

   Separately, the `qmd` lanes returned windows authored by an external binary. Fixing the stride
   cannot help there — those ranges are not ours to choose, so they have to be filtered.

## Fix

One shared helper, `packages/core/src/memory/memory-query-terms.ts`, exported from `@fusion/core`
(and mirrored into `index.gate.ts`, which is what the engine-core merge gate aliases
`@fusion/core` to):

- `MEMORY_QUERY_TOKEN_BOUNDARY` = `/[^\p{L}\p{N}_-]+/u`, `MEMORY_QUERY_MIN_TERM_LENGTH = 2`
- `MEMORY_SNIPPET_WINDOW_LINES = MEMORY_SNIPPET_STRIDE_LINES = 12` — stride equals width, so the
  walk **tiles** the file
- `deriveMemoryQueryTerms(query)` — NFC, lowercase, split, min length, dedupe keeping first
- `countMemoryTermMatches(text, terms)` — tokenizes the candidate with the same boundary and
  compares by set membership; one point per distinct term, never per substring
- `dropLineOverlappingMemoryHits(hits)` — per-path line-range overlap filter, keeps the first
  accepted window, never compares ranges across different paths

Consumers:

| lane | change |
|---|---|
| agent memory (`searchAgentMemoryFile`) | word-level score, tiled windows |
| agent memory `qmd` branch | overlap guard applied **before** the limit |
| project memory (`searchMemoryFiles`) | same helper, same geometry |
| project memory `qmd` backend | overlap guard on the external ranges |
| lane P recall keywords (`deriveRecallKeywords`) | same boundary; its 3-char floor, stopwords, length-descending rank and 3-term/24-char/64-char caps are untouched, so `per-turn-recall.test.ts` stays green unmodified |
| `fn_memory_search` | `details.emptyReason` + `details.termCount` |

`deriveFocusQueryTokens` (lane T) already had a Unicode boundary; its private literal is now the
shared constant, so the module has one word rule instead of two that happen to agree.

## The empty answer became three answers

`NONE` reported one fact for three states, and the two that matter most look identical to the
caller. `RUFU-994` had already met the same shape from the other side: a Stash 401 was reported as
`NONE` and read as "memory is empty" while capture kept succeeding.

```
details.emptyReason: "no-query-terms" | "no-memory-content" | "no-token-match"
details.termCount:   number
text:                "NONE (<code>) — <one-line remedy>"
```

The order of evaluation is the contract, because it is what keeps each claim provable:

1. `no-query-terms` is decided from the **query** alone.
2. `no-memory-content` is decided from the **corpus** (`hasProjectMemoryContent` plus the agent
   lane's own files), never from an empty result set.
3. only then may the tool say `no-token-match`.

An inventory that cannot be read answers "content may exist", so the tool never asserts an empty
store it did not actually read.

## Deliberately unchanged

`RUFU-665` owns memory-retrieval score ordering and result budgets (its Step 6 is a follow-up card
that removes the `+1000` cross-scope offset). This card is upstream of it, so all of the following
are byte-identical, and the card that removes the offset must not find it already moved:

- the `+ 1000` offset and `Number(result.score ?? 1) + 1000`
- the final merge `[...agentResults, ...projectResults].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)`
- the `score > 0` relevance door, `limit` clamps, the 1200-char snippet cap, the window **width**
- the `+1000`-separated `agent-memory` / `qmd-agent-memory` backend labels

Two tempting changes were rejected as scope creep that would have *reduced* recall: raising
`MEMORY_QUERY_MIN_TERM_LENGTH` from 2 to 3 (it would drop genuine two-letter words in other
languages — e.g. Polish `my` "we", and the Ukrainian negation particle cited here by description
rather than by letter, per the Latin-script text rule — and would also break an operator who
deliberately searches a `pam` prefix), and widening the 12-line window.

## Reproduce it

```bash
# the symptom suite (16 cases) — run it on an unmodified tree to see the 7 reds
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/agent-memory-tokenizer-window.test.ts --silent=passed-only --reporter=dot
# the shared helper (21 cases) and the project lane (12 cases) + lane P keywords (5 cases)
pnpm --filter @fusion/core exec vitest run \
  src/memory/__tests__/memory-query-terms.test.ts \
  src/memory/__tests__/memory-files-window.test.ts \
  src/memory/__tests__/recall-keywords-unicode.test.ts --silent=passed-only --reporter=dot
# the no-regression witness, which must stay untouched
pnpm --filter @fusion/core exec vitest run src/__tests__/per-turn-recall.test.ts
```

The symptom suite drives the real `fn_memory_search` seam over a temp directory with
`memoryBackendType: "file"`, so no `qmd` binary, subprocess, or network is involved. Its positive
controls — `post-merge`/`file-scope` still matching, a whole Slovak word still matching, the limit
still bounding — are what stop a "fix" that would silence Slovak retrieval altogether.

## Generalize

- **An ASCII character class is a language policy.** Any regex that claims to split "words" and is
  written as `[a-z0-9]` silently decides that only English is supported, and the decision is invisible
  to every test written in English. Use `\p{L}` with the `u` flag, and write at least one test in the
  language the operator actually uses.
- **A substring relevance test over fragments is a scoring bug, not a ranking bug.** If tokens can
  be fragments, `includes()` will find them inside unrelated words. Fix the tokenizer *and* the
  matcher; either one alone still returns junk.
- **Same arithmetic in two packages is the same bug twice.** The 8-over-12 stride existed in core and
  engine independently. Shared geometry belongs in one constant.
- **An empty collection is an ambiguous answer.** Where an empty result can mean "nothing exists",
  "nothing was asked", or "nothing matched", say which — and derive the "nothing exists" claim from
  the store, never from the emptiness you are explaining.
