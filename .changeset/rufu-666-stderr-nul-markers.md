---
"@runfusion/fusion": patch
---

summary: CLI stderr no longer carries hidden NUL severity markers, so grep, pipes, and JSON tools see plain text.
category: fix
dev: The `\u0000fnlvl=<level>\u0000` markers from the core/engine loggers are emitted only while a dashboard TUI console capture is installed or `FUSION_LOG_SEVERITY_MARKERS=1`/`true` is set; boot-smoke now fails if `fn --help`, `fn init`, or `fn serve` stderr carries any NUL byte.
