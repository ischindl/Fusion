---
"@runfusion/fusion": patch
---

Close cached CLI extension TaskStore instances on session shutdown so task-tool runs do not leave SQLite handles behind.
