---
"@runfusion/fusion": patch
---

summary: The desktop Chat button honours your saved popup-or-full-page choice again.
category: fix
dev: The bottom-bar Chat entry routes through the launch-mode launcher that reads `fusion:chat-launch-mode` instead of opening the conversation popover unconditionally; the anchored popover is unchanged when no mode is stored.
