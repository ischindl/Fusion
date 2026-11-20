---
"@runfusion/fusion": minor
---

summary: New Telegram bridge plugin sends agent questions to per-project topics and resumes cards from an answer.
category: feature
dev: Bundles `fusion-plugin-telegram` (settings: botToken, chatId, groupingMode, eventFilter, allowedChatIds, ingestSecret). Point the generic webhook at `POST /api/plugins/fusion-plugin-telegram/fusion?key=<ingestSecret>`; the generic payload now also carries `project: { id }` so a receiver can route per project. Bridge state lives in five `telegram_*` Postgres tables and stores only `sha256(botToken)`.
