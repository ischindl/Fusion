# Telegram Bridge Plugin

Async Telegram channel for a Fusion instance. Agent questions and card events leave the dashboard and land in
Telegram; an operator answers by pressing a button or replying, and that answer is written to the card as a
steering comment which resumes the parked card. One bot serves the whole instance, and each project gets its
own Telegram topic so projects are never mixed in one thread.

The Bot API is called with global `fetch`. There is no new runtime dependency: no `grammy`, no `telegraf`, no
`axios`.

## Setup

1. **Create the bot** with `@BotFather` → `/newbot`. Copy the HTTP API token.
2. **Turn off privacy mode** with `/setprivacy` → `Disable`, otherwise the bot cannot read replies to its own
   messages in a group.
3. **Enable topics.** In `@BotFather` → `Bot Settings` → `Topics` turn topics on. Topics work **in a private
   chat with the bot** (Bot API 9.3/9.4), which is the mode with the least setup. If you rather use a group,
   add the bot as admin with `Manage Topics` (`can_manage_topics`) and it will create one topic per project
   there.
4. **Find your `chatId`.** Send `/start` to the bot, then read it once from the update stream:
   `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"`. Read `message.chat.id`. A private chat id is a
   positive number; a group or supergroup id is negative. Do this while the plugin is not polling (leave the
   settings empty first), because one token has exactly one `getUpdates` consumer.
5. Enable/install the plugin, then open **Settings → Plugins → Fusion Plugins → Telegram Bridge** and fill in
   `botToken`, `chatId`, `ingestSecret`, and pick at least one `eventFilter` value.
6. Point Fusion's notifications at the bridge: **Settings → Notifications**, `webhookFormat: generic`, and
   `webhookUrl` = `http://<your-dashboard>/api/plugins/fusion-plugin-telegram/fusion?key=<ingestSecret>`.
   Without this step nothing arrives: the plugin receives events, it does not subscribe to the engine.
7. Check `GET /api/plugins/fusion-plugin-telegram/fusion`'s companion `GET .../status`. It says whether the
   bot token, chat id, and shared secret are all present, and why the inbound poller is or is not running.

## Settings

| Key | Meaning when empty / default |
| --- | --- |
| `botToken` | Empty means the bridge is unconfigured: no sends, no polling. Never printed, never returned by a route, and only its SHA-256 is stored. |
| `chatId` | Target chat (or forum supergroup). Empty means the inbound poller never starts. |
| `groupingMode` | `privateTopics` (default) creates one forum topic per project in your private chat with the bot; `forumTopic` does the same inside a group; `flat` sends to one chat with a `[project/CARD]` prefix for clients without topics. |
| `hubProjectId` | The project whose settings receive the webhook. Other projects are resolved through it; if unset, the plugin's own project is assumed. |
| `dashboardBaseUrl` | When set, messages carry a deep link to the card. When empty, no link is added. |
| `eventFilter` | **Empty means deliver nothing.** Choose any of `planning-awaiting-input`, `awaiting-approval`, `awaiting-user-review`, `cli-agent-awaiting-input`, `task-wedged`, `failed`, `message:agent-to-user`. |
| `allowedChatIds` | **Empty means nobody.** An inbound answer from a chat not listed here is refused before any database read. Accepts a list or a comma/newline separated string. |
| `ingestSecret` | Shared secret for the ingest route. Without it the route fails closed and answers 503 rather than accepting anonymous events. |
| `throttleMsPerChat` | Minimum spacing between two sends to one chat, default `1100` ms, enforced by a per-chat queue. Telegram answers HTTP 429 above roughly one message per second per chat. |
| `dedupeRetentionDays` | How long inbound update ids are kept for replay protection, default `7` days. Pruned while claiming a new update. |

## Routes

- `POST /api/plugins/fusion-plugin-telegram/fusion` — the generic-webhook sink. This path is exempt from
  dashboard bearer auth, so the shared secret in `?key=` is the only thing authenticating it. The secret is
  compared in constant time. Exempting this path also exempts paths below it, so no further unauthenticated
  route may ever be added under `.../fusion-plugin-telegram/fusion`.
- `GET /api/plugins/fusion-plugin-telegram/status` — normal authenticated dashboard route. Reports readiness,
  topic mode, inbound counters, sends currently queued per-chat, and why polling stopped. The bot token and the
  ingest secret are never in the body; the token is described by length only.

## Storage and lifecycle

Starts on `onLoad`, stops on `onUnload`. Five Postgres tables, all owned by this plugin:

- `telegram_project_topics` — `projectId → message_thread_id` (topic bindings, card-facing).
- `telegram_questions` — the correlation row that makes an answer attributable: `(chat_id, bot_message_id)` →
  `(projectId, taskId, questionId, kind, options)`, with `status` open/answered/superseded and a partial unique
  index that keeps at most one OPEN question per card.
- `telegram_processed_updates` — replay guard for `update_id`.
- `telegram_inbound_state` — the durable `getUpdates` offset, so a restart does not re-read 24 h of buffer.
- `telegram_token_lease` — one long-poll holder per bot token, keyed by `sha256(botToken)`. The token itself is
  never stored (see `docs/secrets.md`).

Card-facing rows are keyed by the **owning** project; poller-facing rows are instance-level, because one bot
has exactly one update stream.

## Behaviour worth knowing before you rely on it

- **The dashboard stays the authority.** If the card is no longer parked, the answer is not applied: the
  buttons are removed and Telegram is told it was already answered.
- **Answering in the dashboard does not mute the card.** The dashboard path never tells Telegram, so the
  question row stays open until the card's NEXT park replaces it. The park's own `@<epoch>` watermark in
  `pausedReason` says which park a row belongs to: a row created before the current watermark is superseded,
  atomically with the new question's row, and the old message's buttons go away with the new send. A reply to
  that superseded message therefore cannot answer the current park with the previous question's options.
- **Sends to one chat are queued, not fired.** Every send passes through one queue per chat, spaced by
  `throttleMsPerChat`, so a burst of parked cards arrives as a burst of messages at a legal rate instead of
  HTTP 429. A 429 is retried once after the `retry_after` Telegram names; a longer backoff, or a chat queue
  past its ceiling, is refused loudly rather than silently dropped. `/status` reports how many sends are
  waiting their turn.
- **A card parked for another reason is left alone.** Only a park carrying the await-input marker is answered;
  an approval park keeps its own approval surface.
- **An answer is applied once.** The question row is claimed atomically; if the store write then fails, the
  claim is handed back so the operator can retry.
- **`pausedReason` is never cleared by the plugin.** The await-input node consumes the steering comment and
  clears its own marker.
- **The first poll after an install drains the backlog without processing it.** Those messages were not sent by
  this instance and cannot be correlated, so only the offset advances.
- **A lost token lease stops polling** instead of continuing blind, and a non-allowlisted chat is refused before
  any read.
- `callback_data` carries `q:<opaqueId>:<optionIndex>` and stays under Telegram's 64-byte limit; it never
  carries JSON, the question text, or a task id.

## Limitations (deliberate)

No media or files, no Mini App buttons, no streamed answers, no per-operator isolation, and no sidecar host.
Bot-per-project is out by design: one token has one `getUpdates` stream.
