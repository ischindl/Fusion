---
"@runfusion/fusion": patch
---

summary: Open chat tabs now show "working..." when a generation starts in another tab, an API call, or an auto-retry.
category: fix
dev: `chat:session:updated` bus payloads carry the derived `isGenerating` flag (store rows only had `inFlightGeneration`), and useChat derives the flag client-side as a wire-compat fallback before triggering the existing attach path.
