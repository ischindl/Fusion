---
"@runfusion/fusion": patch
---

summary: An open chat tab now shows "working..." when a generation starts elsewhere (another tab, an API call, an auto-retry) instead of staying silent until reload.
category: fix
dev: `chat:session:updated` bus payloads carry the derived `isGenerating` flag (store rows only had `inFlightGeneration`), and useChat derives the flag client-side as a wire-compat fallback before triggering the existing attach path.
