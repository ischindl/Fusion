# Board boot request set

What the dashboard's board route is allowed to ask the server for, and how each rule is enforced. Every
rule below is stated as a **request-set shape** — paths, counts, query parameters — because that is what a
test can assert without becoming a flake. No test in this contract measures milliseconds; the timings quoted
here are evidence for why a rule exists, never the thing that is asserted.

Test harness: `packages/dashboard/app/__tests__/board-boot-request-set.test.tsx`. It mounts the boot-path
consumers the board route composes (`UsageIndicator` closed, the `useBoardWorkflows` consumers, the
`useAgents` chrome consumer, off-screen `TaskCard`s) against a recording `globalThis.fetch` and asserts
`GET` paths, counts, and PARSED query strings. `App.tsx` itself is a single component of several thousand
lines and is not rendered here; because a harness can only ever be evidence about itself, one case in that
file reads the `App.tsx` SOURCE and asserts the production call site carries the gate the harness mirrors.
That is a code-construct guard, and it is what stops the contract from being pinned to a component that no
longer matches what ships.

## The measured problem

From a production boot profile (613 task rows, one project):

| Read | Measured |
| --- | --- |
| `GET /tasks/board-workflows` (unbounded) | 30.0 s, then 17.4 s on the next mount — 60.6 s of a 351.5 s boot |
| `GET /tasks/board-workflows` asked for 1 card, answered for 241 | 14.2 s |
| `GET /tasks/board-workflows` payload (slim enumeration) | 10.8 MB |
| `GET /api/usage` | on the critical path of a cold mount that never showed the Usage surface |
| `GET /api/agents/stats` | on the same cold path, for a banner behind a settings flag |
| `GET /api/missions/:id` | once per card, per mount, for cards that were never scrolled into view |
| `GET /tasks/:id/diff` | on a raw interval per active card, including while the tab was hidden |

## Contract

### 1. `/api/usage` is not on a cold board mount

The Usage surface is a popover behind a Header icon. Its read must appear when the operator opens it and
must not appear because the board mounted.

- One dispatcher owns the read (`useUsageData`). The Header indicator and the popover share it, so opening
  the surface cannot produce two reads.
- A completed answer is kept as a snapshot for five minutes. Opening the popover again, focusing the window,
  or a remount reuses it; the popover's explicit refresh button bypasses it.
- A refresh paints over the previous numbers instead of clearing them, so a slow provider cannot blank the
  icon while it is in flight.

Asserted: zero usage paths after a cold mount; exactly one after opening the surface.

### 2. Background chrome waits for an observable board state, not a timer

Agent capacity statistics and per-card labels are chrome: they are not what an operator came to look at.

- `useAgents` takes an `enabled` gate, and `App`'s own boot-path call passes BOTH clauses of it:
  `boardChromeReady && capacityRiskBannerEnabled === true`. `boardChromeReady` is `useBoardChromeReady` over
  `useTasks`' `lastFetchTimeMs` — the state the board publishes when its rows have an as-of clock, not a
  deferred callback. `requestIdleCallback` and `setTimeout` are explicitly not the mechanism: a board that is
  still waiting for its first page is not idle, and a timer cannot tell those two situations apart.
- The second clause is the one that decides a default deployment: `capacityRiskBannerEnabled` is `false` in
  `DEFAULT_PROJECT_SETTINGS`, and the agent stats exist on the board route ONLY to feed that dismissible
  banner. A disabled banner therefore issues no agent read at all, before settings hydrate as much as after.
- Per-card reads (mission labels, assignee names) are gated on the card's own IntersectionObserver result,
  and cards that share a mission share one in-flight read rather than one per card.

Asserted: zero `/api/agents/stats` and zero `/api/missions/*` on a cold mount; each gate clause pinned apart
(banner on with the board unanswered: nothing; board answered with the banner off: nothing); the reads do
arrive once both clauses hold; four visible cards on one mission produce one mission read; and the gate is
present in `App.tsx`, not only in the harness.

### 3. `board-workflows` spends at most one unbounded read per project per mount

The route answers three different questions and each caller now names which one it wants:

| Request | Server work |
| --- | --- |
| no parameters | full enumeration: current tasks, the newest Done page, every selection row |
| `?scope=lanes` | the workflow catalog only; `taskWorkflowIds` is empty; zero task-table reads |
| `?taskIds=a,b&partial=1` | a selection read scoped to those ids; zero task-table reads |

- `scope=lanes` is legal only without `taskIds`. Naming ids is a request for a mapping, so a caller that
  sends both gets the mapping.
- A zero-id scope skips the batched selection read entirely rather than paying a ceremonial `IN ()`
  round-trip.
- Consumers: the Header workflow switcher declares `scope: "lanes"` (it renders lane definitions and reads
  no card mapping); Board and List name the ids they render for mapping-only refreshes.

**The mount read stays unbounded on purpose.** A patch answer MERGES into the held payload, and a merge
cannot express "this lane no longer exists" or "the default workflow moved" — scoping the mount to ids
reproduced exactly that: the switcher kept announcing a workflow the current payload no longer contained.
So the vocabulary read is whole-board and only the refreshes that re-map cards (tab focus, visibility, the
unmapped-card repair) name ids. That is why the acceptance reads "at most ONE unbounded read per project per
mount" rather than none: before any answer exists, no id list can describe the board.

Partial merge is a pure union, deliberately. The server only answers cards that have a selection row, so a
card it omits already inherits the default; deleting named-but-unanswered ids would strip the mapping from
every card a partial caller did not name, which is the same shrinkage that kept the named-id path asking the
server for the whole board. Workflow deletion is the one event that really removes mappings in bulk, and it
arrives on the `workflow:*` stream, whose refresh is unbounded and replaces the payload.

A patch that has nothing to merge into is never published as if it were whole. The per-project cache is the
one place the card-to-lane mapping lives, and a `scope=lanes` answer carries `taskWorkflowIds: {}` by
contract, so writing it over that key emptied the mapping for every other consumer of the project — and the
switcher's lanes read races the board's mount read, so the losing order left the next hydrating mount
painting every card on the default lane. A patch is written only over the payload it merged with; a consumer
holding nothing keeps its vocabulary in its own state, where a lane list cannot masquerade as a mapping.

Query construction is part of the contract, not an implementation detail. Every parameter is appended after
one separator and joined by `&`, and the assertions read `URLSearchParams`, never a substring of the URL: an
earlier cut emitted `?projectId=X?scope=lanes`, which parses as a project named `X?scope=lanes` with no
scope at all, so the cheap branch never ran and the project lookup failed — while a substring check on
`scope=lanes` called that request bounded and kept the suite green.

Asserted: at most one request whose parsed parameters carry neither `taskIds` nor `scope=lanes` per project
across every mounted consumer; the lanes-only consumer's request carries `scope=lanes`, its own `projectId`,
and no `taskIds`; a tab-focus refresh carries `taskIds` and `partial=1`; every parameter combination is
pinned to exactly one query separator and to a `projectId` that is not a composite; the server tests assert
`listTasks`, `listCompletedTasks`, and `getTaskWorkflowSelectionsAsync` are not called at all for
`scope=lanes`, including in the production shape that also carries `projectId`.

### 4. The per-card diff poll is bound to the viewport and the visible tab

`useTaskDiffStats` is the board's per-card "changed files" badge. It now arms through
`useVisibilityAwarePoll` (see `docs/dashboard-realtime.md`-adjacent notes in
`app/hooks/visibilitySuspension.ts`) rather than its own `setInterval`:

- hidden document: the interval is torn down, not skipped, so the page holds no armed timer;
- hidden to visible: exactly one cache-bypassing refresh per card, through the shared deterministic
  stagger, before re-arming — so ~25 cards do not simultaneously hit the 6-connections-per-origin cap;
- a card whose observer reports it off-screen, or a search-result row, is `enabled: false` and issues no
  request at any cadence.

Asserted in `app/hooks/__tests__/useTaskDiffStats.poll.test.ts` as request counts under fake timers: one at
mount, zero however long the document stays hidden, exactly one on the visible edge, polling continues while
visible, zero while the card is not shown.

## Reading the rules as one sentence

A cold board mount asks for its own data and nothing else; every other read is triggered by an observable
state — a surface opened, a board that answered, a card that became visible, a tab that came back — and the
one read that must be whole-board is whole-board exactly once.
