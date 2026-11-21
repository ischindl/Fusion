---
"@runfusion/fusion": patch
---

summary: A spec note like "not a dependency" no longer blocks a card behind the card it mentions.
category: fix
dev: The `## Dependencies` projection is one shared decision (`projectDependencyBindingsFromPromptText`) that separates waited-for ids from denied ones; the planning finalizer can also retire a false edge already on the row, computed from the live row under the task lock. No TaskStore signature changed.
