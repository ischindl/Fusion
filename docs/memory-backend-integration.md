# Stash Memory Backend Integration

[← Docs index](./README.md)

Fusion persists AI "memory" — task-completion shots, chat-session transcripts, recall hits,
and per-conversation read focus — to a pluggable memory backend. The only memory backend
currently wired into Fusion is **Stash**, a session-oriented event store. This document is the
canonical operator guide for how Fusion talks to Stash, how it authenticates, how it isolates
projects, and how conversation memory is captured and focused.

There is intentionally **no** TencentDB backend in this build. The backend enum only ever
resolves `stash` (or the default `qmd` no-op); a TencentDB backend type, URL setting, or
integration doc does not exist.

<!-- FNXC:MemoryBackendIntegration 2026-10-12-03:46:
RUFU-461 arrived describing a `memctx_save` tool that kept rewriting one note file as a Stash/Fusion bug.
`memctx_save` is neither: it belongs to the third-party `weauratech/pi-memctx` pi extension, and Stash is an
event store with no note files at all. An operator debugging "a memory save rewrote my note" needs to know
which store they are in before reading code, so the boundary between Fusion's memory backends and third-party
pi memory plugins is documented as a section rather than left to be discovered. -->

---

## 1. The Stash server

Stash exposes a small HTTP REST API used by Fusion for both read and write of memory events.
All calls are scoped to the authenticated operator's own user id.

- **SEARCH (read):** `GET /api/v1/me/sessions/events/search?q=<query>&limit=<n>`
- **CAPTURE (write):** `POST /api/v1/me/sessions/events/batch`

The events sent to `/events/batch` must conform to a Stash event shape that requires a
top-level `event_type`, `agent_name`, and `session_id` per event; a missing required field is
rejected with HTTP `422`. Fusion sets `agent_name` (default `"fusion"`) and `session_id` on
every event it uploads, so transcripts render correctly in the Stash `/sessions/<sessionId>`
GUI.

## 2. Server URL and configuration

- **Setting key:** `memory.backendType` — the resolved backend type. Only `"stash"` triggers
  Stash capture/recall. Any other value (including the default `"qmd"`) is a no-op for both
  capture and read, and a non-Stash backend never reads secrets.
- **Setting key:** `memory.stashUrl` — the Stash server base URL. When empty, Fusion falls
  back to the default `http://127.0.0.1:3457` (a locally-hosted Stash daemon). The stored
  value is trimmed of trailing slashes.
- **Setting key:** `memory.stashApiKey` — an **optional per-project override** for the API
  key. It is **never committed to source**; it is a runtime setting an operator can provide
  when they do not want to (or cannot) use the global secrets store.

## 3. Authentication

Fusion authenticates to the Stash server with an API key resolved in this precedence order:

1. **Per-project override** `memory.stashApiKey` (settings) — wins if set.
2. **Global secrets store** key `stash-api-key` (scope `global`) — read via the secrets-store
   `revealSecret`. This is the recommended mechanism; the key lives outside the repo in the
   operator's secret store and is never committed.

**This precedence applies to reads and writes alike** (RUFU-994). `resolveStashMemorySettings` is the
single resolver and the read paths — keyword search, semantic search, `read()`, the `exists()`
reachability probe, per-turn recall, and the memory tools — run it before the backend is constructed,
exactly as capture does. That was not always true: every write resolved the secret while every read
went straight from raw settings into `resolveMemoryBackend`, so the transport's
`if (apiKey) headers["Authorization"] = ...` rule sent a credential on `POST /events/batch` and no
header at all on `GET /events/search`. The result was a server-side asymmetry with no Fusion-side
symptom — 8 320 writes answered `201` while 2 334 reads answered `401`, and every read surface
reported "no memories". If reads are refusing on a host where writes succeed, this is the asymmetry
to re-check first.

The API key is **never hardcoded** in Fusion source. Resolution degrades fail-closed: a
missing or undecryptable secret resolves to an empty key (an unauthenticated request), so
capture becomes a no-op rather than an error. Only a Stash backend ever reads secrets — a
non-Stash or memory-disabled project triggers no secret read at all.

### What a refused read reports

A failed read still degrades to `[]` / `""` / `false` — no memory read path throws at a caller, and
that contract is unchanged. What changed is that the cause is now recorded, so **"nothing was
stored" and "we were not allowed to look" are two different answers**. Each read attempt records one
outcome per endpoint (`keyword-search`, `semantic-search`, `read`, `exists`) from a closed set:

| Code | What it means for an operator |
| --- | --- |
| `ok` | The server answered and returned results. |
| `no-match` | The server answered and found nothing. This is the honest empty case, not a failure. |
| `key-unresolved` | Fusion sent **no** credential: no `stash-api-key` secret exists and no per-project override is set. Fix the configuration; Stash is refusing nothing it was given. |
| `refused-auth` | A credential was sent and Stash refused it (`401`/`403`). The key is wrong, revoked, or not granted on the read routers. |
| `refused-capability` | The route itself refuses (`404`/`405`/`501`/`503`) — an unpatched server or an unconfigured embedder. |
| `rejected-request` | The request was malformed to the server (`4xx` other than auth). |
| `unreachable` | No answer at all: connection refused, DNS failure, or timeout. |
| `malformed` | A 2xx whose body Fusion could not parse. |

Three surfaces carry it, none of which needs the container log:

- `GET /api/memory/backend` and `POST /api/memory/test` return `stashReadOutcome` — the last outcome
  code recorded for the configured server, or `null` when nothing has been read from it yet.
- `memory:stash-read-refused` run-audit rows count a standing refusal (see
  [`docs/run-audit.md`](run-audit.md) → A Stash read that was refused rather than empty).
- One `log.warn` per (server, code) per 15-minute window names the code and the endpoint class.

No key material, URL, response body, or server error text reaches any of the three.

**A scoped read that dropped rows is a different truth from a refused one, and is reported separately.**
The codes above answer "did we get to look at all"; a second closed class answers "what did we keep":
`all-own` (every row the server returned belongs to this project), `dropped-foreign` (a row proved to
belong to another Fusion project on this Stash account was crossed out), and `dropped-unidentified` (a
row carried no project identity at all, which includes a server that stopped returning `metadata` in its
search response). The last class is why a recall can be **empty while the memory is not**: Fusion does not
keep an unattributable row, so a backend that omits `metadata` yields a counted empty answer rather than
someone else's notes. Section 4 covers the match rule and where the counts surface.

`stashVectorSearch` (schema-only, no settings row) defaults to **`false`** and stays that way. When it
is on and the semantic endpoint refuses — for capability reasons or on auth grounds — Fusion suppresses
further semantic attempts for one cache window instead of burning the request on every turn, while the
keyword fallback keeps running every turn. A rotated or newly-installed key is therefore re-probed when
the window expires, not on the next turn; the keyword lane recovers immediately.

## 4. Per-project isolation

Memory events carry a **provenance discriminator** derived from the project root (e.g.
`fusion:<slug>`), and since RUFU-1008 that discriminator is also **the isolation mechanism** — enforced
by Fusion on the way in, not by Stash on the way out.

> Stash scopes its store by **owner user id** (`owner_user_id IN accessible_scope_ids_sql(1)`). It has
> no notion of a Fusion project. Two Fusion projects owned by different operators are therefore
> isolated; every Fusion project belonging to **one** operator shares a single read domain, and a
> search returns all of them.

What replaced the earlier claim that "Stash enforces isolation itself" is a client-side check at the one
place a Stash read enters Fusion — `scopeItemsToProject()` in `packages/core/src/memory/memory-backend-stash.ts`,
which both the keyword and the semantic branch pass through before anything is mapped, and which `read()`
inherits because `read()` is built on `search()`. A row is ours when **exact equality** holds:

- its `metadata.discriminator` equals the discriminator this project root derives, or
- its top-level `session_id` equals the id `write()` derives from this root.

No prefix, no substring, no normalisation, no case folding. A resemblance test is the defect: it would
admit a sibling project's row while looking like a guard. A row that cannot be attributed — including one
whose `metadata` exists but carries no discriminator — is dropped rather than kept, so recall from a
server that stopped returning `metadata` goes **empty** and stays empty. A counted empty answer is the
correct answer; widening the match to keep rows would be cross-project leakage wearing the name of a
fallback.

Two consequences an operator should know:

- **The scope filter is not a server parameter.** RUFU-121 measured the Stash search route to be inert to
  undeclared query parameters, and re-measured on 2026-11-19 (RUFU-1008 Step 0) that adding a session or
  folder id to the request changes nothing about what comes back. Fusion therefore sends **no** scope
  parameter: it would advertise an enforcement that does not exist. Filtering happens after the response.
- **Every drop is counted and reported.** Each read classifies its own answer as `all-own`,
  `dropped-foreign`, or `dropped-unidentified` and records the counts per **(Stash server, project)** —
  one dashboard process serves several projects, so a server-keyed counter would show one project's drops
  on another's page. `all-own` records nothing beyond the counters; a read that dropped rows emits
  `memory:stash-read-refused`'s sibling, [`memory:stash-read-scope`](run-audit.md#a-stash-read-that-dropped-another-projects-rows-rufu-1008),
  and surfaces its counts as `stashReadScope` on `GET /api/memory/backend` and `POST /api/memory/test`.
  Counts and a fixed class only: never a dropped line, another project's discriminator, or the server URL.

**Scoping after the answer costs rows, so the request buys a window (RUFU-1146).** Filtering on the far
side of a `limit`-sized request throws away rows that were never fetched, and on a shared account that
is most of them: measured over every scoped read on the host above (116 reads, `memory:stash-read-scope`),
Stash answered 839 rows, 261 survived (31 %), **33 reads (28 %) returned an empty page, and zero reads
returned the full limit they asked for** — the exact-limit request almost never reaches our own rows at
all. The keyword and vector branches now ask for `min(route ceiling, 6 × the caller's limit)`
(`stashReadFetchWindow`), scope, and trim to the caller's limit, so the page that comes back is the page
that was asked for and never wider. Three bounds keep that honest:

- the window never exceeds what the route itself validates — `le=200` on `/me/sessions/events/search`,
  `le=100` on the semantic route — because above either one "wider" is a 422, i.e. a worse read;
- at most **one** widening request per read, and only when the server filled the first window *and*
  fewer than `limit` rows survived scoping, so an exhausted store (the common case) costs nothing and a
  read is two calls, never a paging loop;
- if a deployed route refuses the wide window as a request (`400`/`422`), the exact-limit request is
  replayed and answered — the pre-fix shape — so shipping a wider window cannot produce less than it
  replaced.

`read()`'s broad recall and `exists()` keep the legacy empty-query URL byte-for-byte (RUFU-121 froze it,
and it is the shape the surviving `rejected-request` refusals attach to), so they are deliberately not
widened here. In the scoped row, `matchedCount` is now the rows the server answered **from that window**
while `limit` stays the page the caller asked for; `stash-read-window.test.ts` pins the arithmetic, the
single widening, the degrade, and the trim on every read surface.

## 5. Per-conversation memory focus (read-time ranking bias)

Fusion implements **conversation focus** as an opt-in feature. Enable
`experimentalFeatures.chatFocus` in **Settings → Experimental Features** to show its composer
control and bias its proactive recall; the flag is default off, and persisted focus values are inert
until it is enabled. The focus is persisted per chat session via the schema migration
**`0059_chat_session_memory_focus.sql`** (`SCHEMA_BASELINE_VERSION` = `0059`), which adds a
`memory_focus` column to the chat-session table.

At read time, the memory topic / focus (the text an operator or model optimizes a conversation
around) is a **ranking bias, never a filter** (RUFU-172). The proactive per-turn recall cue runs
two searches over the whole project: lane P (keywords derived from the current message/step) and,
when a focus is active, lane T (whose query is the focus's own content terms joined by `OR`,
so the keyword backend's normalization preserves each of them — RUFU-173). Lane T entries lead the cue and
may take at most 60% of its 800-char budget, so whole-project memory always keeps its share —
nothing is hidden. Clearing the focus (empty / `all` / `*`) restores the single-search cue byte for
byte. The stale claim that the focus is a "Stash search topic parameter" performing read-time
scoping is removed: RUFU-121 dropped the inert `&topic=` push-down (the Stash search route accepts
`q` + `limit` only) and no backend filters by topic; the tool-level `topic` option remains a
hint for topic-aware backends.

**Lane T query shape (RUFU-173).** The focus's content terms are extracted with a Unicode-aware
tokenizer (diacritic letters stay inside their word; a hyphen-joined word stays one term),
stopwords and tokens under 3 characters are dropped, terms dedupe case-insensitively in the
focus's own word order, and up to 3 terms (each ≤24 chars) are joined with a single uppercase
`" OR "` inside a 96-character joined budget — trailing terms are dropped whole, never truncated.
Why `OR`: with `stashVectorSearch` off (the deployed configuration) the keyword path runs
`normalizeStashSearchQuery`, which keeps **only the first word token** of a query unless a token
is literally `OR` — so RUFU-172's raw-phrase lane T collapsed a multi-word focus to one term in
exactly the configuration operators run. The backend's OR-preserving branch is the sanctioned
extension point: no Stash change and no change to RUFU-121's normalization contract. The joiner
survives that normalization because the server's non-ASCII strip runs *before* whitespace
collapse and token split, and `" OR "` is pure ASCII. The 96-char client budget sits inside the
server's 100-character token-boundary cap (which silently drops trailing terms), so every
term the client emits reaches the search. When no focus term survives (stopword-only focus),
lane T is **skipped entirely** — one search total — rather than sending an empty query, which
would hit the legacy broad-recall path and inject non-topical hits into lane T's lead slot. A
focus with a single usable token keeps the exact query string RUFU-172 sent, byte-identically.
Accepted consequence: one query string feeds both backend branches, so when `stashVectorSearch`
is enabled the semantic endpoint receives the OR-joined text including the literal `OR` tokens
(the ≥2-token vector gate is unregressed and diacritics still arrive intact). Residual
limitation, recorded not hidden: the server's non-ASCII strip does not transliterate, so a
diacritic term still arrives mangled (`pamäťové` → `pamov`); the OR join rescues the focus's
other surviving terms instead of collapsing the whole focus onto that one mangled term. True
diacritic keyword matching is the Stash-side deferred follow-up listed below.

> Note: `0049_chat_session_memory_focus.sql` is a clean-rebase-only artifact name and does **not**
> exist on this target. Origin's `0049` remains `0049_fn_8864_agent_activity_events.sql`. The
> memory-focus migration here is the new `0059_*.sql`, and no `0048_*.sql`–`0058_*.sql`
> migration was deleted or modified.

**Deferred follow-ups (tracked, deliberately not built):**

1. Mission-context executor focus — deriving an honest focus for the executor lane
   (RUFU-172 passes none; inventing one would fabricate bias).
2. Hard `metadata @> topic` filtering — index-backed corpus isolation; regresses recall today
   because no historical events carry topics (RUFU-172 non-goal).
3. Enabling `stashVectorSearch` — an operator config action, separate from any code change.
4. Stash-side raw-query passthrough / unaccent-aware keyword matching (`search_events`
   normalized-query-off or `unaccent`/`pg_trgm` matching) — the durable fix for diacritic
   keyword matching that RUFU-173 cannot deliver from this repo: the keyword normalizer strips
   non-ASCII characters without transliteration (`pamäťové` → `pamov`), so a diacritic focus
   term still cannot match its Slovak lexeme on the keyword path. RUFU-173's OR-joined lane T
   keeps every *surviving* focus lexeme as its own term instead of collapsing the focus onto
   one, but it does not restore diacritic matching. Crosses repositories and the RUFU-121
   normalization contract, so it stays a tracked follow-up rather than being silently dropped.

## 6. Complete-chat-session capture

Fusion captures **complete chat sessions** into Stash (not merely per-task completion shots).
A chat-store subscription turns the live conversation stream into per-message Stash memory
events:

- **Per-message events** — as each chat message is added, Fusion maps it to a capture event
  (`user_message` / `assistant_message` / `tool_use`, with `agent_name`, `content`, and
  `tool_name` for tool events) and progressively appends it to Stash. `session_id` is the
  **Fusion ChatSession id**, so the Stash `/sessions/<sessionId>` screen shows the full
  transcript.
- **Conversation-close flush** — when a session transitions to a final status (`archived`),
  any remaining buffered-but-not-yet-appended messages are flushed as a final batch. The final
  flush is **idempotent / dedup-safe**: already-appended per-message events are never re-emitted.

Capture is **best-effort / fail-closed / non-blocking**:

- A capture or secret-resolution failure never blocks or fails a chat or task completion.
- A disabled memory backend or a non-Stash backend makes capture a no-op.
- Captured content is written to the memory backend **only** — never to run-audit (run-audit
  rows carry ids/counts/outcomes only, per the FN-7158 rule).

### Per-task completion capture

In addition to chat transcripts, Fusion emits a `task_completion` memory event (session id
`fusion-task-<taskId>`) when a task completes, so a task's finishing state is recorded in the
operator's memory. Like chat capture, this is completion-gated (at most once per task),
best-effort, and non-blocking.

---

## 7. What is *not* a Fusion memory backend

A memory-shaped symptom in an operator's editor is not automatically Fusion's. Fusion's only wired
memory backend is Stash (§1), and Stash stores **events** (`event_type` / `agent_name` / `session_id`)
against a session — it has no note files, no note bodies, and no save tool an agent can call by name.

Third-party pi extensions can ship their own local memory store alongside Fusion. `weauratech/pi-memctx`
is one: it writes Markdown notes into a local *pack* (`00-system/`, `20-context/`, `40-actions/`,
`50-decisions/`, `60-observations/`, `70-runbooks/`) and exposes a `memctx_save` tool. When triaging a
report about a memory save, identify the writer first — the tool name and the response text decide which
codebase owns the bug:

| observation | owner |
| --- | --- |
| `POST /api/v1/me/sessions/events/batch` payload, `/sessions/<id>` GUI rows, HTTP `422` on a missing `event_type` | Fusion → Stash (this document) |
| a `memctx_save` call, an `Updated existing note: <rel>` response, `## Update (…)` blocks inside a `.md` note | the pi memory plugin, not Fusion and not Stash |

<!-- FNXC:MemoryBackendIntegration 2026-11-15-12:30:
RUFU-461's code review (finding F1) measured that this subsection had substituted the project notes store's cap for
the memory budget that card was about and had generalized that cap to every memory integration no matter which store
it wrote through. Two ceilings must stay named distinctly here. NOTE_CONTENT_MAX_LENGTH (1 MiB = 1,048,576 bytes) is a hard
refusal on writes to the notes table; RUFU-279's MEMORY_LONG_TERM_BYTE_BUDGET (32 KiB = 32,768 bytes) is measured
per long-term MEMORY.md and only reports and schedules consolidation, never refuses. They differ by a factor of 32
and in semantics, so no sentence may collapse them into one ceiling on "memory storage": RUFU-461's sibling pack
notes at 1,505,099 / 1,504,574 / 1,501,742 bytes each exceed 1,048,576 and none was ever refused, because a pack
file is not a notes-table row. A report of the shape "a memory save grew one file forever" is checked against the
32 KiB budget first -- RUFU-461's reported file at 444,550 bytes is 13.6x over that budget while sitting under the
notes cap, so the notes cap could not have flagged it. Worked examples cite measured bytes from the card's own
evidence, never a rounded figure with no source. -->

### Two size ceilings, in two stores, with opposite semantics

Fusion holds **two** size bounds, and they differ by a factor of 32 and in what happens when content
crosses them. Which one applies is decided by **which store the content is written through**, never by the
shape of the text being stored — one note-shaped body does not inherit the other store's limit.

**The project notes table refuses at 1 MiB.** `NOTE_CONTENT_MAX_LENGTH = 1024 * 1024` in
`packages/core/src/notes/note-types.ts` is enforced along the whole write path: the store raises
`RangeError("Note content is too large")` (`packages/core/src/async-stores/async-note-store.ts`), the HTTP
API answers `400` with `content must be a string up to 1 MiB`
(`packages/dashboard/src/notes-routes.ts`), and PostgreSQL holds the `CHECK` constraint
`notes_content_length` as `octet_length(content) <= 1048576`. The semantics are a hard refusal — the write
fails and nothing partial lands. This bound belongs to the **notes table**, so an integration meets it only
for content it actually writes through that store or its API.

**Fusion's own long-term memory is measured at 32 KiB and is never refused.**
`MEMORY_LONG_TERM_BYTE_BUDGET = 32 * 1024` in `packages/engine/src/memory/memory-budget.ts` is RUFU-279's
bound: UTF-8 bytes counted **per long-term memory file** — `.fusion/memory/MEMORY.md` (project scope) and
`.fusion/agent-memory/<agentId>/MEMORY.md` (one per durable agent), exactly the files
`discoverLongTermMemoryTargets` enumerates. It is measured in two places: the `fn_memory_append` write path
and the `reconcile-long-term-memory-budget` maintenance sweep. Crossing it produces **honest reporting plus
scheduled maintenance, never a refusal** — a memory tool that declined to record a lesson because its file
was large would lose the lesson permanently, while the crowding the budget guards against is only expensive.
The breach surfaces as `memory:long-term-over-budget`, `memory:long-term-consolidated`, and
`memory:long-term-consolidation-failed`, documented in
[Long-term memory budget maintenance](./run-audit.md#long-term-memory-budget-maintenance-rufu-279). The
budget is a code constant, not a settings knob, and a file above `MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES`
(8 MiB) is still reported but deliberately left unwritten, so one pathological file cannot make every
maintenance pass re-parse megabytes.

**Check the 32 KiB budget first for a growth report.** A report of the shape "a memory save grew one file
forever" is a growth question, and growth is what the memory budget measures; the 1 MiB cap guards a
different store and is relevant only when the content goes through the notes table. The arithmetic is the
proof: the file RUFU-461 reported, 444,550 bytes, is roughly 13.6× over the 32,768-byte budget while
remaining **under** the 1,048,576-byte notes cap — so the notes cap could not have flagged that file and
never did.

Both bounds share one consequence when a save path ignores them. A save path that rewrites an existing note
on every similar save grows one file without bound, and the memory system then fails **on the memory it is
supposed to protect** — a repeatedly-saved topic becomes the one thing that can no longer be saved, and
truncating the oversized body in response destroys the history it is storing. That is why a memory plugin
must be note-granular rather than append-oriented. The contract that keeps a pack healthy is enforced by the
**plugin's own save path**, not by either Fusion bound:

- **one memory is one new note** — a colliding filename gets a `-2`/`-3` name, never a merge;
- **similarity is reported, not merged** — the response names the closest existing note so linking stays
  deliberate;
- **an oversized new note is refused by the plugin**, with its byte size, and nothing partial is written —
  this is `memctx_save` declining its own write, not Fusion's notes store refusing;
- **an oversized note already on disk is an operator repair** — the plugin reports it and leaves the file
  byte-identical rather than hand-splitting, trimming, or growing it.

### RUFU-461 (worked example)

The reported symptom — `memctx_save` responding `Updated existing note:
60-observations/operator-waiver-validity-rules.md` while rewriting that one file, measured on 2026-10-01 at
**444,550 bytes over 5,486 lines** with 755 `## ` headings — was traced to `weauratech/pi-memctx@main`,
where save-target selection was a fuzzy term-overlap match (`findSimilarNote`) whose result was appended to
under `## Update (<timestamp>)`, and where every turn with several saves appended a further `## Related
learned memories` section to each note. Two unbounded writers, one file, one refusal.

Nothing on the Fusion or Stash side needed changing: the fix belongs to the upstream plugin, and it shipped
as a `git format-patch` artifact on card RUFU-461 (`git am` applies it; no push, fork, or PR was performed
from a Fusion task session). Fusion's own note store keeps its 1 MiB cap and its refusal semantics
unchanged, and they reach notes-table rows only. **Neither Fusion size bound governs the pack files on
disk**, and that card's own evidence proves it: the sibling notes in the same directory measured 1,505,099 /
1,504,574 / 1,501,742 bytes — each above the 1,048,576-byte notes cap, and none of them was ever refused,
because a pack file is not a notes-table row. The 32 KiB budget does not measure them either, since it is
defined per `.fusion/memory/MEMORY.md` and per `.fusion/agent-memory/<agentId>/MEMORY.md`. The budget is
still the bound that describes this failure *shape* — one memory file grown without bound by repeated saves
— so it is the first thing to check whenever the file in question is Fusion's own long-term memory, which is
where the same shape arrives as `memory:long-term-over-budget` instead of a silent success message. If an
integration needs to *split* content, splitting stays a deliberate, human-visible act on the pack — not
something the save path does silently to make a write fit.