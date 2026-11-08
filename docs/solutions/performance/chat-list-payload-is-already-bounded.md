---
title: Chat sessions list payload is already bounded — do not re-attempt the cliSessionFile / preview trim
date: 2026-11-08
component: packages/dashboard/src/routes/register-chat-routes.ts, packages/core/src/async-stores/async-chat-store.ts, packages/dashboard/app/components/ChatView.tsx
category: performance
module: chat
tags: [chat, list-payload, preview-truncation, cli-session-file, terminal-attach, null-result, measure-first]
problem_type: performance
severity: low
applies_when:
  - "A byte-share table over `GET /api/chat/sessions` suggests dropping `cliSessionFile` or capping `lastMessagePreview`"
  - "Someone proposes porting the `compactBoardFeedRow` description-cap pattern onto the chat session list"
  - "A chat performance slice is being scoped and the sessions list is on the candidate list"
---

## What this records

A null result, recorded so the same two changes are not re-attempted from a byte-share table.
Both halves of a proposed "slice B" for RUFU-871 were disproved by reading the code paths.
**Neither change ships.**

Measured shape of one real `GET /api/chat/sessions` response: **22 411 B for 31 rows**, of which
`cliSessionFile` was measured at 29 % and `lastMessagePreview` at 27 %. That share is real. It is
also not the offender: the same production session's `GET /api/chat/sessions/<id>/messages` answered
**326 556 B for 13 messages**, which is what RUFU-871 actually fixed (bounded 20-row window plus
load-older — see `packages/dashboard/app/hooks/useChat.ts` `CHAT_THREAD_WINDOW`). A ~6,5 kB trim on
a 22 kB response that already carries no message bodies is inside the noise of one engine heartbeat.

## Finding 1 — `lastMessagePreview` is already capped below any proposed cap

The preview is truncated in SQL, before it is ever a JS string:

- `packages/core/src/async-stores/async-chat-store.ts:564` — `left(last_msg.content, 101) AS "content"`
  in `buildLastMessageForSessionsSql` (line 554), feeding `getLastMessageForSessions`.
- `packages/core/src/async-stores/async-chat-store.ts:1075` — `left(matching_msg.content, 101)`
  for `matchedMessagePreview` (content search), deliberately mirroring the same bound.

The route then re-caps at the same boundary:
`packages/dashboard/src/routes/register-chat-routes.ts:620-623`
`content.length > 100 ? content.slice(0, 100) + "…" : content` — so the wire value is at most 101 characters.

Consequence: a ~120-character cap **cannot fire**. It drops zero bytes, and its companion
`previewTruncated` boolean can never be `true`. That is dead code with a test attached to it.

The `compactBoardFeedRow` analogy (`packages/core/src/task-store/reads.ts:1624`, which caps task
`description` at 400 with `descriptionTruncated`) does not transfer: board `description` is
unbounded inline text, while chat previews are already bounded at the storage layer. A cap belongs
where the unbounded value is; here there is none.

## Finding 2 — `cliSessionFile` is load-bearing from the LIST row

`cliSessionFile` is not a file path here despite its name. It carries the native CLI session id:
`packages/dashboard/src/cli-chat.ts:165` `const resumeNative = chat.cliSessionFile; // native session id persisted on the chat`
and `packages/dashboard/src/cli-chat.ts:277-279` persists it from the telemetry event. The client
type says the same thing: `packages/dashboard/app/hooks/useChat.ts:109-110` — "Native CLI session id
linkage (used as the terminal attach id for resume)."

The full consumer chain, every hop:

1. `packages/dashboard/app/hooks/useChat.ts:1514` —
   `const session = sessionOverride ?? sessions.find((s) => s.id === id);` then
   `setActiveSession(session || null)` at :1515. `sessions` are **list rows**, so `activeSession` is
   a bare list row from the click until `fetchChatSession` resolves — and permanently on that
   request's failure and malformed-`isGenerating` exits.
2. `packages/dashboard/app/components/ChatView.tsx:3099-3100` — `cliChatActive` keys off
   `activeSession.cliExecutorAdapterId`, which is ALSO a list field, so the CLI surface really does
   mount during that window.
3. `packages/dashboard/app/components/ChatView.tsx:3177` —
   `const cliTerminalSessionId = activeSession?.cliSessionFile || activeSession?.id || "";`
4. `packages/dashboard/app/components/ChatView.tsx:4589` → `CliChatSurface` →
   `packages/dashboard/app/components/CliChatSurface.tsx:70`/`:106` →
   `<SessionTerminal sessionId={cliSessionId} ...>`.
5. `packages/dashboard/app/components/SessionTerminal.tsx:472` —
   `POST /api/cli-sessions/<sessionId>/attach-ticket`, then the WS at :706.
6. `packages/dashboard/src/routes/cli-sessions.ts:92-93` —
   `const session = store.getSession(paramId(req.params.id)); if (!session) throw notFound("Session not found");`

**Failure mode if the field is dropped from the list:** the client falls back to
`activeSession.id`, which is a *chat* session id. `store.getSession` is the CLI-session store and
does not resolve a chat id, so the ticket request returns **404 Session not found** and the CLI
transcript/terminal surface cannot attach. The authoritative single-session GET
(`register-chat-routes.ts:752-761`) does return the field and would restore it, but the gap opens on
every selection and never closes on the GET's failure paths.

## If someone still wants the full ~6,5 kB

Do this FIRST, as its own task, not inside a performance slice: make the CLI surface's attach id
come only from the authoritative single-session snapshot — i.e. gate the `<CliChatSurface>` mount
(or at minimum the `cliTerminalSessionId` read) on the authoritative selection refresh having
landed. `useChat.ts` already tracks that refresh (`authoritativeSelectionRefreshRef`, and the
`awaitingAuthoritativeSnapshot` guard at :3186).

This is a **behavior change on every CLI-backed chat** — it moves when the transcript/raw-terminal
toggle and composer mount — so it needs its own spec, its own tests, and a decision about what the
user sees during the round trip. Shipping it as a byte trim is how a perf slice turns into a
terminal that 404s.
