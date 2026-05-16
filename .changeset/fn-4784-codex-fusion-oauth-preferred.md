---
"@runfusion/fusion": patch
---

Codex usage stats now prefer the Fusion-stored `openai-codex` OAuth credential and only fall back to `~/.codex/auth.json` when no usable Fusion OAuth credential is available.
