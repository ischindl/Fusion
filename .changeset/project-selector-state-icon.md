---
"@runfusion/fusion": minor
---

summary: The project combo now shows each project's state by colour and icon: green running, yellow paused, red off.
category: feature
dev: Indicator derives from `runtimeState` (falling back to `runtimeEnabled`); `runtimeState: "unknown"` renders a neutral dimmed glyph, never red or green. Presentation only — selection and the runtime turn-on affordance are unchanged.
